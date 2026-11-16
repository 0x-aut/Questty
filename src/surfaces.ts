import {
  CanvasTexture,
  createSystem,
  DistanceGrabbable,
  DoubleSide,
  Grabbed,
  GrabSystem,
  Group,
  LineBasicMaterial,
  LineLoop,
  BufferGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MovementMode,
  OneHandGrabbable,
  PlaneGeometry,
  Quaternion,
  Sprite,
  SpriteMaterial,
  Vector3,
  XRPlane,
  type Entity,
} from '@iwsdk/core';
import { CARD_UNITS_H, CARD_UNITS_W, FLOAT_CARD_SCALE } from './card-layout.js';
import { homeForward } from './card-layout.js';
import { QuestCard, QuestCardTween, SnapSurface } from './quest-component.js';

/**
 * Surfaces quest cards snap to: every wall, desk/table top and door in the room.
 *
 * Where they come from, in order:
 *  1. Room planes. IWSDK's SceneUnderstandingSystem turns WebXR plane detection
 *     into `XRPlane` entities (on a Quest in passthrough this is the user's real
 *     room; in the IWER emulator it is the synthetic living room). Planes whose
 *     semantic label reads wall / table / desk / door get a `SnapSurface`.
 *  2. Scene nodes tagged with `SnapSurface` in the scene JSON.
 *  3. A small virtual room (two walls, a desk, a door) when the session has no
 *     plane detection or no usable plane appears within a few seconds, or when
 *     the page is opened with `?surfaces=virtual`.
 *
 * All three share the XRPlane frame convention: normal = local +Y, extent =
 * width along local X by height along local Z.
 */

export type SurfaceKind = 'wall' | 'desk' | 'door';

export type SnapTarget = {
  surfaceId: string;
  kind: SurfaceKind;
  label: string;
  position: Vector3;
  quaternion: Quaternion;
  scale: number;
  via: 'near' | 'ray';
  /** True when no free spot was left and the card overlaps another one. */
  crowded?: boolean;
};

type Frame = {
  entity: Entity;
  id: string;
  kind: SurfaceKind;
  origin: Vector3;
  normal: Vector3;
  u: Vector3;
  v: Vector3;
  width: number;
  height: number;
};

type Blocker = { origin: Vector3; normal: Vector3; u: Vector3; v: Vector3; width: number; height: number };

type DetectedPlane = {
  orientation: 'horizontal' | 'vertical';
  semanticLabel?: string;
  polygon: readonly { x: number; z: number }[];
};

type Flight = {
  from: Vector3;
  to: Vector3;
  qFrom: Quaternion;
  qTo: Quaternion;
  sFrom: number;
  sTo: number;
  startedAt: number;
};

const SURFACE_GAP = 0.004; // metres between card and surface (no z-fighting)
const DESK_TILT = (22 * Math.PI) / 180; // desk cards lean back toward the user
const NEAR_SNAP_DISTANCE = 0.22; // card centre to surface, for a near drop
const BOUNDS_MARGIN = 0.12;
const RAY_MAX = 8;
const CARD_GAP = 0.03;
const PINNED_NEAR_SCALE = 0.12;
const FLIGHT_MS = 280;
/** Width of a card's focus panel (focus-action.uikitml, 200px) in card units. */
const FOCUS_PANEL_UNITS = 2.0;
const NEAR_ENTER = 0.12; // hand within this of a card -> direct (near) grab
const NEAR_EXIT = 0.2;
const MIN_RAY_HOLD_MS = 350;
const MIN_RAY_SWING = (4 * Math.PI) / 180;

const LABEL: Record<SurfaceKind, string> = { wall: 'Wall', desk: 'Desk', door: 'Door' };

let activeSystem: SurfaceSystem | undefined;
let nextSurfaceId = 1;

/** Map a WebXR plane semantic label (Quest or IWER) to a snap surface kind. */
export function surfaceKindForLabel(
  label: string | undefined,
  orientation: 'horizontal' | 'vertical',
  height: number,
): SurfaceKind | null {
  const l = (label ?? '').toLowerCase().trim();
  if (l.includes('door')) return 'door';
  if (l.includes('table') || l.includes('desk')) return orientation === 'horizontal' ? 'desk' : null;
  if (l === 'wall' || l === 'wall_face' || l === 'invisible_wall_face') {
    return orientation === 'vertical' ? 'wall' : null;
  }
  if (l === '' || l === 'other') {
    // Unlabelled planes: a big vertical one is a wall, a table-height one a desk.
    if (orientation === 'horizontal' && height >= 0.45 && height <= 1.15) return 'desk';
  }
  return null;
}

/** Last drop target computed for a held card (null = would float). */
export function getDropTarget(cardId: string): SnapTarget | null {
  return activeSystem?.getPreview(cardId) ?? null;
}

/** Animate a released card to its pinned pose. */
export function flyCard(entity: Entity, target: SnapTarget): void {
  activeSystem?.fly(entity, target);
}

export type SurfaceInfo = {
  surfaceId: string;
  kind: SurfaceKind;
  /** Semantic label of the room plane ('table', 'wall', ...) or the source for non-room surfaces. */
  label: string;
  origin: Vector3;
  quaternion: Quaternion;
};

/** World pose of a snap surface's own frame (normal = local +Y), or null. */
export function surfaceInfo(surfaceId: string): SurfaceInfo | null {
  return activeSystem?.info(surfaceId) ?? null;
}

/** All current snap surfaces with their world frames. */
export function allSurfaceInfo(): SurfaceInfo[] {
  return activeSystem?.infos() ?? [];
}

/** Pin target on the nearest surface of `kind` (else any surface) for a card, or null. */
export function autoPinTarget(card: Entity, kind: SurfaceKind): SnapTarget | null {
  return activeSystem?.autoTarget(card, kind) ?? null;
}

/** Gently light up every snap surface outline for `ms` (placement coach mark). */
export function glowSurfaces(ms: number): void {
  if (activeSystem !== undefined) activeSystem.glowUntil = performance.now() + ms;
}

/** Debug/test view of every snap surface (also on window.__questty in dev). */
export function listSurfaces(): Array<{ id: string; kind: SurfaceKind; source: string; position: number[]; normal: number[]; width: number; height: number }> {
  return activeSystem?.describe() ?? [];
}

export class SurfaceSystem extends createSystem({
  surfaces: { required: [SnapSurface] },
  planes: { required: [XRPlane] },
  cards: { required: [QuestCard] },
  held: { required: [QuestCard, Grabbed] },
}) {
  private frames: Frame[] = [];
  private blockers: Blocker[] = [];
  private framesAt = -1;
  private readonly previews = new Map<string, SnapTarget | null>();
  private readonly flights = new Map<Entity, Flight>();
  private readonly nearMode = new Map<Entity, boolean>();
  private readonly grabStarts = new Map<Entity, { at: number; dir: Vector3 }>();
  private virtualCreated = false;
  private fallbackTimer: number | undefined;
  private ghost!: Group;
  private ghostLabel!: Sprite;
  private ghostLabelCtx: CanvasRenderingContext2D | null = null;
  private ghostLabelTexture!: CanvasTexture;
  private ghostLabelText = '';
  private outlines = new Map<string, LineLoop>();
  private outlineRoot!: Group;
  private readonly m = new Matrix4();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpC = new Vector3();
  private readonly head = new Vector3();
  private readonly tmpQ = new Quaternion();
  private readonly handPoints = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];

  init(): void {
    activeSystem = this;
    const forceVirtual = new URLSearchParams(window.location.search).get('surfaces') === 'virtual';
    this.queries.planes.subscribe('qualify', (entity) => {
      if (!forceVirtual) this.tagPlane(entity);
    });
    if (!forceVirtual) for (const entity of this.queries.planes.entities) this.tagPlane(entity);
    this.queries.surfaces.subscribe('qualify', () => { this.framesAt = -1; });
    this.queries.surfaces.subscribe('disqualify', () => { this.framesAt = -1; });

    const onSessionStart = () => {
      window.clearTimeout(this.fallbackTimer);
      const features = this.xrManager.getSession()?.enabledFeatures ?? [];
      const delay = forceVirtual || !features.includes('plane-detection') ? 0 : 4000;
      this.fallbackTimer = window.setTimeout(() => this.ensureVirtualRoom(forceVirtual), delay);
    };
    this.xrManager.addEventListener('sessionstart', onSessionStart);
    if (this.xrManager.getSession() !== null) onSessionStart();

    this.createPreviewObjects();
    if (import.meta.env.DEV) {
      (window as unknown as { __questty?: object }).__questty = {
        listSurfaces,
        getDropTarget,
      };
    }
    this.cleanupFuncs.push(() => {
      this.xrManager.removeEventListener('sessionstart', onSessionStart);
      window.clearTimeout(this.fallbackTimer);
      if (activeSystem === this) activeSystem = undefined;
    });
  }

  glowUntil = 0;

  info(surfaceId: string): SurfaceInfo | null {
    this.refreshFrames(true);
    const frame = this.frames.find((f) => f.id === surfaceId);
    return frame === undefined ? null : this.frameInfo(frame);
  }

  infos(): SurfaceInfo[] {
    this.refreshFrames(true);
    return this.frames.map((f) => this.frameInfo(f));
  }

  private frameInfo(frame: Frame): SurfaceInfo {
    const object = frame.entity.object3D!;
    object.updateWorldMatrix(true, false);
    const quaternion = object.getWorldQuaternion(new Quaternion());
    let label = frame.entity.getValue(SnapSurface, 'source') as string;
    if (frame.entity.hasComponent(XRPlane)) {
      const plane = frame.entity.getValue(XRPlane, '_plane') as unknown as DetectedPlane | undefined;
      label = plane?.semanticLabel ?? label;
    }
    return { surfaceId: frame.id, kind: frame.kind, label, origin: frame.origin.clone(), quaternion };
  }

  autoTarget(card: Entity, kind: SurfaceKind): SnapTarget | null {
    this.refreshFrames(true);
    this.world.player.head.getWorldPosition(this.head);
    const forward = homeForward(this.world.player.head.getWorldDirection(this.tmpB).negate());
    forward.y = 0;
    forward.normalize();
    const ranked = this.frames
      .map((frame) => {
        // Prefer the requested kind, in front of the seat; others only as a last resort.
        const toFrame = this.tmpA.copy(frame.origin).sub(this.head).setY(0).normalize();
        const behind = toFrame.dot(forward) < 0.2 ? 10 : 0;
        return { frame, score: this.head.distanceTo(frame.origin) + (frame.kind === kind ? 0 : 5) + behind };
      })
      .sort((x, y) => x.score - y.score);
    const cardId = card.getValue(QuestCard, 'cardId') as string;
    let first: SnapTarget | null = null;
    for (const { frame } of ranked) {
      const point = frame.origin.clone();
      const target = this.placeOn(frame, point, cardId, 'near');
      if (!target.crowded) return target;
      first ??= target;
    }
    return first;
  }

  getPreview(cardId: string): SnapTarget | null {
    return this.previews.get(cardId) ?? null;
  }

  describe() {
    this.refreshFrames(true);
    return this.frames.map((f) => ({
      id: f.id,
      kind: f.kind,
      source: f.entity.getValue(SnapSurface, 'source') as string,
      position: f.origin.toArray().map((n) => +n.toFixed(3)),
      normal: f.normal.toArray().map((n) => +n.toFixed(3)),
      width: +f.width.toFixed(2),
      height: +f.height.toFixed(2),
    }));
  }

  fly(entity: Entity, target: SnapTarget): void {
    const object = entity.object3D;
    if (object == null) return;
    object.updateWorldMatrix(true, false);
    this.flights.set(entity, {
      from: object.getWorldPosition(new Vector3()),
      to: target.position.clone(),
      qFrom: object.getWorldQuaternion(new Quaternion()),
      qTo: target.quaternion.clone(),
      sFrom: object.scale.x,
      sTo: target.scale,
      startedAt: performance.now(),
    });
  }

  update(delta: number, time: number): void {
    this.updateFlights();
    this.updateGrabModes();
    const held = this.queries.held.entities;
    for (const card of this.grabStarts.keys()) if (!held.has(card)) this.grabStarts.delete(card);
    if (held.size === 0) {
      if (this.previews.size > 0) this.previews.clear();
      this.setPreviewVisible(false);
      this.updateGlow();
      if (time - this.framesAt > 1) this.refreshFrames(true, time);
      return;
    }
    this.refreshFrames(false, time);
    this.world.player.head.getWorldPosition(this.head);
    let shown: SnapTarget | null = null;
    for (const card of held) {
      const cardId = card.getValue(QuestCard, 'cardId') as string;
      const target = this.computeTarget(card);
      this.previews.set(cardId, target);
      if (shown === null && target !== null) shown = target;
    }
    this.showPreview(shown);
  }

  // ---------------------------------------------------------------- surfaces

  private tagPlane(entity: Entity): void {
    if (entity.hasComponent(SnapSurface)) return;
    const plane = entity.getValue(XRPlane, '_plane') as unknown as DetectedPlane | undefined;
    if (plane === undefined) return;
    const { width, height } = polygonExtent(plane.polygon);
    const object = entity.object3D;
    if (object == null) return;
    object.updateWorldMatrix(true, false);
    const y = object.getWorldPosition(this.tmpA).y;
    const kind = surfaceKindForLabel(plane.semanticLabel, plane.orientation, y);
    if (kind === null) return;
    entity.addComponent(SnapSurface, {
      kind,
      width,
      height,
      source: 'room',
      surfaceId: `room-${nextSurfaceId++}`,
    });
  }

  private ensureVirtualRoom(force: boolean): void {
    if (this.virtualCreated) return;
    const hasRoom = [...this.queries.surfaces.entities].some(
      (e) => e.getValue(SnapSurface, 'source') !== 'virtual',
    );
    if (hasRoom && !force) return;
    this.virtualCreated = true;
    console.info('[surfaces] No room planes: using the virtual room surfaces.');
    // Seated user at the origin looking down -Z.
    const specs: Array<{ kind: SurfaceKind; pos: [number, number, number]; normal: [number, number, number]; w: number; h: number }> = [
      { kind: 'wall', pos: [0.3, 1.35, -2.6], normal: [0, 0, 1], w: 2.6, h: 1.8 },
      { kind: 'door', pos: [-1.55, 1.03, -2.58], normal: [0, 0, 1], w: 0.85, h: 2.06 },
      { kind: 'wall', pos: [2.0, 1.35, -0.6], normal: [-1, 0, 0], w: 2.6, h: 1.8 },
      { kind: 'desk', pos: [0, 0.72, -0.85], normal: [0, 1, 0], w: 1.3, h: 0.6 },
    ];
    for (const spec of specs) {
      const fill = new Mesh(
        new PlaneGeometry(spec.w, spec.h),
        new MeshBasicMaterial({
          color: spec.kind === 'door' ? 0x8a6a4a : spec.kind === 'desk' ? 0x6b5a48 : 0xd9d2c5,
          transparent: true,
          opacity: 0.55,
          side: DoubleSide,
        }),
      );
      fill.rotation.x = -Math.PI / 2; // PlaneGeometry lies in XY; the frame wants XZ.
      const group = new Group();
      group.add(fill);
      group.name = `Virtual ${LABEL[spec.kind]}`;
      group.position.set(...spec.pos);
      group.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...spec.normal));
      const entity = this.world.createTransformEntity(group);
      entity.addComponent(SnapSurface, {
        kind: spec.kind,
        width: spec.w,
        height: spec.h,
        source: 'virtual',
        surfaceId: `virtual-${nextSurfaceId++}`,
      });
    }
  }

  private refreshFrames(force: boolean, time = 0): void {
    if (!force && this.framesAt >= 0 && time - this.framesAt < 0.5) return;
    this.framesAt = time;
    const frames: Frame[] = [];
    for (const entity of this.queries.surfaces.entities) {
      const object = entity.object3D;
      if (object == null) continue;
      // Room planes can grow as the headset scans; keep their extent fresh.
      if (entity.hasComponent(XRPlane)) {
        const plane = entity.getValue(XRPlane, '_plane') as unknown as DetectedPlane | undefined;
        if (plane !== undefined) {
          const ext = polygonExtent(plane.polygon);
          entity.setValue(SnapSurface, 'width', ext.width);
          entity.setValue(SnapSurface, 'height', ext.height);
        }
      }
      object.updateWorldMatrix(true, false);
      const e = object.matrixWorld.elements;
      const origin = new Vector3(e[12], e[13], e[14]);
      const u = new Vector3(e[0], e[1], e[2]).normalize();
      const normal = new Vector3(e[4], e[5], e[6]).normalize();
      const v = new Vector3(e[8], e[9], e[10]).normalize();
      const kind = entity.getValue(SnapSurface, 'kind') as SurfaceKind;
      if (kind !== 'desk') {
        // Walls and doors must face into the room (toward the user).
        this.world.player.head.getWorldPosition(this.head);
        if (normal.dot(this.tmpA.copy(this.head).sub(origin)) < 0) normal.negate();
      } else if (normal.y < 0) normal.negate();
      frames.push({
        entity,
        id: (entity.getValue(SnapSurface, 'surfaceId') as string) || `surface-${entity.index}`,
        kind,
        origin,
        normal,
        u,
        v,
        width: entity.getValue(SnapSurface, 'width') as number,
        height: entity.getValue(SnapSurface, 'height') as number,
      });
    }
    this.frames = frames;
    // Floors, ceilings and couches stop a pinch-ray: pointing at them drops
    // the card where it is instead of snapping to a wall behind.
    const blockers: Blocker[] = [];
    for (const entity of this.queries.planes.entities) {
      if (entity.hasComponent(SnapSurface)) continue;
      const plane = entity.getValue(XRPlane, '_plane') as unknown as DetectedPlane | undefined;
      const object = entity.object3D;
      if (plane === undefined || object == null || plane.orientation !== 'horizontal') continue;
      object.updateWorldMatrix(true, false);
      const e = object.matrixWorld.elements;
      const ext = polygonExtent(plane.polygon);
      blockers.push({
        origin: new Vector3(e[12], e[13], e[14]),
        u: new Vector3(e[0], e[1], e[2]).normalize(),
        normal: new Vector3(e[4], e[5], e[6]).normalize(),
        v: new Vector3(e[8], e[9], e[10]).normalize(),
        width: ext.width,
        height: ext.height,
      });
    }
    this.blockers = blockers;
    this.syncOutlines();
  }

  // ----------------------------------------------------------- snap targets

  private computeTarget(card: Entity): SnapTarget | null {
    const object = card.object3D;
    if (object == null || this.frames.length === 0) return null;
    object.updateWorldMatrix(true, false);
    const center = object.getWorldPosition(new Vector3());
    const cardId = card.getValue(QuestCard, 'cardId') as string;

    // 1. Near drop: the card itself is within a hand-span of a surface.
    let best: { frame: Frame; point: Vector3; distance: number } | null = null;
    for (const frame of this.frames) {
      const toCard = this.tmpA.copy(center).sub(frame.origin);
      const d = toCard.dot(frame.normal);
      if (d < -0.06 || d > NEAR_SNAP_DISTANCE) continue;
      const pu = toCard.dot(frame.u);
      const pv = toCard.dot(frame.v);
      if (Math.abs(pu) > frame.width / 2 + BOUNDS_MARGIN || Math.abs(pv) > frame.height / 2 + BOUNDS_MARGIN) continue;
      const distance = Math.abs(d);
      if (best === null || distance < best.distance) {
        best = { frame, point: center.clone().addScaledVector(frame.normal, -d), distance };
      }
    }
    if (best !== null) return this.placeOn(best.frame, best.point, cardId, 'near');

    // 2. Pinch-ray (distance) grab: snap to the surface the hand points at.
    if (!card.hasComponent(DistanceGrabbable)) return null;
    const hand = this.world.getSystem(GrabSystem)?.getHolderHand(card);
    if (hand == null) return null;
    const raySpace = this.world.player.raySpaces[hand];
    raySpace.updateWorldMatrix(true, false);
    const origin = raySpace.getWorldPosition(new Vector3());
    const dir = new Vector3(0, 0, -1).applyQuaternion(raySpace.getWorldQuaternion(this.tmpQ)).normalize();
    // A quick pinch on a card (a tap) must not fling it to the wall behind it:
    // the ray has to be held a moment and swung a few degrees first.
    let start = this.grabStarts.get(card);
    if (start === undefined) {
      start = { at: performance.now(), dir: dir.clone() };
      this.grabStarts.set(card, start);
    }
    if (performance.now() - start.at < MIN_RAY_HOLD_MS || start.dir.angleTo(dir) < MIN_RAY_SWING) return null;
    let hit: { frame: Frame; point: Vector3; t: number } | null = null;
    for (const frame of this.frames) {
      const t = rayPlane(origin, dir, frame.origin, frame.normal);
      if (t === null || t > RAY_MAX || (hit !== null && t >= hit.t)) continue;
      const p = origin.clone().addScaledVector(dir, t);
      const rel = this.tmpB.copy(p).sub(frame.origin);
      if (Math.abs(rel.dot(frame.u)) > frame.width / 2 + 0.02 || Math.abs(rel.dot(frame.v)) > frame.height / 2 + 0.02) continue;
      hit = { frame, point: p, t };
    }
    if (hit === null) return null;
    for (const b of this.blockers) {
      const t = rayPlane(origin, dir, b.origin, b.normal);
      if (t === null || t >= hit.t - 0.02) continue;
      const rel = this.tmpB.copy(origin).addScaledVector(dir, t).sub(b.origin);
      if (Math.abs(rel.dot(b.u)) <= b.width / 2 && Math.abs(rel.dot(b.v)) <= b.height / 2) return null;
    }
    return this.placeOn(hit.frame, hit.point, cardId, 'ray');
  }

  private liesOn(object: NonNullable<Entity['object3D']>, frame: Frame): boolean {
    if ((object.parent ?? null) === null) return false;
    const rel = object.getWorldPosition(this.tmpC).sub(frame.origin);
    return (
      Math.abs(rel.dot(frame.normal)) < 0.15 &&
      Math.abs(rel.dot(frame.u)) <= frame.width / 2 + 0.05 &&
      Math.abs(rel.dot(frame.v)) <= frame.height / 2 + 0.05
    );
  }

  /** Flush, upright, non-overlapping pose for a card dropped at `point` on `frame`. */
  private placeOn(frame: Frame, point: Vector3, cardId: string, via: 'near' | 'ray', maxScale = 0.28): SnapTarget {
    this.world.player.head.getWorldPosition(this.head);
    const distance = this.head.distanceTo(point);
    // Bigger the farther away it is (readable from the seat), but never wider
    // or taller than the surface it sits on.
    const fit = Math.min(
      (Math.max(frame.width, frame.height) - 0.04) / CARD_UNITS_W,
      (Math.min(frame.width, frame.height) - 0.04) / CARD_UNITS_H / (frame.kind === 'desk' ? Math.cos(DESK_TILT) : 1),
    );
    const scale = Math.max(0.08, Math.min(maxScale, fit, Math.max(PINNED_NEAR_SCALE, distance * 0.07)));
    const w = CARD_UNITS_W * scale;
    const h = CARD_UNITS_H * scale;

    // Card axes in world space.
    const xAxis = new Vector3();
    const yAxis = new Vector3();
    const zAxis = new Vector3();
    let footprintH = h; // card extent along the surface's "up" direction
    let lift = SURFACE_GAP;
    // In-surface "up" for the grid: world up for walls/doors, away-from-user on desks.
    const gridUp = new Vector3();
    if (frame.kind === 'desk') {
      const away = this.tmpA.copy(point).sub(this.head);
      away.addScaledVector(frame.normal, -away.dot(frame.normal));
      if (away.lengthSq() < 1e-4) away.copy(frame.v);
      away.normalize();
      zAxis.copy(frame.normal).multiplyScalar(Math.cos(DESK_TILT)).addScaledVector(away, -Math.sin(DESK_TILT));
      yAxis.copy(frame.normal).multiplyScalar(Math.sin(DESK_TILT)).addScaledVector(away, Math.cos(DESK_TILT));
      xAxis.crossVectors(yAxis, zAxis).normalize();
      footprintH = h * Math.cos(DESK_TILT);
      lift = SURFACE_GAP + (h / 2) * Math.sin(DESK_TILT);
      gridUp.copy(away);
    } else {
      zAxis.copy(frame.normal);
      yAxis.set(0, 1, 0).addScaledVector(zAxis, -zAxis.y).normalize();
      xAxis.crossVectors(yAxis, zAxis).normalize();
      gridUp.copy(yAxis);
    }
    const gridRight = new Vector3().crossVectors(gridUp, frame.normal).normalize();

    // Work in surface coordinates (a = along gridRight, b = along gridUp).
    const rel = this.tmpB.copy(point).sub(frame.origin);
    let a = rel.dot(gridRight);
    let b = rel.dot(gridUp);
    // Half extents of the surface along gridRight / gridUp (axes may be rotated).
    const halfA = Math.abs(gridRight.dot(frame.u)) * frame.width / 2 + Math.abs(gridRight.dot(frame.v)) * frame.height / 2;
    const halfB = Math.abs(gridUp.dot(frame.u)) * frame.width / 2 + Math.abs(gridUp.dot(frame.v)) * frame.height / 2;
    const clampA = (x: number) => (halfA <= w / 2 ? 0 : Math.max(-halfA + w / 2, Math.min(halfA - w / 2, x)));
    const clampB = (x: number) => (halfB <= footprintH / 2 ? 0 : Math.max(-halfB + footprintH / 2, Math.min(halfB - footprintH / 2, x)));
    a = clampA(a);
    b = clampB(b);

    // Other cards already on this surface, in the same coordinates.
    const others: Array<{ a: number; b: number; w: number; h: number }> = [];
    for (const other of this.queries.cards.entities) {
      if (other.getValue(QuestCard, 'cardId') === cardId) continue;
      if (other.hasComponent(QuestCardTween)) continue;
      const o = other.object3D;
      if (o == null) continue;
      // Same surface id, or (restored cards whose plane got a new id) lying on this frame.
      if (other.getValue(QuestCard, 'surfaceId') !== frame.id && !this.liesOn(o, frame)) continue;
      const flight = this.flights.get(other);
      const op = flight ? flight.to.clone() : o.getWorldPosition(new Vector3());
      const os = flight ? flight.sTo : o.scale.x;
      const r = op.sub(frame.origin);
      others.push({
        // A pinned card carries its focus panel on its right: reserve that space too.
        a: r.dot(gridRight) + (FOCUS_PANEL_UNITS * os + 0.015) / 2,
        b: r.dot(gridUp),
        w: (CARD_UNITS_W + FOCUS_PANEL_UNITS) * os + 0.015,
        h: CARD_UNITS_H * os * (frame.kind === 'desk' ? Math.cos(DESK_TILT) : 1),
      });
    }
    const panelExtra = FOCUS_PANEL_UNITS * scale + 0.015;
    const fw = w + panelExtra;
    const free = (ca: number, cb: number) =>
      others.every(
        (o) => Math.abs(o.a - (ca + panelExtra / 2)) >= (o.w + fw) / 2 + CARD_GAP - 1e-4 || Math.abs(o.b - cb) >= (o.h + footprintH) / 2 + CARD_GAP - 1e-4,
      );
    let crowded = false;
    if (!free(a, b)) {
      const stepA = fw + CARD_GAP;
      const stepB = footprintH + CARD_GAP;
      let bestScore = Infinity;
      let found: [number, number] | null = null;
      for (let ring = 1; ring <= 4 && found === null; ring += 1) {
        for (let i = -ring; i <= ring; i += 1) {
          for (let j = -ring; j <= ring; j += 1) {
            if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
            const ca = clampA(a + i * stepA);
            const cb = clampB(b + j * stepB);
            if (!free(ca, cb)) continue;
            const score = (ca - a) ** 2 + (cb - b) ** 2;
            if (score < bestScore) {
              bestScore = score;
              found = [ca, cb];
            }
          }
        }
      }
      if (found !== null) [a, b] = found;
      // A small desk full of big cards: try again with smaller cards before overlapping.
      else if (scale > 0.09) return this.placeOn(frame, point, cardId, via, scale * 0.7);
      else crowded = true;
    }

    const position = frame.origin
      .clone()
      .addScaledVector(gridRight, a)
      .addScaledVector(gridUp, b)
      .addScaledVector(frame.normal, lift);
    this.m.makeBasis(xAxis, yAxis, zAxis);
    const quaternion = new Quaternion().setFromRotationMatrix(this.m);
    return { surfaceId: frame.id, kind: frame.kind, label: LABEL[frame.kind], position, quaternion, scale, via, crowded };
  }

  // ------------------------------------------------- near vs pinch-ray grab

  /**
   * IWSDK gives an entity one grab handle: OneHandGrabbable (direct grab with
   * the hand / grip) or DistanceGrabbable (pinch-ray). A card switches to the
   * direct grab while a hand is within ~12 cm of it and back to the pinch-ray
   * when the hand leaves, so near cards are grabbed directly and far cards by
   * pointing. Held or animating cards are never switched.
   */
  private updateGrabModes(): void {
    const player = this.world.player;
    const spaces = [
      player.indexTipSpaces.left, player.indexTipSpaces.right,
      player.gripSpaces.left, player.gripSpaces.right,
      player.raySpaces.left, player.raySpaces.right,
    ];
    let count = 0;
    for (const o of spaces) {
      o.getWorldPosition(this.handPoints[count]);
      count += 1;
    }
    for (const card of this.queries.cards.entities) {
      if (card.hasComponent(Grabbed) || card.hasComponent(QuestCardTween) || this.flights.has(card)) continue;
      const object = card.object3D;
      if (object == null) continue;
      object.updateWorldMatrix(true, false);
      const s = object.scale.x;
      let nearest = Infinity;
      for (let i = 0; i < count; i += 1) {
        const local = this.tmpC.copy(this.handPoints[i]);
        object.worldToLocal(local);
        const dx = Math.max(Math.abs(local.x) - CARD_UNITS_W / 2, 0) * s;
        const dy = Math.max(Math.abs(local.y) - CARD_UNITS_H / 2, 0) * s;
        const dz = Math.abs(local.z) * s;
        nearest = Math.min(nearest, Math.hypot(dx, dy, dz));
      }
      const wasNear = this.nearMode.get(card);
      const near = wasNear === true ? nearest < NEAR_EXIT : nearest < NEAR_ENTER;
      if (near !== wasNear || !hasGrabbable(card)) {
        setGrabMode(card, near ? 'near' : 'ray');
        this.nearMode.set(card, near);
      }
    }
  }

  // --------------------------------------------------------------- visuals

  private createPreviewObjects(): void {
    this.ghost = new Group();
    this.ghost.name = 'Snap Preview';
    const fill = new Mesh(
      new PlaneGeometry(CARD_UNITS_W, CARD_UNITS_H),
      new MeshBasicMaterial({ color: 0x5fe0c8, transparent: true, opacity: 0.28, depthWrite: false, side: DoubleSide }),
    );
    const edge = new LineLoop(
      new BufferGeometry().setFromPoints([
        new Vector3(-CARD_UNITS_W / 2, -CARD_UNITS_H / 2, 0.01),
        new Vector3(CARD_UNITS_W / 2, -CARD_UNITS_H / 2, 0.01),
        new Vector3(CARD_UNITS_W / 2, CARD_UNITS_H / 2, 0.01),
        new Vector3(-CARD_UNITS_W / 2, CARD_UNITS_H / 2, 0.01),
      ]),
      new LineBasicMaterial({ color: 0xb7fff3 }),
    );
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    this.ghostLabelCtx = canvas.getContext('2d');
    this.ghostLabelTexture = new CanvasTexture(canvas);
    this.ghostLabel = new Sprite(
      new SpriteMaterial({ map: this.ghostLabelTexture, transparent: true, depthTest: false }),
    );
    this.ghostLabel.position.set(0, CARD_UNITS_H / 2 + 0.45, 0.05);
    this.ghostLabel.scale.set(3.2, 0.6, 1);
    this.ghost.add(fill, edge, this.ghostLabel);
    this.ghost.visible = false;
    this.world.createTransformEntity(this.ghost);
    this.outlineRoot = new Group();
    this.outlineRoot.name = 'Snap Surface Outlines';
    this.outlineRoot.visible = false;
    this.world.createTransformEntity(this.outlineRoot);
  }

  /** Coach-mark glow: outlines pulse softly while no card is held. */
  private updateGlow(): void {
    const now = performance.now();
    if (now >= this.glowUntil) {
      if (this.glowing) {
        this.glowing = false;
        this.outlineRoot.visible = false;
      }
      return;
    }
    this.glowing = true;
    this.outlineRoot.visible = true;
    const opacity = 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(now / 260));
    for (const line of this.outlines.values()) {
      const material = line.material as LineBasicMaterial;
      material.color.setHex(0x5fe0c8);
      material.opacity = opacity;
    }
  }

  private glowing = false;

  private setPreviewVisible(visible: boolean): void {
    if (this.ghost.visible !== visible) this.ghost.visible = visible;
    if (this.outlineRoot.visible !== visible) this.outlineRoot.visible = visible;
  }

  private showPreview(target: SnapTarget | null): void {
    this.outlineRoot.visible = true;
    for (const [id, line] of this.outlines) {
      const material = line.material as LineBasicMaterial;
      const active = target !== null && target.surfaceId === id;
      material.color.setHex(active ? 0xffe27a : 0x5fe0c8);
      material.opacity = active ? 1 : 0.45;
    }
    if (target === null) {
      this.ghost.visible = false;
      return;
    }
    this.ghost.visible = true;
    this.ghost.position.copy(target.position);
    this.ghost.quaternion.copy(target.quaternion);
    this.ghost.scale.setScalar(target.scale);
    const text = `Release to pin to ${target.label}`;
    if (text !== this.ghostLabelText && this.ghostLabelCtx !== null) {
      const c = this.ghostLabelCtx;
      c.clearRect(0, 0, 512, 96);
      c.fillStyle = 'rgba(10, 40, 38, 0.85)';
      c.fillRect(0, 0, 512, 96);
      c.fillStyle = '#eafffa';
      c.font = 'bold 40px sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(text, 256, 48, 496);
      this.ghostLabelTexture.needsUpdate = true;
      this.ghostLabelText = text;
    }
  }

  /** Faint outline on every snap surface, shown only while a card is held. */
  private syncOutlines(): void {
    const seen = new Set<string>();
    for (const frame of this.frames) {
      seen.add(frame.id);
      let line = this.outlines.get(frame.id);
      if (line === undefined) {
        line = new LineLoop(
          new BufferGeometry(),
          new LineBasicMaterial({ color: 0x5fe0c8, transparent: true, opacity: 0.45, depthTest: true }),
        );
        line.name = `Snap Outline ${frame.id}`;
        this.outlineRoot.add(line);
        this.outlines.set(frame.id, line);
      }
      const hw = frame.width / 2 - 0.01;
      const hh = frame.height / 2 - 0.01;
      const lift = frame.normal.clone().multiplyScalar(0.006);
      const corner = (su: number, sv: number) =>
        frame.origin.clone().addScaledVector(frame.u, su * hw).addScaledVector(frame.v, sv * hh).add(lift);
      line.geometry.setFromPoints([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]);
    }
    for (const [id, line] of this.outlines) {
      if (seen.has(id)) continue;
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
      line.removeFromParent();
      this.outlines.delete(id);
    }
  }

  private updateFlights(): void {
    if (this.flights.size === 0) return;
    const now = performance.now();
    for (const [entity, f] of this.flights) {
      const object = entity.object3D;
      if (object == null || !entity.active || entity.hasComponent(Grabbed)) {
        this.flights.delete(entity);
        continue;
      }
      const t = Math.min(1, (now - f.startedAt) / FLIGHT_MS);
      const k = 1 - (1 - t) ** 3;
      setWorld(object, this.tmpA.copy(f.from).lerp(f.to, k), this.tmpQ.copy(f.qFrom).slerp(f.qTo, k));
      object.scale.setScalar(f.sFrom + (f.sTo - f.sFrom) * k);
      if (t >= 1) this.flights.delete(entity);
    }
  }
}

// ------------------------------------------------------------------ helpers

function polygonExtent(polygon: readonly { x: number; z: number }[]): { width: number; height: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return Number.isFinite(minX) ? { width: maxX - minX, height: maxZ - minZ } : { width: 0, height: 0 };
}

function rayPlane(origin: Vector3, dir: Vector3, p0: Vector3, n: Vector3): number | null {
  const denom = dir.dot(n);
  if (Math.abs(denom) < 1e-4) return null;
  const t = (p0.x - origin.x) * n.x + (p0.y - origin.y) * n.y + (p0.z - origin.z) * n.z;
  const d = t / denom;
  return d > 0.05 ? d : null;
}

const parentQ = new Quaternion();
const localP = new Vector3();
function setWorld(object: NonNullable<Entity['object3D']>, position: Vector3, quaternion: Quaternion): void {
  if (object.parent == null) {
    object.position.copy(position);
    object.quaternion.copy(quaternion);
    return;
  }
  object.parent.updateWorldMatrix(true, false);
  object.position.copy(object.parent.worldToLocal(localP.copy(position)));
  object.parent.getWorldQuaternion(parentQ);
  object.quaternion.copy(quaternion).premultiply(parentQ.invert());
}

/** Place a card at a world pose right away (used for spawning and floating drops). */
export function setCardWorldPose(entity: Entity, position: Vector3, quaternion: Quaternion, scale: number): void {
  const object = entity.object3D;
  if (object == null) return;
  setWorld(object, position, quaternion);
  object.scale.setScalar(scale);
}

function hasGrabbable(card: Entity): boolean {
  return card.hasComponent(OneHandGrabbable) || card.hasComponent(DistanceGrabbable);
}

/** Swap a card between direct (near) grab and pinch-ray (distance) grab. */
export function setGrabMode(card: Entity, mode: 'near' | 'ray'): void {
  if (card.hasComponent(Grabbed)) return;
  const want = mode === 'near' ? OneHandGrabbable : DistanceGrabbable;
  if (card.hasComponent(want)) return;
  if (card.hasComponent(OneHandGrabbable)) card.removeComponent(OneHandGrabbable);
  if (card.hasComponent(DistanceGrabbable)) card.removeComponent(DistanceGrabbable);
  // GrabSystem creates one Handle per entity and skips entities that already
  // have one, so drop the old handle (it is not exported; find it by id).
  for (const component of card.getComponents()) {
    if ((component as { id?: string }).id === 'Handle') card.removeComponent(component);
  }
  if (mode === 'near') {
    card.addComponent(OneHandGrabbable, { rotate: true, translate: true });
  } else {
    card.addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveFromTarget,
      rotate: false,
      scale: false,
      translate: true,
    });
  }
}

export { FLOAT_CARD_SCALE };
