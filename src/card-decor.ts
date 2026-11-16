import {
  CanvasTexture,
  ExtrudeGeometry,
  Grabbed,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Shape,
  UIKit,
  UIKitMLAsset,
  type Entity,
} from '@iwsdk/core';
import { CARD_UNITS_H, CARD_UNITS_W } from './card-layout.js';
import { QuestCard } from './quest-component.js';

/*
 * What makes a pinned card read as part of the surface: a soft contact shadow
 * on the surface right under it, a thin paper edge, and a matte face. A
 * floating card keeps its look plus a gentle drop shadow behind it. Decor
 * lives as children of the card panel (card units, scaled with the card).
 */

const PAPER_M = 0.0016; // paper thickness in metres
const PAPER_COLOR = 0x1b1b1e; // the card's own dark edge, seen as thickness
/** The card face as drawn (UIKit panel): full width, ~91% of the hitbox height, rounded corners. */
const FACE_W = CARD_UNITS_W * 0.99;
const FACE_H = CARD_UNITS_H * 0.9;
const FACE_R = 0.22;

let paperGeo: ExtrudeGeometry | undefined;
/** A rounded slab the size of the card face, 1 unit deep (scaled to the paper thickness). */
function paperGeometry(): ExtrudeGeometry {
  if (paperGeo !== undefined) return paperGeo;
  const w = FACE_W / 2;
  const h = FACE_H / 2;
  const r = FACE_R;
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

type Decor = { shadow: Mesh; paper: Mesh; pinned: boolean | null; scale: number };
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
  const paper = new Mesh(paperGeometry(), new MeshBasicMaterial({ color: PAPER_COLOR }));
  paper.name = 'CardPaperEdge';
  paper.raycast = () => undefined;
  panel.add(shadow, paper);
  decor = { shadow, paper, pinned: null, scale: -1 };
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
  decor.paper.visible = pinned;
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
      ?.setProperties({ backgroundOpacity: pinned ? 1 : 0.9 } as never);
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
    if (decor.pinned !== pinned || Math.abs(decor.scale - panel.scale.x) > 1e-4) apply(panel, decor, pinned);
  }
}

/** Dev/test view of a card's decor state. */
export function cardDecorState(card: Entity): { pinned: boolean | null; shadowOpacity: number } | null {
  const panel = card.object3D;
  const decor = panel ? decors.get(panel) : undefined;
  if (decor === undefined) return null;
  return { pinned: decor.pinned, shadowOpacity: (decor.shadow.material as MeshBasicMaterial).opacity };
}
