import {
  CanvasTexture,
  Color,
  ExtrudeGeometry,
  Grabbed,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
  Shape,
  UIKit,
  UIKitMLAsset,
  type Entity,
} from '@iwsdk/core';
import { CARD_UNITS_H, CARD_UNITS_W } from './card-layout.js';
import { QuestCard } from './quest-component.js';
import { TIERS, tierForLevel, type TierDef, type TierId } from './tiers.js';
import { getProgress, onProgress } from './progress.js';
import { getSettings, onSettings } from './settings.js';

/*
 * What makes a pinned card read as part of the surface: a soft contact shadow
 * on the surface right under it, a thin paper edge, and a matte face. A
 * floating card keeps its look plus a gentle drop shadow behind it. Decor
 * lives as children of the card panel (card units, scaled with the card).
 */

const PAPER_M = 0.0016; // paper thickness in metres
/** The card face as drawn (UIKit panel): full width, ~91% of the hitbox height, rounded corners. */
const FACE_W = CARD_UNITS_W * 0.99;
const FACE_H = CARD_UNITS_H * 0.9;
const FACE_R = 0.22;

/**
 * PR 10: the paper edge is now the card's frame: a rounded slab a little
 * larger than the face (a ~4.5% rim shows around it), in the user's tier
 * metal. One mesh per card as before, shared geometry and shared materials
 * (one per tier), so a frame costs no extra draw call: it replaces the
 * floating card's faint drop shadow and is the pinned card's paper edge.
 */
const FRAME_RIM = 1.045;
let paperGeo: ExtrudeGeometry | undefined;
/** A rounded slab the size of the card face plus its rim, 1 unit deep (scaled to the paper thickness). */
function paperGeometry(): ExtrudeGeometry {
  if (paperGeo !== undefined) return paperGeo;
  const w = (FACE_W / 2) * FRAME_RIM;
  const h = (FACE_H / 2) * (1 + (FRAME_RIM - 1) * (FACE_W / FACE_H));
  const r = FACE_R * FRAME_RIM;
  const shape = new Shape();
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r);
  shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h);
  shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r);
  shape.quadraticCurveTo(-w, -h, -w + r, -h);
  paperGeo = new ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 4 });
  paperGeo.translate(0, 0, -0.5); // centred on z like the old box
  return paperGeo;
}

let shadowTexture: CanvasTexture | undefined;
function getShadowTexture(): CanvasTexture {
  if (shadowTexture !== undefined) return shadowTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    // A rounded rect blurred into a soft contact shadow.
    ctx.filter = 'blur(7px)';
    ctx.fillStyle = 'rgba(0,0,0,1)';
    const r = 14;
    const x = 18;
    const y = 18;
    const w = 92;
    const h = 92;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }
  shadowTexture = new CanvasTexture(canvas);
  return shadowTexture;
}

// ------------------------------------------------------------ tier frames (PR 10)

const frameVertex = /* glsl */ `
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const frameFragment = /* glsl */ `
  uniform vec3 uBase;
  uniform vec3 uShine;
  uniform float uSheen;
  uniform float uSparkle;
  uniform float uTime;
  uniform float uFlash;
  varying vec3 vN;
  varying vec3 vW;
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  void main() {
    vec3 N = normalize(vN);
    vec3 V = normalize(cameraPosition - vW);
    float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
    // Brushed-metal sheen: soft diagonal bands that slide as the head moves.
    float band = 0.5 + 0.5 * sin(dot(vW, vec3(7.0, 11.0, 4.0)) + dot(V, vec3(5.0, 3.5, 2.5)) * 2.0);
    float spec = pow(band, 8.0) * uSheen;
    float fres = pow(1.0 - ndv, 3.0) * 0.55;
    vec3 col = mix(uBase, uShine, clamp(spec + fres, 0.0, 1.0));
    // Tier-up: one bright sweep across every frame.
    float sweep = 1.0 - smoothstep(0.0, 0.12, abs(fract(dot(vW, vec3(1.3, 0.9, 0.4))) - uFlash));
    col += uShine * sweep * step(0.001, uFlash) * step(uFlash, 0.999) * 0.9;
    if (uSparkle > 0.5) {
      float h = hash(floor(vW * 140.0));
      float tw = 0.5 + 0.5 * sin(uTime * 2.7 + h * 50.0);
      col += vec3(1.0) * step(0.982, h) * smoothstep(0.75, 1.0, tw) * 1.4;
    }
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

const tierMaterials = new Map<TierId, ShaderMaterial>();
let highContrastFrame: MeshBasicMaterial | undefined;
function tierMaterial(tier: TierDef): ShaderMaterial {
  let m = tierMaterials.get(tier.id);
  if (m !== undefined) return m;
  m = new ShaderMaterial({
    uniforms: {
      uBase: { value: new Color(tier.base) },
      uShine: { value: new Color(tier.shine) },
      uSheen: { value: tier.sheen },
      uSparkle: { value: tier.sparkle ? 1 : 0 },
      uTime: { value: 0 },
      uFlash: { value: 0 },
    },
    vertexShader: frameVertex,
    fragmentShader: frameFragment,
  });
  m.name = `Card Frame ${tier.label}`;
  tierMaterials.set(tier.id, m);
  return m;
}
function frameMaterial(): ShaderMaterial | MeshBasicMaterial {
  if (getSettings().highContrast) {
    highContrastFrame ??= new MeshBasicMaterial({ color: 0xffe14d, name: 'Card Frame High Contrast' });
    return highContrastFrame;
  }
  return tierMaterial(currentTier);
}

let currentTier: TierDef = tierForLevel(getProgress().level);
let flashStart = -1;
const FLASH_MS = 1600;
/** Bumped whenever every frame must re-pick its material (tier or contrast changed). */
let frameEpoch = 0;
onProgress((p) => {
  const t = tierForLevel(p.level);
  if (t.id !== currentTier.id) {
    currentTier = t;
    frameEpoch += 1;
  }
});
onSettings((_s, changed) => {
  if (changed === 'highContrast' || changed === 'reducedMotion') frameEpoch += 1;
});

/** PR 10: the tier-up moment: one bright sweep over every card frame (skipped with reduced motion). */
export function flashFrames(): boolean {
  if (getSettings().reducedMotion) return false;
  flashStart = performance.now();
  return true;
}

function tickFrames(now: number): void {
  const m = tierMaterials.get(currentTier.id);
  if (m === undefined) return;
  const reduced = getSettings().reducedMotion;
  m.uniforms.uSparkle.value = currentTier.sparkle && !reduced ? 1 : 0;
  if (currentTier.sparkle && !reduced) m.uniforms.uTime.value = now / 1000;
  if (flashStart >= 0) {
    const t = (now - flashStart) / FLASH_MS;
    if (t >= 1) {
      flashStart = -1;
      m.uniforms.uFlash.value = 0;
    } else m.uniforms.uFlash.value = Math.max(0.001, t);
  }
}

/** Dev/test: the tier now and every frame material in use. */
export function frameState(): { tier: TierId; materials: string[]; flashing: boolean; sparkle: number } {
  const m = tierMaterials.get(currentTier.id);
  return {
    tier: currentTier.id,
    materials: [...tierMaterials.values()].map((x) => x.name),
    flashing: flashStart >= 0,
    sparkle: (m?.uniforms.uSparkle.value as number | undefined) ?? 0,
  };
}
export { TIERS };

type Decor = { shadow: Mesh; paper: Mesh; pinned: boolean | null; scale: number; epoch: number };
const decors = new WeakMap<object, Decor>();

function ensureDecor(panel: NonNullable<Entity['object3D']>): Decor {
  let decor = decors.get(panel);
  if (decor !== undefined) return decor;
  const shadow = new Mesh(
    new PlaneGeometry(CARD_UNITS_W, CARD_UNITS_H),
    new MeshBasicMaterial({
      map: getShadowTexture(),
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      color: 0x000000,
    }),
  );
  shadow.name = 'CardContactShadow';
  shadow.renderOrder = -1;
  shadow.raycast = () => undefined;
  const paper = new Mesh(paperGeometry(), frameMaterial());
  paper.name = 'CardPaperEdge';
  paper.raycast = () => undefined;
  panel.add(shadow, paper);
  decor = { shadow, paper, pinned: null, scale: -1, epoch: frameEpoch };
  decors.set(panel, decor);
  return decor;
}

function apply(panel: NonNullable<Entity['object3D']>, decor: Decor, pinned: boolean): void {
  const s = Math.max(1e-3, panel.scale.x);
  decor.pinned = pinned;
  decor.scale = s;
  const material = decor.shadow.material as MeshBasicMaterial;
  // The paper sits behind the face, `PAPER_M` thick (in card units: / scale).
  const paperDepth = PAPER_M / s;
  decor.paper.scale.set(1, 1, paperDepth);
  decor.paper.position.set(0, 0, -paperDepth / 2 - 0.0002 / s);
  // PR 10: the frame shows floating too; the floating drop shadow gives way to it (same draw count).
  decor.paper.visible = true;
  decor.paper.material = frameMaterial();
  decor.epoch = frameEpoch;
  decor.shadow.visible = pinned;
  if (pinned) {
    // On the surface itself (the card floats 2.5 mm off it), a touch larger than the card.
    decor.shadow.position.set(0, -0.05, -0.0021 / s);
    decor.shadow.scale.set(1.5, 1.4, 1);
    material.opacity = 0.55;
  } else {
    // A gentle drop shadow a few cm behind and below a floating card.
    decor.shadow.position.set(0.06, -0.22, -0.06 / s);
    decor.shadow.scale.set(1.75, 1.72, 1);
    material.opacity = 0.16;
  }
  if (panel instanceof UIKitMLAsset) {
    // Matte paper when pinned: a fully opaque face; floating keeps its glassy default.
    panel
      .getElementById<UIKit.Text>('quest-card-root')
      ?.setProperties({ backgroundOpacity: pinned || getSettings().highContrast ? 1 : 0.9 } as never);
  }
}

/** Keep every card's decor in step with its state (pinned / floating / held). */
export function syncCardDecor(cards: Iterable<Entity>): void {
  for (const card of cards) {
    const panel = card.object3D;
    if (panel == null) continue;
    const pinned =
      (card.getValue(QuestCard, 'surfaceId') as string).length > 0 &&
      (card.getValue(QuestCard, 'zoneId') as string).length > 0 &&
      !card.hasComponent(Grabbed);
    const decor = ensureDecor(panel);
    if (decor.pinned !== pinned || decor.epoch !== frameEpoch || Math.abs(decor.scale - panel.scale.x) > 1e-4) apply(panel, decor, pinned);
  }
  tickFrames(performance.now());
}

/** Dev/test view of a card's decor state. */
export function cardDecorState(card: Entity): { pinned: boolean | null; shadowOpacity: number; frame: string; shadowVisible: boolean; frameVisible: boolean } | null {
  const panel = card.object3D;
  const decor = panel ? decors.get(panel) : undefined;
  if (decor === undefined) return null;
  return {
    pinned: decor.pinned,
    shadowOpacity: (decor.shadow.material as MeshBasicMaterial).opacity,
    frame: (decor.paper.material as { name: string }).name,
    shadowVisible: decor.shadow.visible,
    frameVisible: decor.paper.visible,
  };
}

/**
 * PR 10 (reduced motion): fade a card instead of moving it. `alpha` 0..1 on
 * the UIKit face (opacity is inherited by its text); the frame and shadow
 * (shared materials, so no per-card alpha) hide while the face is mostly faded.
 */
export function setCardFade(panel: NonNullable<Entity['object3D']>, alpha: number): void {
  const a = Math.max(0, Math.min(1, alpha));
  if (panel instanceof UIKitMLAsset) {
    panel.getElementById<UIKit.Text>('quest-card-root')?.setProperties({ opacity: a } as never);
  }
  const decor = decors.get(panel);
  if (decor !== undefined) {
    decor.paper.visible = a > 0.5;
    if (a <= 0.5) decor.shadow.visible = false;
    else if (decor.pinned) decor.shadow.visible = true;
  }
}
