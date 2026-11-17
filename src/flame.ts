/**
 * The streak flame (PR 9): a small brass lantern on the user's desk whose
 * flame is the daily streak. It really burns (a noise-driven shader flame
 * with a hot core, rising tongues, a soft glow and a few embers), grows a
 * little with the streak, changes colour by tier (streak.ts STREAK_TIERS),
 * and carries a real flickering PointLight that casts shadows: the lantern's
 * posts and nearby cards throw shadows onto a ShadowMaterial catcher laid on
 * the detected desk, so the shadow shows over passthrough.
 *
 * Cost: the lantern is 3 meshes (base+candle, brass cage, wick), the flame,
 * glow and embers are 1 draw each, plus the desk catcher and light pool. The
 * point light's cube shadow map is 256 px a face and is re-rendered only when
 * something can have moved (a grab, a flight, the lantern itself) and
 * otherwise at ~15 Hz. Casters only cast for this light (never for the
 * room's key light).
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  createSystem,
  CylinderGeometry,
  DistanceGrabbable,
  DoubleSide,
  Grabbed,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MovementMode,
  OneHandGrabbable,
  PlaneGeometry,
  PointLight,
  Points,
  Quaternion,
  ShaderMaterial,
  ShadowMaterial,
  TorusGeometry,
  Vector2,
  Vector3,
  type Entity,
  type Material,
  type Object3D,
} from '@iwsdk/core';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { QuestCard, QuestCardTween } from './quest-component.js';
import { surfaceFrames, type SurfaceFrame } from './surfaces.js';
import { getProgress, onAward, onProgress, setStreakForDev, type AwardEvent } from './progress.js';
import {
  dayKey,
  flameScale,
  STREAK_TIERS,
  tierFor,
  viewStreak,
  type StreakStatus,
  type StreakView,
} from './streak.js';

const STORAGE_KEY = 'questty.flame.v1';
const DAY_MS = 86_400_000;

// ---- lantern geometry (metres)
const BASE_R = 0.045;
const WICK_TOP = 0.056;
const CAGE_R = 0.04;
const CAGE_TOP = 0.165;
const POSTS = 5;
const FLAME_W = 0.05;
const FLAME_H = 0.088;
const LIGHT_LIFT = 0.024;

// ---- light
const LIGHT_INTENSITY = 0.09; // candela-ish at three's physical units (decay 2)
/** 0 = no hard cut-off (physical 1/d^2 falloff). three uses light.distance as the shadow far plane when set, so it stays 0. */
const LIGHT_DISTANCE = 0;
const SHADOW_MAP = 256;
const SHADOW_FAR = 0.4;
const NEAR_ENTER = 0.12;
const NEAR_EXIT = 0.2;
const SNAP_UP = 0.45; // a release this far above a desk (or 15 cm below) lands on it
const SNAP_DOWN = 0.15;
const CARD_CAST_RANGE = 0.5;
const GAZE_COS = Math.cos((11 * Math.PI) / 180);

const FLARE_RISE = 0.22;
const FLARE_DECAY = 1.5;

/** Casts nothing: used as customDepthMaterial so our casters skip the room's key (directional) light. */
const NO_DEPTH = new ShaderMaterial({
  vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'void main(){ gl_FragColor = vec4(0.0); discard; }',
});
NO_DEPTH.name = 'questty-no-key-light-shadow';

const NOISE_GLSL = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}`;

function flameMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uCore: { value: new Color() },
      uBody: { value: new Color() },
      uEdge: { value: new Color() },
      uIntensity: { value: 1 },
      uTurb: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uCore; uniform vec3 uBody; uniform vec3 uEdge;
      uniform float uIntensity; uniform float uTurb;
      varying vec2 vUv;
      ${NOISE_GLSL}
      void main() {
        float y = vUv.y;
        float t = uTime;
        float n = fbm(vec2(vUv.x * 2.6 + 3.1, y * 3.6 - t * 2.9));
        float n2 = fbm(vec2(vUv.x * 5.5 - 1.7, y * 6.5 - t * 4.6));
        float x = (vUv.x - 0.5) * 2.0;
        // sway and lick: more at the top, like a real candle
        x += ((n - 0.5) * 0.85 * y * y + sin(t * 2.1 + y * 2.5) * 0.07 * y) * uTurb;
        float w = 0.62 * pow(max(sin(3.14159 * pow(clamp(y, 0.0, 1.0), 0.58)), 0.0), 0.85);
        float d = abs(x) / max(w, 0.001);
        float tip = 1.0 - smoothstep(0.5, 1.0, y + (n2 - 0.5) * 0.4 * uTurb);
        float body = (1.0 - smoothstep(0.55, 1.0, d)) * tip * smoothstep(0.0, 0.07, y);
        float core = (1.0 - smoothstep(0.0, 0.5, d)) * (1.0 - smoothstep(0.12, 0.6, y)) * smoothstep(0.03, 0.14, y);
        vec3 col = mix(uEdge, uBody, smoothstep(0.0, 0.7, body));
        col = mix(col, uCore, core);
        // the cool blue root of a real flame
        col = mix(col, vec3(0.28, 0.45, 1.0), (1.0 - smoothstep(0.04, 0.2, y)) * 0.55 * (1.0 - core));
        float a = clamp(body * uIntensity, 0.0, 1.0);
        gl_FragColor = vec4(col * (1.15 + core * 0.6) * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
}

function glowMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uColor: { value: new Color() }, uIntensity: { value: 0.4 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uIntensity; varying vec2 vUv;
      void main() {
        vec2 p = (vUv - vec2(0.5, 0.42)) * vec2(2.0, 1.7);
        float r = length(p);
        float g = exp(-r * r * 5.0) * uIntensity;
        gl_FragColor = vec4(uColor * g, g * 0.6);
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

function emberMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new Color() },
      uRise: { value: 0.11 },
      uRate: { value: 1 },
      uAlpha: { value: 0.9 },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime; uniform float uRise; uniform float uRate;
      varying float vFade;
      void main() {
        float ph = fract(uTime * (0.35 + aSeed * 0.3) * uRate + aSeed * 7.13);
        vec3 p = vec3(
          sin(aSeed * 40.0 + uTime * 1.7) * 0.012 * ph + (aSeed - 0.5) * 0.01,
          ph * uRise,
          cos(aSeed * 31.0 + uTime * 1.3) * 0.012 * ph);
        vFade = (1.0 - ph) * smoothstep(0.0, 0.1, ph);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(2.4 * (1.0 - ph * 0.5) / max(-mv.z, 0.05), 1.0, 6.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uAlpha; varying float vFade;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(c)) * vFade * uAlpha;
        gl_FragColor = vec4(uColor * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

/** Warm light pool on the desk, clipped to the desk rectangle (same geometry as the catcher). */
function poolMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uCenter: { value: new Vector3() },
      uColor: { value: new Color() },
      uIntensity: { value: 0.3 },
      uRadius: { value: 0.32 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uCenter; uniform vec3 uColor; uniform float uIntensity; uniform float uRadius;
      varying vec3 vWorld;
      void main() {
        float r = distance(vWorld, uCenter) / uRadius;
        float g = exp(-r * r * 2.2) * uIntensity;
        gl_FragColor = vec4(uColor * g, g * 0.5);
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

type Lantern = {
  root: Group;
  flame: Group;
  flameMesh: Mesh;
  glow: Mesh;
  embers: Points;
  light: PointLight;
  tag: Mesh;
  tagCtx: CanvasRenderingContext2D;
  tagTex: CanvasTexture;
  label: Mesh;
  labelCtx: CanvasRenderingContext2D;
  labelTex: CanvasTexture;
  hitbox: Mesh;
  flameMat: ShaderMaterial;
  glowMat: ShaderMaterial;
  emberMat: ShaderMaterial;
  casters: Mesh[];
  materials: Material[];
  geometries: BufferGeometry[];
};

function canvasPlane(w: number, h: number, px: [number, number]): { mesh: Mesh; ctx: CanvasRenderingContext2D; tex: CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = px[0];
  canvas.height = px[1];
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const tex = new CanvasTexture(canvas);
  tex.anisotropy = 4;
  const mesh = new Mesh(
    new PlaneGeometry(w, h),
    new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
  );
  return { mesh, ctx, tex };
}

function buildLantern(): Lantern {
  const root = new Group();
  root.name = 'Streak Flame';
  root.userData.iwsdkPreviewBounds = 'exclude';

  // Brass dish with a cream candle on it: one lathe each, merged into one mesh per material.
  const dish = new LatheGeometry(
    [
      new Vector2(0.0, 0.0),
      new Vector2(BASE_R, 0.0),
      new Vector2(BASE_R + 0.002, 0.004),
      new Vector2(BASE_R - 0.002, 0.011),
      new Vector2(0.03, 0.013),
      new Vector2(0.019, 0.016),
      new Vector2(0.0, 0.016),
    ],
    40,
  );
  const brass = new MeshStandardMaterial({ color: 0xa47a42, metalness: 0.6, roughness: 0.36 });
  const wax = new MeshStandardMaterial({ vertexColors: true, color: 0xf3e6cf, roughness: 0.7, metalness: 0, emissive: 0x6a3a10, emissiveIntensity: 0.25 });
  const candle = new CylinderGeometry(0.0155, 0.017, WICK_TOP - 0.016 - 0.004, 28, 1);
  candle.translate(0, 0.016 + (WICK_TOP - 0.02) / 2, 0);
  const wickGeo = new CylinderGeometry(0.0012, 0.0012, 0.006, 6);
  wickGeo.translate(0, WICK_TOP - 0.001, 0);
  // Candle + wick in one mesh (vertex colours): cream wax, dark wick.
  const paint = (g: BufferGeometry, c: number) => {
    const col = new Color(c);
    const n = g.getAttribute('position').count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) col.toArray(arr, i * 3);
    g.setAttribute('color', new BufferAttribute(arr, 3));
    return g.toNonIndexed();
  };
  const candleGeo = mergeGeometries([paint(candle, 0xffffff), paint(wickGeo, 0x2a1a10)]);
  candle.dispose();
  wickGeo.dispose();

  // Cage: posts from the rim up past the flame, a top ring, a little handle loop.
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < POSTS; i += 1) {
    const a = (i / POSTS) * Math.PI * 2 + Math.PI / POSTS;
    const post = new CylinderGeometry(0.0026, 0.0026, CAGE_TOP - 0.008, 8);
    post.translate(Math.cos(a) * CAGE_R, 0.008 + (CAGE_TOP - 0.008) / 2, Math.sin(a) * CAGE_R);
    parts.push(post);
  }
  const ring = new TorusGeometry(CAGE_R, 0.0032, 8, 40);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, CAGE_TOP, 0);
  parts.push(ring);
  const loop = new TorusGeometry(0.014, 0.0022, 6, 20, Math.PI);
  loop.translate(0, CAGE_TOP + 0.002, 0);
  parts.push(loop);
  // Dish + cage share the brass: one mesh, one draw (and one caster per shadow face).
  const cageGeo = mergeGeometries([dish.toNonIndexed(), ...parts.map((g) => g.toNonIndexed())]);
  for (const g of parts) g.dispose();
  dish.dispose();
  const cageMesh = new Mesh(cageGeo, brass);
  const candleMesh = new Mesh(candleGeo, wax);
  // Only the brass casts: the candle sits under the light, its shadow would hide beneath it.
  cageMesh.castShadow = true;
  cageMesh.customDepthMaterial = NO_DEPTH;
  const casters = [cageMesh];
  root.add(cageMesh, candleMesh);

  // Flame, glow, embers: a cylindrical billboard group sitting on the wick.
  const flame = new Group();
  flame.name = 'Streak Flame Fire';
  flame.position.y = WICK_TOP;
  const flameGeo = new PlaneGeometry(FLAME_W, FLAME_H);
  flameGeo.translate(0, FLAME_H / 2 - 0.004, 0);
  const flameMat = flameMaterial();
  const flameMesh = new Mesh(flameGeo, flameMat);
  flameMesh.renderOrder = 960;
  const glowGeo = new PlaneGeometry(0.2, 0.22);
  glowGeo.translate(0, 0.035, 0);
  const glowMat = glowMaterial();
  const glow = new Mesh(glowGeo, glowMat);
  glow.renderOrder = 959;
  const count = 14;
  const emberGeo = new BufferGeometry();
  emberGeo.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i += 1) seeds[i] = (i * 0.618034) % 1;
  emberGeo.setAttribute('aSeed', new BufferAttribute(seeds, 1));
  const emberMat = emberMaterial();
  const embers = new Points(emberGeo, emberMat);
  embers.frustumCulled = false;
  embers.position.y = 0.04;
  embers.renderOrder = 961;
  flame.add(glow, flameMesh, embers);
  root.add(flame);

  const light = new PointLight(0xffa040, LIGHT_INTENSITY, LIGHT_DISTANCE, 2);
  light.name = 'Streak Flame Light';
  light.position.y = WICK_TOP + LIGHT_LIFT;
  light.castShadow = true;
  light.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  light.shadow.camera.near = 0.005;
  // Shadows only within reach of a candle: the desk around it. (Further out the room's
  // floor catcher would get spokes the real table would have blocked.)
  light.shadow.camera.far = SHADOW_FAR;
  light.shadow.bias = -0.002;
  light.shadow.normalBias = 0.0;
  light.shadow.radius = 2.5;
  light.shadow.autoUpdate = false;
  root.add(light);

  // Engraved brass tag on the front of the dish: the streak number.
  const tag = canvasPlane(0.03, 0.017, [128, 72]);
  tag.mesh.position.set(0, 0.0105, BASE_R + 0.0022);
  tag.mesh.rotation.x = -0.18;
  tag.mesh.renderOrder = 962;
  root.add(tag.mesh);

  // Label shown on gaze or while held: "5-day streak - Gold".
  const label = canvasPlane(0.17, 0.048, [512, 144]);
  label.mesh.position.y = CAGE_TOP + 0.05;
  label.mesh.renderOrder = 963;
  (label.mesh.material as MeshBasicMaterial).opacity = 0;
  label.mesh.visible = false;
  root.add(label.mesh);

  // Grab target: a box around the lantern (invisible, raycast only).
  const hitbox = new Mesh(
    new BoxGeometry(0.11, CAGE_TOP + 0.03, 0.11),
    // Never drawn (material.visible false skips the draw call); pointer rays still hit it.
    new MeshBasicMaterial({ visible: false }),
  );
  hitbox.name = 'StreakFlameHitbox';
  hitbox.position.y = (CAGE_TOP + 0.03) / 2;
  root.add(hitbox);

  return {
    root,
    flame,
    flameMesh,
    glow,
    embers,
    light,
    tag: tag.mesh,
    tagCtx: tag.ctx,
    tagTex: tag.tex,
    label: label.mesh,
    labelCtx: label.ctx,
    labelTex: label.tex,
    hitbox,
    flameMat,
    glowMat,
    emberMat,
    casters,
    materials: [brass, wax, flameMat, glowMat, emberMat, tag.mesh.material as Material, label.mesh.material as Material, hitbox.material as Material],
    geometries: [cageGeo, candleGeo, flameGeo, glowGeo, emberGeo, tag.mesh.geometry, label.mesh.geometry, hitbox.geometry],
  };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

type Saved = { p: [number, number, number]; yaw: number; surface: boolean; userPlaced: boolean };

function loadSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as Saved;
    if (!Array.isArray(v.p) || v.p.length !== 3 || !v.p.every(Number.isFinite) || !Number.isFinite(v.yaw)) return null;
    return { p: v.p, yaw: v.yaw, surface: v.surface === true, userPlaced: v.userPlaced === true };
  } catch {
    return null;
  }
}

let activeFlame: FlameSystem | undefined;

/** A gentle flare when the buddy talks about the streak (no-op before the flame exists). */
export function pingFlame(): void {
  activeFlame?.flare(0.45);
}

export class FlameSystem extends createSystem({
  held: { required: [Grabbed] },
  cards: { required: [QuestCard] },
  tweens: { required: [QuestCardTween] },
}) {
  private lantern!: Lantern;
  private entity: Entity | undefined;
  private catcher!: Mesh;
  private pool!: Mesh;
  private poolMat!: ShaderMaterial;
  private catcherUniforms: { uFlame: { value: Vector3 }; uFade: { value: number } } | undefined;
  private deskGroup!: Group;
  private view: StreakView = { streak: 0, status: 'out', gap: null };
  private targetScale = 0.5;
  private scale = 0.5;
  private readonly core = new Color();
  private readonly body = new Color();
  private readonly edge = new Color();
  private readonly targetCore = new Color();
  private readonly targetBody = new Color();
  private readonly targetEdge = new Color();
  private flareAt = -1;
  private flareAmount = 1;
  private flareCount = 0;
  private lastFrameAt = performance.now();
  /** Dev only: a frozen animation clock (ms) for frame-exact captures; null = real time. */
  private fixedClock: number | null = null;
  /** Dev only: advance the frozen clock by 1/30 s every rendered frame (smooth video from a slow renderer). */
  private stepClock = false;
  private frameLog: number[] = [];

  private clock(): number {
    return this.fixedClock ?? performance.now();
  }
  private placed: 'none' | 'surface' | 'fallback' | 'saved' = 'none';
  private surfaceId = '';
  private userPlaced = false;
  private nearMode = false;
  private wasHeld = false;
  private startedAt = 0;
  private lastDay = '';
  private lastViewCheck = 0;
  private frame = 0;
  private labelAlpha = 0;
  private labelText = '';
  private lightEnabled = true;
  private poolEnabled = true;
  private shadowRenders = 0;
  private lastPos = new Vector3(Infinity, 0, 0);
  private readonly head = new Vector3();
  private readonly headDir = new Vector3();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpQ = new Quaternion();
  private readonly handPoints = Array.from({ length: 6 }, () => new Vector3());
  private readonly casterCards = new WeakSet<Object3D>();
  private readonly cardCasters = new Map<Entity, Mesh>();
  private castingCards = 0;
  private flickerValue = 1;
  private updateMs = 0;

  init(): void {
    activeFlame = this;
    this.startedAt = performance.now();
    this.lantern = buildLantern();
    this.lantern.root.visible = false;

    // Desk catcher + light pool share one rectangle laid on the detected desk.
    this.deskGroup = new Group();
    this.deskGroup.name = 'Streak Flame Desk';
    const rect = new PlaneGeometry(1, 1);
    rect.rotateX(-Math.PI / 2);
    this.catcher = new Mesh(rect, this.catcherMaterial());
    this.catcher.receiveShadow = true;
    this.catcher.renderOrder = 940;
    this.catcher.name = 'Streak Flame Shadow Catcher';
    this.poolMat = poolMaterial();
    this.pool = new Mesh(rect, this.poolMat);
    this.pool.position.y = 0.0004;
    this.pool.renderOrder = 941;
    this.deskGroup.add(this.catcher, this.pool);
    this.deskGroup.visible = false;
    this.world.createTransformEntity(this.deskGroup, { parent: this.world.sceneEntity, persistent: true });

    this.entity = this.world.createTransformEntity(this.lantern.root, { parent: this.world.sceneEntity, persistent: true });
    this.setGrab('ray');

    this.refreshView(true);
    this.core.copy(this.targetCore);
    this.body.copy(this.targetBody);
    this.edge.copy(this.targetEdge);
    this.scale = this.targetScale;

    this.cleanupFuncs.push(
      onAward((event) => this.onAward(event)),
      onProgress(() => this.refreshView(false)),
    );
    // Cards cast shadows from this flame only (their invisible hitbox, never the UI glyphs).
    this.queries.cards.subscribe('qualify', (card) => this.makeCaster(card));
    for (const card of this.queries.cards.entities) this.makeCaster(card);

    if (import.meta.env.DEV) this.installDevHooks();

    this.cleanupFuncs.push(() => {
      if (activeFlame === this) activeFlame = undefined;
      this.entity?.dispose();
      for (const m of this.lantern.materials) m.dispose();
      for (const g of this.lantern.geometries) g.dispose();
      this.lantern.tagTex.dispose();
      this.lantern.labelTex.dispose();
      rect.dispose();
      (this.catcher.material as Material).dispose();
      this.poolMat.dispose();
    });
  }

  /**
   * ShadowMaterial whose shadow fades with distance from the flame, the way a
   * candle's shadow does (its light falls off), instead of running to the
   * desk's edge at full strength.
   */
  private catcherMaterial(): ShadowMaterial {
    const mat = new ShadowMaterial({ color: 0x120802, opacity: 0.6, transparent: true, depthWrite: false });
    const uniforms = { uFlame: { value: new Vector3() }, uFade: { value: 0.32 } };
    this.catcherUniforms = uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFlameW;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvFlameW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFlameW;\nuniform vec3 uFlame;\nuniform float uFade;')
        .replace(
          'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );',
          'float fr = distance(vFlameW, uFlame) / uFade;\n\tgl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) * exp(-fr * fr) );',
        );
    };
    mat.customProgramCacheKey = () => 'questty-flame-catcher';
    return mat;
  }

  // ------------------------------------------------------------ streak state

  private refreshView(fromInit: boolean): void {
    const progress = getProgress();
    const view = viewStreak(progress, dayKey(Date.now()));
    const tier = tierFor(view.streak);
    const ember = view.status === 'ember';
    this.view = view;
    this.targetScale = flameScale(view);
    this.targetCore.setHex(tier.core);
    this.targetBody.setHex(tier.body);
    this.targetEdge.setHex(tier.edge);
    if (ember) {
      // A low ember: the same colours, darker and redder.
      this.targetBody.lerp(new Color(0xa03810), 0.5);
      this.targetCore.lerp(new Color(0xff9a50), 0.5);
    }
    this.lastDay = dayKey(Date.now());
    this.drawTag();
    this.drawLabel();
    if (!fromInit) this.shadowDirty();
  }

  private onAward(event: AwardEvent): void {
    this.refreshView(false);
    this.flare(event.streak.firstOfDay ? 1 : 0.7);
  }

  /** The completion flare: a quick rise, brighter light, a burst of embers. */
  flare(amount = 1): void {
    this.flareCount += 1;
    this.flareAt = this.clock();
    this.flareAmount = amount;
  }

  private flareEnvelope(now: number): number {
    if (this.flareAt < 0) return 0;
    const t = (now - this.flareAt) / 1000;
    if (t < 0) return 0;
    if (t < FLARE_RISE) return (t / FLARE_RISE) * this.flareAmount;
    const d = (t - FLARE_RISE) / FLARE_DECAY;
    if (d > 1) {
      this.flareAt = -1;
      return 0;
    }
    return (1 - d) * (1 - d) * this.flareAmount;
  }

  private drawTag(): void {
    const { tagCtx: ctx, tagTex } = this.lantern;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#d9b36a');
    grad.addColorStop(1, '#8e6a32');
    ctx.fillStyle = grad;
    roundRect(ctx, 2, 2, w - 4, h - 4, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,36,10,0.7)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#3a240c';
    ctx.font = 'bold 52px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(this.view.streak), w / 2, h / 2 + 3);
    tagTex.needsUpdate = true;
  }

  private drawLabel(): void {
    const view = this.view;
    const tier = tierFor(view.streak);
    const text =
      view.status === 'out'
        ? 'Light it: finish one thing today'
        : view.status === 'ember'
          ? `${view.streak}-day streak - ember, finish one today`
          : `${view.streak}-day streak - ${tier.name}`;
    if (text === this.labelText) return;
    this.labelText = text;
    const { labelCtx: ctx, labelTex } = this.lantern;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(18,22,28,0.86)';
    roundRect(ctx, 4, 4, w - 8, h - 8, 60);
    ctx.fill();
    ctx.fillStyle = hex(tier.body);
    ctx.beginPath();
    ctx.arc(70, h / 2, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${text.length > 26 ? 34 : 42}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 112, h / 2 + 2, w - 130);
    labelTex.needsUpdate = true;
  }

  // ------------------------------------------------------------ placement

  private desks(): SurfaceFrame[] {
    return surfaceFrames().filter((s) => s.kind === 'desk');
  }

  /** Is `point` over desk `d` (inside its rectangle, within the snap band)? Returns the height above it. */
  private overDesk(d: SurfaceFrame, point: Vector3, margin = 0.02): number | null {
    const rel = this.tmpA.copy(point).sub(d.center);
    const up = rel.dot(d.normal);
    if (up > SNAP_UP || up < -SNAP_DOWN) return null;
    const pu = rel.dot(d.u);
    const pv = rel.dot(d.v);
    if (Math.abs(pu) > d.width / 2 - margin || Math.abs(pv) > d.height / 2 - margin) return null;
    return up;
  }

  private deskUnder(point: Vector3): SurfaceFrame | null {
    let best: SurfaceFrame | null = null;
    let bestUp = Infinity;
    for (const d of this.desks()) {
      const up = this.overDesk(d, point);
      if (up !== null && Math.abs(up) < bestUp) {
        best = d;
        bestUp = Math.abs(up);
      }
    }
    return best;
  }

  /** Stand the lantern on desk `d` at the projection of `point` (kept inside the edges). */
  private standOn(d: SurfaceFrame, point: Vector3): void {
    const rel = this.tmpA.copy(point).sub(d.center);
    const inset = BASE_R + 0.025;
    const pu = Math.max(-d.width / 2 + inset, Math.min(d.width / 2 - inset, rel.dot(d.u)));
    const pv = Math.max(-d.height / 2 + inset, Math.min(d.height / 2 - inset, rel.dot(d.v)));
    const pos = this.tmpB.copy(d.center).addScaledVector(d.u, pu).addScaledVector(d.v, pv).addScaledVector(d.normal, 0.0005);
    this.lantern.root.position.copy(pos);
    this.surfaceId = d.id;
    this.layDesk(d);
  }

  /** Lay the catcher + pool over the whole desk rectangle. */
  private layDesk(d: SurfaceFrame): void {
    const g = this.deskGroup;
    g.position.copy(d.center).addScaledVector(d.normal, 0.0012);
    // Frame: x = u, y = normal, z = v (the rect lies in local XZ).
    const basis = new Matrix4().makeBasis(d.u, d.normal, new Vector3().copy(d.u).cross(d.normal));
    g.quaternion.setFromRotationMatrix(basis);
    g.scale.set(d.width, 1, d.height);
    g.visible = true;
    this.shadowDirty();
  }

  /** A floor-less fallback: a small virtual desk patch under the lantern. */
  private layPatch(at: Vector3): void {
    const g = this.deskGroup;
    g.position.copy(at).add(this.tmpA.set(0, 0.0012, 0));
    g.quaternion.identity();
    g.scale.set(0.7, 1, 0.5);
    g.visible = true;
    this.surfaceId = '';
    this.shadowDirty();
  }

  private faceHead(): void {
    const root = this.lantern.root;
    this.world.player.head.getWorldPosition(this.head);
    const dx = this.head.x - root.position.x;
    const dz = this.head.z - root.position.z;
    root.quaternion.setFromAxisAngle(this.tmpA.set(0, 1, 0), Math.atan2(dx, dz));
  }

  private tryPlace(now: number): void {
    if (this.placed !== 'none' && this.placed !== 'fallback' && this.placed !== 'saved') return;
    const root = this.lantern.root;
    const desks = this.desks();
    const saved = this.placed === 'none' ? loadSaved() : null;
    if (saved !== null && saved.userPlaced) {
      root.position.fromArray(saved.p);
      root.quaternion.setFromAxisAngle(this.tmpA.set(0, 1, 0), saved.yaw);
      this.userPlaced = true;
      root.visible = true;
      this.placed = 'saved';
    }
    if (this.placed === 'saved') {
      // Re-seat a saved lantern on the desk under it once the desk is detected.
      const d = this.deskUnder(root.position);
      if (d !== null) {
        this.standOn(d, root.position);
        this.placed = 'surface';
      } else if (now - this.startedAt > 6000 && !this.deskGroup.visible) {
        this.layPatch(root.position);
      }
      return;
    }
    if (desks.length > 0) {
      // The nearest desk; the lantern goes to its right-hand end, toward the user.
      this.world.player.head.getWorldPosition(this.head);
      this.headDir.set(0, 0, -1).applyQuaternion(this.world.player.head.getWorldQuaternion(this.tmpQ));
      // The nearest desk in front of the user (one behind them only if there is no other).
      const cost = (d: SurfaceFrame) => {
        const to = this.tmpA.copy(d.center).sub(this.head);
        const ahead = to.x * this.headDir.x + to.z * this.headDir.z > 0;
        return d.center.distanceTo(this.head) + (ahead ? 0 : 10);
      };
      let best = desks[0];
      for (const d of desks) if (cost(d) < cost(best)) best = d;
      const right = this.tmpB.set(-this.headDir.z, 0, this.headDir.x).normalize();
      const halfRight = Math.abs(right.dot(best.u)) * best.width / 2 + Math.abs(right.dot(best.v)) * best.height / 2;
      const toward = this.tmpA.copy(this.head).sub(best.center);
      toward.addScaledVector(best.normal, -toward.dot(best.normal)).normalize();
      const halfToward = Math.abs(toward.dot(best.u)) * best.width / 2 + Math.abs(toward.dot(best.v)) * best.height / 2;
      const point = best.center
        .clone()
        .addScaledVector(right, Math.max(0, halfRight - 0.16))
        .addScaledVector(toward, Math.max(0, halfToward - 0.14));
      this.standOn(best, point);
      this.faceHead();
      root.visible = true;
      this.placed = 'surface';
      return;
    }
    if (this.placed === 'none' && now - this.startedAt > 5000 && this.world.renderer.xr.isPresenting) {
      // No desk detected: in front of the user, at desk height.
      this.world.player.head.getWorldPosition(this.head);
      this.headDir.set(0, 0, -1).applyQuaternion(this.world.player.head.getWorldQuaternion(this.tmpQ));
      this.headDir.y = 0;
      this.headDir.normalize();
      root.position.copy(this.head).addScaledVector(this.headDir, 0.55).add(this.tmpA.set(0.18, 0, 0));
      root.position.y = Math.max(0.55, this.head.y - 0.5);
      this.faceHead();
      this.layPatch(root.position);
      root.visible = true;
      this.placed = 'fallback';
    }
  }

  private save(): void {
    try {
      const r = this.lantern.root;
      const yaw = 2 * Math.atan2(r.quaternion.y, r.quaternion.w);
      const saved: Saved = { p: [r.position.x, r.position.y, r.position.z], yaw, surface: this.surfaceId !== '', userPlaced: this.userPlaced };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      // storage off: the lantern is placed fresh next time
    }
  }

  // ------------------------------------------------------------ grab

  private setGrab(mode: 'near' | 'ray'): void {
    const e = this.entity;
    if (e === undefined || e.hasComponent(Grabbed)) return;
    const want = mode === 'near' ? OneHandGrabbable : DistanceGrabbable;
    if (e.hasComponent(want)) return;
    if (e.hasComponent(OneHandGrabbable)) e.removeComponent(OneHandGrabbable);
    if (e.hasComponent(DistanceGrabbable)) e.removeComponent(DistanceGrabbable);
    for (const component of e.getComponents()) {
      if ((component as { id?: string }).id === 'Handle') e.removeComponent(component);
    }
    if (mode === 'near') e.addComponent(OneHandGrabbable, { rotate: false, translate: true });
    else e.addComponent(DistanceGrabbable, { movementMode: MovementMode.MoveFromTarget, rotate: false, scale: false, translate: true });
  }

  private updateGrabMode(): void {
    const player = this.world.player;
    const spaces = [
      player.indexTipSpaces.left, player.indexTipSpaces.right,
      player.gripSpaces.left, player.gripSpaces.right,
      player.raySpaces.left, player.raySpaces.right,
    ];
    const centre = this.tmpA.copy(this.lantern.root.position);
    centre.y += 0.09;
    let nearest = Infinity;
    for (let i = 0; i < spaces.length; i += 1) {
      spaces[i].getWorldPosition(this.handPoints[i]);
      nearest = Math.min(nearest, this.handPoints[i].distanceTo(centre) - 0.06);
    }
    const near = this.nearMode ? nearest < NEAR_EXIT : nearest < NEAR_ENTER;
    if (near !== this.nearMode) {
      this.nearMode = near;
      this.setGrab(near ? 'near' : 'ray');
    }
  }

  private onRelease(): void {
    const root = this.lantern.root;
    this.userPlaced = true;
    const d = this.deskUnder(root.position);
    if (d !== null) {
      this.standOn(d, root.position);
      this.placed = 'surface';
    } else {
      this.placed = 'surface'; // floating where it was let go; the old desk keeps its catcher
      this.surfaceId = '';
    }
    this.save();
    this.flare(0.35);
  }

  // ------------------------------------------------------------ shadows

  private makeCaster(card: Entity): void {
    const object = card.object3D;
    if (object == null || this.casterCards.has(object)) return;
    const hitbox = object.getObjectByName('QuestCardHitbox') as Mesh | undefined;
    if (hitbox === undefined) return;
    this.casterCards.add(object);
    hitbox.customDepthMaterial = NO_DEPTH;
    this.cardCasters.set(card, hitbox);
    this.updateCardCasters();
  }

  /**
   * A card casts only while it is within reach of the flame (its shadow can
   * land on the desk); far cards are skipped in every shadow pass.
   */
  private updateCardCasters(): void {
    const root = this.lantern.root;
    let count = 0;
    for (const [card, hitbox] of this.cardCasters) {
      if (!card.active || card.object3D == null) {
        this.cardCasters.delete(card);
        continue;
      }
      card.object3D.getWorldPosition(this.tmpB);
      const cast = root.visible && this.tmpB.distanceTo(root.position) < CARD_CAST_RANGE;
      if (cast !== hitbox.castShadow) {
        hitbox.castShadow = cast;
        this.shadowDirty();
      }
      if (cast) count += 1;
    }
    this.castingCards = count;
  }

  private shadowDirty(): void {
    if (this.lantern !== undefined) this.lantern.light.shadow.needsUpdate = true;
  }

  // ------------------------------------------------------------ frame

  update(): void {
    const t0 = performance.now();
    if (this.stepClock && this.fixedClock !== null) {
      this.fixedClock += 1000 / 30;
      this.frameLog.push(t0);
    }
    const now = this.clock();
    this.frame += 1;
    if (now - this.lastViewCheck > 30_000) {
      // Day rollover while the app stays open.
      this.lastViewCheck = now;
      if (dayKey(Date.now()) !== this.lastDay) this.refreshView(false);
    }
    this.tryPlace(now);
    const L = this.lantern;
    const root = L.root;
    if (!root.visible) return;

    const held = this.entity?.hasComponent(Grabbed) === true;
    if (held) {
      // Upright while carried: keep only the yaw.
      const yaw = 2 * Math.atan2(root.quaternion.y, root.quaternion.w);
      root.quaternion.setFromAxisAngle(this.tmpA.set(0, 1, 0), yaw);
    } else if (this.wasHeld) this.onRelease();
    this.wasHeld = held;
    if (!held && this.frame % 3 === 0) this.updateGrabMode();
    if (this.frame % 15 === 0) this.updateCardCasters();

    // Colour and size ease toward the tier / streak (time-based: same feel at any frame rate).
    const dt = Math.min(0.5, Math.max(0, (now - this.lastFrameAt) / 1000));
    this.lastFrameAt = now;
    const k = 1 - Math.exp(-dt / 0.35);
    this.core.lerp(this.targetCore, k);
    this.body.lerp(this.targetBody, k);
    this.edge.lerp(this.targetEdge, k);
    this.scale += (this.targetScale - this.scale) * (1 - Math.exp(-dt / 0.3));

    const time = now / 1000;
    const ember = this.view.status === 'ember';
    const flicker =
      0.86 + 0.07 * Math.sin(time * 11.3) + 0.05 * Math.sin(time * 17.9 + 1.1) + 0.04 * Math.sin(time * 29.3 + 2.3);
    this.flickerValue = flicker;
    const env = this.flareEnvelope(now);
    const s = this.scale * (1 + 0.5 * env);
    L.flame.scale.set(s * (1 + 0.04 * Math.sin(time * 7.7)), s * (0.97 + 0.06 * flicker), s);

    const fm = L.flameMat.uniforms;
    fm.uTime.value = time;
    fm.uCore.value.copy(this.core);
    fm.uBody.value.copy(this.body);
    fm.uEdge.value.copy(this.edge);
    fm.uIntensity.value = (ember ? 0.75 : 1.05) * (0.92 + 0.12 * flicker) * (1 + 0.6 * env);
    fm.uTurb.value = 1 + env * 0.8;
    const gm = L.glowMat.uniforms;
    gm.uColor.value.copy(this.body);
    gm.uIntensity.value = (ember ? 0.18 : 0.34) * flicker * (1 + 1.4 * env);
    const em = L.emberMat.uniforms;
    em.uTime.value = time;
    em.uColor.value.copy(this.body).lerp(this.core, 0.3);
    em.uRate.value = 1 + 3 * env;
    em.uAlpha.value = this.view.streak >= 3 || env > 0.05 ? 0.9 : 0.35;
    em.uRise.value = 0.1 * s + 0.08 * env;

    // The light: tier colour, flickering with the flame, flaring with it.
    const light = L.light;
    light.visible = this.lightEnabled;
    light.color.copy(this.body).lerp(this.core, 0.25);
    light.intensity = LIGHT_INTENSITY * (0.4 + 0.6 * Math.min(1.3, s)) * flicker * (ember ? 0.4 : 1) * (1 + 1.6 * env);
    light.position.y = WICK_TOP + LIGHT_LIFT * s;

    // Desk pool follows the lantern.
    this.pool.visible = this.poolEnabled && this.lightEnabled;
    const pm = this.poolMat.uniforms;
    pm.uCenter.value.copy(root.position);
    pm.uColor.value.copy(this.body).lerp(this.core, 0.2);
    pm.uIntensity.value = (ember ? 0.16 : 0.45) * flicker * (1 + 1.2 * env);
    pm.uRadius.value = 0.26 + 0.08 * s;
    if (this.catcherUniforms !== undefined) {
      this.catcherUniforms.uFlame.value.copy(root.position);
      this.catcherUniforms.uFade.value = (ember ? 0.2 : 0.3) + 0.1 * Math.min(1.3, s);
    }

    // Cylindrical billboard: the flame planes turn to the head around Y.
    this.world.player.head.getWorldPosition(this.head);
    const yawRoot = 2 * Math.atan2(root.quaternion.y, root.quaternion.w);
    const yawHead = Math.atan2(this.head.x - root.position.x, this.head.z - root.position.z);
    L.flame.rotation.y = yawHead - yawRoot;
    L.label.rotation.y = yawHead - yawRoot;

    // Label on gaze (or while held).
    this.headDir.set(0, 0, -1).applyQuaternion(this.world.player.head.getWorldQuaternion(this.tmpQ));
    const to = this.tmpA.copy(root.position).add(this.tmpB.set(0, 0.09, 0)).sub(this.head).normalize();
    const gazing = this.headDir.dot(to) > GAZE_COS;
    const want = held || gazing || this.flareAt >= 0 ? 1 : 0;
    this.labelAlpha += (want - this.labelAlpha) * (1 - Math.exp(-dt / 0.2));
    const lm = L.label.material as MeshBasicMaterial;
    lm.opacity = this.labelAlpha;
    L.label.visible = this.labelAlpha > 0.02;

    // Point-light shadow: only re-rendered when something may have moved.
    const moved = this.lastPos.distanceToSquared(root.position) > 1e-8;
    if (moved) this.lastPos.copy(root.position);
    const busy = held || moved || this.queries.held.entities.size > 0 || this.queries.tweens.entities.size > 0;
    if (busy || this.frame % 4 === 0) this.shadowDirty();
    if (light.shadow.needsUpdate) this.shadowRenders += 1;
    this.updateMs = this.updateMs * 0.95 + (performance.now() - t0) * 0.05;
  }

  // ------------------------------------------------------------ dev hooks

  private installDevHooks(): void {
    // The whole body sits under the DEV check so production builds drop it.
    if (import.meta.env.DEV) {
      const w = window as unknown as { __questty?: Record<string, unknown> };
      const state = () => {
        const r = this.lantern.root;
        r.updateWorldMatrix(true, true);
        const fireTop = new Vector3(0, FLAME_H, 0);
        this.lantern.flame.localToWorld(fireTop);
        return {
          visible: r.visible,
          placed: this.placed,
          surfaceId: this.surfaceId,
          userPlaced: this.userPlaced,
          position: r.position.toArray(),
          streak: this.view.streak,
          status: this.view.status,
          tier: tierFor(this.view.streak).id,
          tierName: tierFor(this.view.streak).name,
          body: `#${this.body.getHexString()}`,
          targetBody: `#${this.targetBody.getHexString()}`,
          scale: this.scale,
          targetScale: this.targetScale,
          flameHeightM: fireTop.y - r.position.y,
          light: { on: this.lightEnabled && this.lantern.light.visible, intensity: this.lantern.light.intensity, castShadow: this.lantern.light.castShadow, mapSize: this.lantern.light.shadow.mapSize.x, color: `#${this.lantern.light.color.getHexString()}` },
          pool: this.pool.visible,
          catcher: { visible: this.deskGroup.visible, scale: this.deskGroup.scale.toArray(), position: this.deskGroup.position.toArray() },
          held: this.entity?.hasComponent(Grabbed) === true,
          grabMode: this.nearMode ? 'near' : 'ray',
          label: { text: this.labelText, alpha: this.labelAlpha },
          flaring: this.flareAt >= 0,
          flares: this.flareCount,
          shadowRenders: this.shadowRenders,
          castingCards: this.castingCards,
          updateMs: this.updateMs,
          flicker: this.flickerValue,
        };
      };
      const setStreak = (streak: number, status: StreakStatus = 'lit') => {
        const today = Date.now();
        const back = status === 'lit' ? 0 : status === 'waiting' ? 1 : status === 'ember' ? 2 : 5;
        setStreakForDev(status === 'out' ? 0 : streak, status === 'out' ? null : dayKey(today - back * DAY_MS));
        this.refreshView(false);
        return state();
      };
      const renderStats = () => {
        const info = this.world.renderer.info;
        return { calls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length ?? null };
      };
      const lightOn = (on: boolean, pool = on) => {
        this.lightEnabled = on;
        this.poolEnabled = pool;
        this.shadowDirty();
        return state();
      };
      const moveTo = (x: number, y: number, z: number, release = true) => {
        this.lantern.root.position.set(x, y, z);
        if (release) this.onRelease();
        return state();
      };
      const screenOf = () => {
        // Where the lantern base and the desk around it land in the canvas (for pixel checks).
        const r = this.lantern.root;
        const cam = this.world.renderer.xr.isPresenting ? this.world.renderer.xr.getCamera() : this.world.camera;
        const view = (cam as unknown as { cameras?: import('@iwsdk/core').PerspectiveCamera[] }).cameras?.[0] ?? cam;
        const canvas = this.world.renderer.domElement;
        const project = (p: Vector3) => {
          const v = p.clone().project(view as import('@iwsdk/core').Camera);
          return [((v.x + 1) / 2) * canvas.clientWidth, ((1 - v.y) / 2) * canvas.clientHeight];
        };
        return {
          base: project(r.position.clone()),
          top: project(r.position.clone().add(new Vector3(0, CAGE_TOP, 0))),
          ring: [0.08, 0.15, 0.25].map((rad) =>
            Array.from({ length: 12 }, (_, i) => {
              const a = (i / 12) * Math.PI * 2;
              return project(r.position.clone().add(new Vector3(Math.cos(a) * rad, 0, Math.sin(a) * rad)));
            }),
          ),
        };
      };
      const hideFlame = (hide: boolean) => {
        this.lantern.root.visible = !hide;
        this.deskGroup.visible = !hide;
        return renderStats();
      };
      w.__questty = {
        ...w.__questty,
        flame: {
          state,
          setStreak,
          flare: (amount = 1) => {
            this.flare(amount);
            return state();
          },
          lightOn,
          moveTo,
          screenOf,
          renderStats,
          hideFlame,
          tiers: () => STREAK_TIERS.map((t) => ({ id: t.id, from: t.from, body: hex(t.body) })),
          forgetPlacement: () => localStorage.removeItem(STORAGE_KEY),
          /** Freeze the flame's animation clock at `ms` (null: real time again) for smooth frame-by-frame video. */
          setClock: (ms: number | null, step = false) => {
            if (ms === null) {
              this.fixedClock = null;
              this.stepClock = false;
              this.lastFrameAt = performance.now();
            } else {
              this.fixedClock = ms;
              this.stepClock = step;
            }
            return ms;
          },
          frameClock: () => this.fixedClock,
          /** performance.now() of every stepped frame since the last call (and clears it). */
          takeFrameLog: () => this.frameLog.splice(0),
        },
      };
    }
  }
}
