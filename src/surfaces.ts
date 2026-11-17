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
import { QuestCard, QuestCardTween, SnapSurface } from './quest-component.js';
import { setCardFade, syncCardDecor } from './card-decor.js';
import { getSettings } from './settings.js';
/** PR 10: a pin with reduced motion is a 300 ms fade out + fade in, no flight. */
const REDUCED_FADE_MS = 300;
import { playTap } from './focus-store.js';

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
  /** Preview wording ('pin to' for cards; the flame says 'mount on' / 'stand on'). */
  verb?: string;
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
  /** Centre of the plane's polygon extent in plane-local coords (x along u, z along v). */
  cx: number;
  cz: number;
  /** Plane polygon (plane-local), or null for a plain rectangle centred on the origin. */
  poly: readonly { x: number; z: number }[] | null;
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
  /** Surface normal the card settles along (null: no settle, e.g. a restore). */
  normal: Vector3 | null;
  tapped: boolean;
};

const SURFACE_GAP = 0.0025; // metres between card and surface (flush, no z-fighting)
const EDGE_INSET = 0.015; // keep a pinned card this far inside the surface's edges
const SETTLE_LIFT = 0.012; // the flight ends this far off the surface, then settles in
const SETTLE_MS = 150;
const NEAR_SNAP_DISTANCE = 0.22; // card centre to surface, for a near drop
const BOUNDS_MARGIN = 0.12;
const RAY_MAX = 8;
const CARD_GAP = 0.03;
const PINNED_NEAR_SCALE = 0.12;
const FLIGHT_MS = 260;
/** Width of a card's focus panel (focus-action.uikitml, 200px) in card units. */
const FOCUS_PANEL_UNITS = 2.0;
const NEAR_ENTER = 0.12; // hand within this of a card -> direct (near) grab
const NEAR_EXIT = 0.2;
const MIN_RAY_HOLD_MS = 350;
const MIN_RAY_SWING = (4 * Math.PI) / 180;

const LABEL: Record<SurfaceKind, string> = { wall: 'Wall', desk: 'Desk', door: 'Door' };

let activeSystem: SurfaceSystem | undefined;
/** Dev only: why the last non-card surface pick (the flame's) found nothing, or which surface it hit. */
let devHitWhy = '';
let nextSurfaceId = 1;

/** Map a WebXR plane semantic label (Quest or IWER) to a snap surface kind. */
/**
 * Things standing on a surface that a pinned card must not cover (PR 9: the
 * streak flame, on a desk or a wall). Keyed by owner; a box around `p`
 * (world) of half-size `r` across and `rUp` along the card's up there.
 */
const obstacles = new Map<string, { p: Vector3; r: number; rUp: number }>();

/**
 * Register (or with `p` null, clear) an obstacle cards are placed around.
 * `r` is its half-size across; `rUp` (default `r`) its half-size along the
 * card's up on that surface (a wall-mounted flame is taller than it is wide).
 */
export function setSurfaceObstacle(id: string, p: Vector3 | null, r = 0, rUp = r): void {
  if (p === null) {
    obstacles.delete(id);
    return;
  }
  const o = obstacles.get(id);
  if (o !== undefined) {
    o.p.copy(p);
    o.r = r;
    o.rUp = rUp;
  } else obstacles.set(id, { p: p.clone(), r, rUp });
}

/** Where a held object (PR 9: the streak flame) would land: a surface, a point on its plane, near drop or pinch-ray. */
export type SurfaceHit = { surface: SurfaceFrame; point: Vector3; via: 'near' | 'ray' };

/**
 * Near-drop band per surface kind: how far below / above (along the normal)
 * the object may be. `null`: that kind is picked only by the pinch-ray; a
 * kind left out is never picked.
 */
export type NearBand = Partial<Record<SurfaceKind, [number, number] | null>>;

/**
 * The same surface pick a held card uses (near drop first, then the surface
 * the holding hand's pinch-ray points at, after the same hold-and-swing
 * guard, stopped by floors and couches), for any grabbed entity at `center`.
 * Null: it would float.
 */
export function surfaceHitFor(entity: Entity, center: Vector3, band: NearBand): SurfaceHit | null {
  return activeSystem?.hitFor(entity, center, band) ?? null;
}

/**
 * Show the snap preview (surface outlines, a ghost and its label) for a held
 * object that is not a card. Null hides it. Card previews take precedence.
 */
export function setExternalPreview(target: SnapTarget | null): void {
  externalPreview = target;
}
let externalPreview: SnapTarget | null = null;

/**
 * A spot on a wall/door near `point` where a box (half-width `halfW`,
 * `down` below and `up` above the spot, along the wall's up) is inside the
 * surface and clear of the pinned cards there (and their focus panels) by
 * `gap`. Returns the spot on the plane, or null when the surface is gone.
 */
export function freeSpotOn(surfaceId: string, point: Vector3, halfW: number, down: number, up: number, gap: number): Vector3 | null {
  return activeSystem?.freeSpot(surfaceId, point, halfW, down, up, gap) ?? null;
}

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

/**
 * The surface a card lands on when it is let go: the held preview, or, for a
 * fast drop whose preview trails the hand by a frame, a near drop from where
 * the card is now or where its last frame of motion carries it.
 */
export function landingTarget(card: Entity, handPoint?: Vector3): SnapTarget | null {
  const cardId = card.getValue(QuestCard, 'cardId') as string;
  const held = landingHints.get(cardId);
  if (held !== undefined) {
    landingHints.delete(cardId);
    return held;
  }
  return getDropTarget(cardId) ?? activeSystem?.nearLanding(card, handPoint) ?? null;
}

const landingHints = new Map<string, SnapTarget>();
/** Hand the release a landing already worked out (by the finish check, from the hand) for this card. */
export function holdLanding(cardId: string, target: SnapTarget): void {
  landingHints.set(cardId, target);
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

export type SpatialSurface = {
  id: string;
  kind: SurfaceKind;
  /** Semantic label ('wall', 'table', 'door', ...) or the source for virtual surfaces. */
  label: string;
  /** Centre of the plane's polygon, in world space. */
  center: Vector3;
  /** Into the room (walls/doors face the head; desks face up). */
  normal: Vector3;
  width: number;
  height: number;
};

/** Every snap surface with its centre and inward normal (PR 7: spatial buddy tools). */
export function spatialSurfaces(): SpatialSurface[] {
  return activeSystem?.spatial() ?? [];
}

export type SurfaceFrame = SpatialSurface & { u: Vector3; v: Vector3 };

/** PR 9: every snap surface with its in-plane axes (u along width, v along height). */
export function surfaceFrames(): SurfaceFrame[] {
  return activeSystem?.spatialFrames() ?? [];
}

/**
 * Where a card would land on one surface near `point`: the same conforming,
 * no-overlap placement a hand drop uses (flush, inside the polygon, beside
 * cards already there). Null when the surface is gone.
 */
export function snapTargetOn(surfaceId: string, point: Vector3, cardId: string): SnapTarget | null {
  return activeSystem?.targetOn(surfaceId, point, cardId) ?? null;
}

/**
 * PR 7: flush poses for several cards lined up on one surface (the buddy's
 * arrange): one shared scale, one neat row centred near `point` (wrapping to
 * more rows only when a single row would make the cards too small), clear of
 * every other card already there. Null when the surface is gone.
 */
export function rowTargetsOn(surfaceId: string, point: Vector3, cardIds: string[]): SnapTarget[] | null {
  return activeSystem?.rowOn(surfaceId, point, cardIds) ?? null;
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
  /** Each held card's centre one frame ago (for a fast drop's landing). */
  private readonly heldCenters = new Map<string, Vector3>();
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
        pinnedFit: () => this.pinnedFit(),
        hitWhy: () => devHitWhy,
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

  spatialFrames(): SurfaceFrame[] {
    return this.spatial().map((surface, i) => ({ ...surface, u: this.frames[i].u.clone(), v: this.frames[i].v.clone() }));
  }

  spatial(): SpatialSurface[] {
    this.refreshFrames(true);
    return this.frames.map((f) => ({
      id: f.id,
      kind: f.kind,
      label: this.frameInfo(f).label,
      center: f.origin.clone().addScaledVector(f.u, f.cx).addScaledVector(f.v, f.cz),
      normal: f.normal.clone(),
      width: f.width,
      height: f.height,
    }));
  }

  targetOn(surfaceId: string, point: Vector3, cardId: string): SnapTarget | null {
    this.refreshFrames(true);
    const frame = this.frames.find((f) => f.id === surfaceId);
    return frame === undefined ? null : this.placeOn(frame, point, cardId, 'ray');
  }

  rowOn(surfaceId: string, point: Vector3, cardIds: string[]): SnapTarget[] | null {
    this.refreshFrames(true);
    const frame = this.frames.find((f) => f.id === surfaceId);
    if (frame === undefined || cardIds.length === 0) return null;
    return this.placeRow(frame, point, cardIds);
  }

  getPreview(cardId: string): SnapTarget | null {
    return this.previews.get(cardId) ?? null;
  }

  /**
   * Near drop only (no pinch-ray pick), from the card's pose now, one frame of
   * its motion ahead and, for a card held in the hand (not by a pinch-ray),
   * the hand itself: a held card trails a fast hand by a few frames.
   */
  nearLanding(card: Entity, handPoint?: Vector3): SnapTarget | null {
    const object = card.object3D;
    if (object == null) return null;
    if (this.frames.length === 0) this.refreshFrames(true);
    object.updateWorldMatrix(true, false);
    const now = object.getWorldPosition(new Vector3());
    const cardId = card.getValue(QuestCard, 'cardId') as string;
    const last = this.heldCenters.get(cardId);
    const ahead = last === undefined ? null : now.clone().add(now.clone().sub(last));
    const band: NearBand = { wall: [0.06, NEAR_SNAP_DISTANCE], desk: [0.06, NEAR_SNAP_DISTANCE], door: [0.06, NEAR_SNAP_DISTANCE] };
    const points = ahead === null ? [now] : [now, ahead];
    if (handPoint !== undefined && !card.hasComponent(DistanceGrabbable)) points.push(handPoint);
    for (const p of points) {
      const hit = this.findHit(card, p, band);
      if (hit !== null && hit.via === 'near') return this.placeOn(hit.frame, hit.point, cardId, 'near');
    }
    return null;
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
      normal: new Vector3(0, 0, 1).applyQuaternion(target.quaternion),
      tapped: false,
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
    syncCardDecor(this.queries.cards.entities);
    this.updateGrabModes();
    const held = this.queries.held.entities;
    for (const e of this.grabStarts.keys()) if (!e.active || !e.hasComponent(Grabbed)) this.grabStarts.delete(e);
    if (held.size === 0) {
      if (this.previews.size > 0) this.previews.clear();
      if (this.heldCenters.size > 0) this.heldCenters.clear();
      if (externalPreview !== null) {
        this.refreshFrames(false, time);
        this.showPreview(externalPreview);
        return;
      }
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
      const c = this.heldCenters.get(cardId) ?? new Vector3();
      card.object3D?.getWorldPosition(c);
      this.heldCenters.set(cardId, c);
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
      let cx = 0;
      let cz = 0;
      let poly: Frame['poly'] = null;
      if (entity.hasComponent(XRPlane)) {
        const plane = entity.getValue(XRPlane, '_plane') as unknown as DetectedPlane | undefined;
        if (plane !== undefined) {
          const ext = polygonExtent(plane.polygon);
          entity.setValue(SnapSurface, 'width', ext.width);
          entity.setValue(SnapSurface, 'height', ext.height);
          cx = ext.cx;
          cz = ext.cz;
          poly = plane.polygon.length >= 3 ? plane.polygon.map((p) => ({ x: p.x, z: p.z })) : null;
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
        cx,
        cz,
        poly,
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
      const bu = new Vector3(e[0], e[1], e[2]).normalize();
      const bv = new Vector3(e[8], e[9], e[10]).normalize();
      blockers.push({
        origin: new Vector3(e[12], e[13], e[14]).addScaledVector(bu, ext.cx).addScaledVector(bv, ext.cz),
        u: bu,
        normal: new Vector3(e[4], e[5], e[6]).normalize(),
        v: bv,
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
    const hit = this.findHit(card, center, null);
    return hit === null ? null : this.placeOn(hit.frame, hit.point, cardId, hit.via);
  }

  hitFor(entity: Entity, center: Vector3, band: NearBand): SurfaceHit | null {
    if (this.frames.length === 0) this.refreshFrames(true);
    const hit = this.findHit(entity, center, band);
    if (hit === null) return null;
    const f = hit.frame;
    return {
      surface: {
        id: f.id,
        kind: f.kind,
        label: this.frameInfo(f).label,
        center: f.origin.clone().addScaledVector(f.u, f.cx).addScaledVector(f.v, f.cz),
        normal: f.normal.clone(),
        width: f.width,
        height: f.height,
        u: f.u.clone(),
        v: f.v.clone(),
      },
      point: hit.point,
      via: hit.via,
    };
  }

  /**
   * The surface a held entity would land on. 1. Near drop: the entity is
   * within a hand-span of a surface (cards: 6 cm behind to 22 cm in front;
   * `band` overrides it per kind and leaves out kinds it does not name).
   * 2. Pinch-ray grab: the surface the holding hand points at.
   */
  private findHit(entity: Entity, center: Vector3, band: NearBand | null): { frame: Frame; point: Vector3; via: 'near' | 'ray' } | null {
    if (this.frames.length === 0) return null;
    const frames = band === null ? this.frames : this.frames.filter((f) => band[f.kind] !== undefined);
    let best: { frame: Frame; point: Vector3; distance: number } | null = null;
    for (const frame of frames) {
      const range = band === null ? [0.06, NEAR_SNAP_DISTANCE] : band[frame.kind];
      if (range == null) continue;
      const [below, above] = range;
      const toCard = this.tmpA.copy(center).sub(frame.origin);
      const d = toCard.dot(frame.normal);
      if (d < -below || d > above) continue;
      const pu = toCard.dot(frame.u) - frame.cx;
      const pv = toCard.dot(frame.v) - frame.cz;
      if (Math.abs(pu) > frame.width / 2 + BOUNDS_MARGIN || Math.abs(pv) > frame.height / 2 + BOUNDS_MARGIN) continue;
      const distance = Math.abs(d);
      if (best === null || distance < best.distance) {
        best = { frame, point: center.clone().addScaledVector(frame.normal, -d), distance };
      }
    }
    if (best !== null) return { frame: best.frame, point: best.point, via: 'near' };

    // 2. Pinch-ray (distance) grab: snap to the surface the hand points at.
    const why = (w: string | (() => string)) => {
      if (import.meta.env.DEV && band !== null) devHitWhy = typeof w === 'string' ? w : w();
      return null;
    };
    if (!entity.hasComponent(DistanceGrabbable)) return why('no-distance-grab');
    const hand = this.world.getSystem(GrabSystem)?.getHolderHand(entity);
    if (hand == null) return why('no-holder-hand');
    const raySpace = this.world.player.raySpaces[hand];
    raySpace.updateWorldMatrix(true, false);
    const origin = raySpace.getWorldPosition(new Vector3());
    const dir = new Vector3(0, 0, -1).applyQuaternion(raySpace.getWorldQuaternion(this.tmpQ)).normalize();
    // A quick pinch on a card (a tap) must not fling it to the wall behind it:
    // the ray has to be held a moment and swung a few degrees first.
    let start = this.grabStarts.get(entity);
    if (start === undefined) {
      start = { at: performance.now(), dir: dir.clone() };
      this.grabStarts.set(entity, start);
    }
    if (performance.now() - start.at < MIN_RAY_HOLD_MS || start.dir.angleTo(dir) < MIN_RAY_SWING) return why(() => `guard ${(performance.now() - start.at).toFixed(0)}ms ${((start.dir.angleTo(dir) * 180) / Math.PI).toFixed(1)}deg`);
    let hit: { frame: Frame; point: Vector3; t: number } | null = null;
    for (const frame of frames) {
      const t = rayPlane(origin, dir, frame.origin, frame.normal);
      if (t === null || t > RAY_MAX || (hit !== null && t >= hit.t)) continue;
      const p = origin.clone().addScaledVector(dir, t);
      const rel = this.tmpB.copy(p).sub(frame.origin);
      if (Math.abs(rel.dot(frame.u) - frame.cx) > frame.width / 2 + 0.02 || Math.abs(rel.dot(frame.v) - frame.cz) > frame.height / 2 + 0.02) continue;
      hit = { frame, point: p, t };
    }
    if (hit === null) return why(() => `no-surface o=${origin.toArray().map((x) => x.toFixed(2))} d=${dir.toArray().map((x) => x.toFixed(2))} n=${frames.length}`);
    for (const b of this.blockers) {
      const t = rayPlane(origin, dir, b.origin, b.normal);
      if (t === null || t >= hit.t - 0.02) continue;
      const rel = this.tmpB.copy(origin).addScaledVector(dir, t).sub(b.origin);
      if (Math.abs(rel.dot(b.u)) <= b.width / 2 && Math.abs(rel.dot(b.v)) <= b.height / 2) return why('blocked');
    }
    why(() => `ray ${hit!.frame.id}`);
    return { frame: hit.frame, point: hit.point, via: 'ray' };
  }

  /** Pinned cards on `frame` (and their focus panels) as boxes in the card grid's coordinates. */
  private cardBoxes(frame: Frame, right: Vector3, up: Vector3, skip: (cardId: string) => boolean): Array<{ a: number; b: number; w: number; h: number }> {
    const out: Array<{ a: number; b: number; w: number; h: number }> = [];
    for (const other of this.queries.cards.entities) {
      if (skip(other.getValue(QuestCard, 'cardId') as string)) continue;
      if (other.hasComponent(QuestCardTween)) continue;
      const o = other.object3D;
      if (o == null) continue;
      if (other.getValue(QuestCard, 'surfaceId') !== frame.id && !this.liesOn(o, frame)) continue;
      const flight = this.flights.get(other);
      const op = flight ? flight.to.clone() : o.getWorldPosition(new Vector3());
      const os = flight ? flight.sTo : o.scale.x;
      const r = op.sub(frame.origin);
      out.push({
        a: r.dot(right) + (FOCUS_PANEL_UNITS * os + 0.015) / 2,
        b: r.dot(up),
        w: (CARD_UNITS_W + FOCUS_PANEL_UNITS) * os + 0.015,
        h: CARD_UNITS_H * os,
      });
    }
    return out;
  }

  freeSpot(surfaceId: string, point: Vector3, halfW: number, down: number, up: number, gap: number): Vector3 | null {
    if (this.frames.length === 0) this.refreshFrames(true);
    const frame = this.frames.find((f) => f.id === surfaceId);
    if (frame === undefined) return null;
    this.world.player.head.getWorldPosition(this.head);
    const { xAxis, yAxis } = this.cardAxes(frame);
    const boxes = this.cardBoxes(frame, xAxis, yAxis, () => false);
    const ru = xAxis.dot(frame.u);
    const rv = xAxis.dot(frame.v);
    const uu = yAxis.dot(frame.u);
    const uv = yAxis.dot(frame.v);
    const halfA = Math.abs(ru) * frame.width / 2 + Math.abs(rv) * frame.height / 2 - EDGE_INSET;
    const halfB = Math.abs(uu) * frame.width / 2 + Math.abs(uv) * frame.height / 2 - EDGE_INSET;
    const cA = frame.cx * ru + frame.cz * rv;
    const cB = frame.cx * uu + frame.cz * uv;
    const clampA = (x: number) => (halfA <= halfW ? cA : Math.max(cA - halfA + halfW, Math.min(cA + halfA - halfW, x)));
    const clampB = (x: number) => (2 * halfB <= down + up ? cB : Math.max(cB - halfB + down, Math.min(cB + halfB - up, x)));
    const rel = this.tmpB.copy(point).sub(frame.origin);
    const a0 = clampA(rel.dot(xAxis));
    const b0 = clampB(rel.dot(yAxis));
    const midOff = (up - down) / 2;
    const hh = (up + down) / 2;
    const free = (a: number, b: number) =>
      boxes.every((o) => Math.abs(o.a - a) >= (o.w / 2 + halfW + gap) - 1e-4 || Math.abs(o.b - (b + midOff)) >= (o.h / 2 + hh + gap) - 1e-4);
    let a = a0;
    let b = b0;
    if (!free(a, b)) {
      let found: [number, number] | null = null;
      let bestScore = Infinity;
      const step = 0.04;
      for (let ring = 1; ring <= 40 && found === null; ring += 1) {
        for (let i = -ring; i <= ring; i += 1) {
          for (let j = -ring; j <= ring; j += 1) {
            if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
            const ca = clampA(a0 + i * step);
            const cb = clampB(b0 + j * step);
            if (!free(ca, cb)) continue;
            const score = (ca - a0) ** 2 + (cb - b0) ** 2;
            if (score < bestScore) {
              bestScore = score;
              found = [ca, cb];
            }
          }
        }
      }
      if (found !== null) [a, b] = found;
    }
    return frame.origin.clone().addScaledVector(xAxis, a).addScaledVector(yAxis, b);
  }

  private liesOn(object: NonNullable<Entity['object3D']>, frame: Frame): boolean {
    if ((object.parent ?? null) === null) return false;
    const rel = object.getWorldPosition(this.tmpC).sub(frame.origin);
    return (
      Math.abs(rel.dot(frame.normal)) < 0.15 &&
      Math.abs(rel.dot(frame.u) - frame.cx) <= frame.width / 2 + 0.05 &&
      Math.abs(rel.dot(frame.v) - frame.cz) <= frame.height / 2 + 0.05
    );
  }

  /**
   * In-surface "up" for a card on a desk: perpendicular to the desk edge
   * nearest the user, pointing away from them, so the card reads straight on.
   */
  private deskUp(frame: Frame): Vector3 {
    const rel = this.tmpA.copy(this.head).sub(frame.origin);
    const hu = rel.dot(frame.u) - frame.cx;
    const hv = rel.dot(frame.v) - frame.cz;
    // How far the head is beyond each edge (largest = the edge the user faces).
    const candidates: Array<[number, Vector3]> = [
      [hu - frame.width / 2, frame.u],
      [-hu - frame.width / 2, frame.u.clone().negate()],
      [hv - frame.height / 2, frame.v],
      [-hv - frame.height / 2, frame.v.clone().negate()],
    ];
    candidates.sort((x, y) => y[0] - x[0]);
    return candidates[0][1].clone().negate().normalize();
  }

  /**
   * Flush pose for a card dropped at `point` on `frame`: lying in the plane
   * (normal = the plane's own normal), axis-aligned to it (text upright to
   * gravity on walls and doors; on desks square to the edge nearest the
   * user), ~2.5 mm off it, fully inside its polygon, not overlapping others.
   */
  private placeOn(frame: Frame, point: Vector3, cardId: string, via: 'near' | 'ray', maxScale = 0.28): SnapTarget {
    this.world.player.head.getWorldPosition(this.head);
    const distance = this.head.distanceTo(point);

    // Card axes in world space: +Z is the surface normal, +Y the text's up.
    const zAxis = frame.normal.clone();
    const yAxis = new Vector3();
    if (frame.kind === 'desk') {
      yAxis.copy(this.deskUp(frame));
    } else {
      yAxis.set(0, 1, 0).addScaledVector(zAxis, -zAxis.y);
      if (yAxis.lengthSq() < 1e-4) yAxis.copy(frame.v);
      yAxis.normalize();
    }
    const xAxis = new Vector3().crossVectors(yAxis, zAxis).normalize();
    const gridRight = xAxis;
    const gridUp = yAxis;

    // Surface extent along the card's axes, around the polygon's centre.
    const ru = gridRight.dot(frame.u);
    const rv = gridRight.dot(frame.v);
    const uu = gridUp.dot(frame.u);
    const uv = gridUp.dot(frame.v);
    const halfA = Math.abs(ru) * frame.width / 2 + Math.abs(rv) * frame.height / 2 - EDGE_INSET;
    const halfB = Math.abs(uu) * frame.width / 2 + Math.abs(uv) * frame.height / 2 - EDGE_INSET;
    const cA = frame.cx * ru + frame.cz * rv;
    const cB = frame.cx * uu + frame.cz * uv;

    // Bigger the farther away it is (readable from the seat), never bigger than the surface.
    // On a desk one card may take at most ~2/3 of it, so a second card still fits beside it.
    const fit = Math.min((2 * halfA) / CARD_UNITS_W, (2 * halfB) / CARD_UNITS_H) * (frame.kind === 'desk' ? 0.65 : 1);
    let scale = Math.max(0.06, Math.min(maxScale, fit, Math.max(PINNED_NEAR_SCALE, distance * 0.07)));
    // A door is narrow: centre the card on it, small enough that its focus panel fits beside it.
    const centred = frame.kind === 'door';
    if (centred) {
      const groupFit = (halfA - 0.015) / (CARD_UNITS_W / 2 + FOCUS_PANEL_UNITS);
      if (groupFit >= 0.08) scale = Math.min(scale, groupFit);
    }
    const w = CARD_UNITS_W * scale;
    const h = CARD_UNITS_H * scale;
    const panelExtra = FOCUS_PANEL_UNITS * scale + 0.015;
    const groupFits = w + panelExtra <= 2 * halfA;

    const clampA = (x: number) => {
      if (centred) return cA;
      const lo = cA - halfA + w / 2;
      const hi = cA + halfA - w / 2 - (groupFits ? panelExtra : 0);
      return hi < lo ? cA : Math.max(lo, Math.min(hi, x));
    };
    const clampB = (x: number) => (halfB <= h / 2 ? cB : Math.max(cB - halfB + h / 2, Math.min(cB + halfB - h / 2, x)));

    const rel = this.tmpB.copy(point).sub(frame.origin);
    let a = clampA(rel.dot(gridRight));
    let b = clampB(rel.dot(gridUp));

    // Other cards already on this surface (same surface id, or restored cards
    // lying on this frame), in the same coordinates, each with its focus panel on its right.
    const others = this.cardBoxes(frame, gridRight, gridUp, (id) => id === cardId);
    this.addObstacles(frame, gridRight, gridUp, others);
    const fw = w + panelExtra;
    const free = (ca: number, cb: number) =>
      others.every(
        (o) => Math.abs(o.a - (ca + panelExtra / 2)) >= (o.w + fw) / 2 + CARD_GAP - 1e-4 || Math.abs(o.b - cb) >= (o.h + h) / 2 + CARD_GAP - 1e-4,
      );
    let crowded = false;
    if (!free(a, b)) {
      const stepA = fw + CARD_GAP;
      const stepB = h + CARD_GAP;
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
      else if (scale > 0.065) return this.placeOn(frame, point, cardId, via, scale * 0.75);
      else crowded = true;
    }

    // An irregular polygon (an L-shaped desk, a notched wall): all four corners
    // must be on it. Nudge toward the middle, then shrink a little.
    const toLocal = (ca: number, cb: number) => ({
      x: ca * ru + cb * uu,
      z: ca * rv + cb * uv,
    });
    const cornersInside = (ca: number, cb: number, cw: number, ch: number) =>
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([sa, sb]) => {
        const l = toLocal(ca + (sa * cw) / 2, cb + (sb * ch) / 2);
        return insideFrame(frame, l.x, l.z);
      });
    if (!cornersInside(a, b, w, h)) {
      let fixed = false;
      for (let k = 1; k <= 10 && !fixed; k += 1) {
        const na = a + (cA - a) * (k / 10);
        const nb = b + (cB - b) * (k / 10);
        if (cornersInside(na, nb, w, h)) {
          a = na;
          b = nb;
          fixed = true;
        }
      }
      if (!fixed && scale > 0.07 && maxScale > 0.07) return this.placeOn(frame, point, cardId, via, scale * 0.85);
    }

    const position = frame.origin
      .clone()
      .addScaledVector(gridRight, a)
      .addScaledVector(gridUp, b)
      .addScaledVector(frame.normal, SURFACE_GAP);
    this.m.makeBasis(xAxis, yAxis, zAxis);
    const quaternion = new Quaternion().setFromRotationMatrix(this.m);
    return { surfaceId: frame.id, kind: frame.kind, label: LABEL[frame.kind], position, quaternion, scale, via, crowded };
  }

  /** Obstacles standing on `frame` (the lantern), as square boxes in the card grid's coordinates. */
  private addObstacles(frame: Frame, right: Vector3, up: Vector3, out: Array<{ a: number; b: number; w: number; h: number }>): void {
    for (const { p, r, rUp } of obstacles.values()) {
      const rel = new Vector3().copy(p).sub(frame.origin);
      const off = rel.dot(frame.normal);
      if (off < -0.03 || off > 0.08) continue;
      if (!insideFrame(frame, rel.dot(frame.u), rel.dot(frame.v), Math.max(r, rUp))) continue;
      out.push({ a: rel.dot(right), b: rel.dot(up), w: 2 * r, h: 2 * rUp });
    }
  }

  /** Card axes on a frame (+Z the surface normal, +Y the text's up), like placeOn. */
  private cardAxes(frame: Frame): { xAxis: Vector3; yAxis: Vector3; zAxis: Vector3 } {
    const zAxis = frame.normal.clone();
    const yAxis = new Vector3();
    if (frame.kind === 'desk') {
      yAxis.copy(this.deskUp(frame));
    } else {
      yAxis.set(0, 1, 0).addScaledVector(zAxis, -zAxis.y);
      if (yAxis.lengthSq() < 1e-4) yAxis.copy(frame.v);
      yAxis.normalize();
    }
    const xAxis = new Vector3().crossVectors(yAxis, zAxis).normalize();
    return { xAxis, yAxis, zAxis };
  }

  /**
   * A row (or a few rows) of cards on one frame, all at one scale, each with
   * room for its focus panel on its right. Rows stay level (one height per
   * row), the block stays inside the polygon and clear of the other cards on
   * the surface; it shrinks before it would overlap or spill over an edge.
   */
  private placeRow(frame: Frame, point: Vector3, cardIds: string[]): SnapTarget[] {
    this.world.player.head.getWorldPosition(this.head);
    const n = cardIds.length;
    const { xAxis, yAxis, zAxis } = this.cardAxes(frame);
    const ru = xAxis.dot(frame.u);
    const rv = xAxis.dot(frame.v);
    const uu = yAxis.dot(frame.u);
    const uv = yAxis.dot(frame.v);
    const halfA = Math.abs(ru) * frame.width / 2 + Math.abs(rv) * frame.height / 2 - EDGE_INSET;
    const halfB = Math.abs(uu) * frame.width / 2 + Math.abs(uv) * frame.height / 2 - EDGE_INSET;
    const cA = frame.cx * ru + frame.cz * rv;
    const cB = frame.cx * uu + frame.cz * uv;
    const distance = this.head.distanceTo(point);
    const wanted = Math.max(0.06, Math.min(0.28, Math.max(PINNED_NEAR_SCALE, distance * 0.07)));
    // Slot = card + its focus panel + gap; row pitch = card height + gap.
    const slotW = (s: number) => (CARD_UNITS_W + FOCUS_PANEL_UNITS) * s + 0.015 + CARD_GAP;
    const rowH = (s: number) => CARD_UNITS_H * s + CARD_GAP;
    const fitScale = (perRow: number, rows: number) =>
      Math.min(
        wanted,
        (2 * halfA + CARD_GAP - 0.015 * perRow - CARD_GAP * perRow) / ((CARD_UNITS_W + FOCUS_PANEL_UNITS) * perRow),
        (2 * halfB + CARD_GAP - CARD_GAP * rows) / (CARD_UNITS_H * rows),
      );
    // Fewest rows that keep the cards at least ~80 % of the best possible size.
    let rows = 1;
    let bestScale = -Infinity;
    for (let r = 1; r <= n; r += 1) bestScale = Math.max(bestScale, fitScale(Math.ceil(n / r), r));
    for (let r = 1; r <= n; r += 1) {
      if (fitScale(Math.ceil(n / r), r) >= Math.min(wanted, bestScale) * 0.8) {
        rows = r;
        break;
      }
    }
    let scale = Math.max(0.05, fitScale(Math.ceil(n / rows), rows));

    // Other cards on this surface (not the ones being lined up).
    const mine = new Set(cardIds);
    const others = this.cardBoxes(frame, xAxis, yAxis, (id) => mine.has(id));
    this.addObstacles(frame, xAxis, yAxis, others);
    const toLocal = (ca: number, cb: number) => ({ x: ca * ru + cb * uu, z: ca * rv + cb * uv });
    const rel = this.tmpB.copy(point).sub(frame.origin);
    const aimA = rel.dot(xAxis);
    const aimB = rel.dot(yAxis);

    const layout = (s: number, shiftB: number) => {
      const perRow = Math.ceil(n / rows);
      const sw = slotW(s);
      const rh = rowH(s);
      const blockW = perRow * sw - CARD_GAP;
      const blockH = rows * rh - CARD_GAP;
      const centreA = blockW / 2 >= halfA ? cA : Math.max(cA - halfA + blockW / 2, Math.min(cA + halfA - blockW / 2, aimA));
      const lowB = cB - halfB + blockH / 2;
      const highB = cB + halfB - blockH / 2;
      const centreB = highB < lowB ? cB : Math.max(lowB, Math.min(highB, aimB + shiftB));
      const slots: Array<{ a: number; b: number }> = [];
      for (let i = 0; i < n; i += 1) {
        const row = Math.floor(i / perRow);
        const inRow = Math.min(perRow, n - row * perRow);
        const col = i % perRow;
        const groupA = centreA + (col - (inRow - 1) / 2) * sw;
        // Card centre sits left of the group centre (its focus panel is on its right).
        const a = groupA - (FOCUS_PANEL_UNITS * s + 0.015) / 2;
        const b = centreB + blockH / 2 - CARD_UNITS_H * s / 2 - row * rh;
        slots.push({ a, b });
      }
      const w = CARD_UNITS_W * s;
      const h = CARD_UNITS_H * s;
      const panelExtra = FOCUS_PANEL_UNITS * s + 0.015;
      const clear = slots.every(({ a, b }) =>
        others.every(
          (o) =>
            Math.abs(o.a - (a + panelExtra / 2)) >= (o.w + w + panelExtra) / 2 + CARD_GAP - 1e-4 ||
            Math.abs(o.b - b) >= (o.h + h) / 2 + CARD_GAP - 1e-4,
        ),
      );
      const inside = slots.every(({ a, b }) =>
        [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([sa, sb]) => {
          const l = toLocal(a + (sa * w) / 2, b + (sb * h) / 2);
          return insideFrame(frame, l.x, l.z);
        }),
      );
      return { slots, clear, inside };
    };

    let chosen: ReturnType<typeof layout> | null = null;
    for (let attempt = 0; attempt < 8 && chosen === null; attempt += 1) {
      const rh = rowH(scale);
      // Try the aimed height first, then step the whole block down/up a row at a time.
      for (const k of [0, -1, 1, -2, 2, -3, 3]) {
        const l = layout(scale, k * rh);
        if (l.clear && l.inside) {
          chosen = l;
          break;
        }
      }
      if (chosen === null) scale *= 0.85;
    }
    chosen ??= layout(scale, 0);

    this.m.makeBasis(xAxis, yAxis, zAxis);
    const quaternion = new Quaternion().setFromRotationMatrix(this.m);
    return chosen.slots.map(({ a, b }) => ({
      surfaceId: frame.id,
      kind: frame.kind,
      label: LABEL[frame.kind],
      position: frame.origin.clone().addScaledVector(xAxis, a).addScaledVector(yAxis, b).addScaledVector(frame.normal, SURFACE_GAP),
      quaternion: quaternion.clone(),
      scale,
      via: 'ray' as const,
      crowded: !(chosen!.clear && chosen!.inside),
    }));
  }

  /**
   * Dev/test check: for every pinned card, the angle between its normal and
   * its surface's normal, how far it sits off the plane, and whether all
   * four corners are inside the plane's polygon.
   */
  pinnedFit(): Array<{ cardId: string; title: string; surfaceId: string; kind: string; angleDeg: number; gapMm: number; cornersInside: number; scale: number; upDotGravity: number | null }> {
    if (!import.meta.env.DEV) return [];
    this.refreshFrames(true);
    const out = [];
    for (const card of this.queries.cards.entities) {
      const surfaceId = card.getValue(QuestCard, 'surfaceId') as string;
      const o = card.object3D;
      if (surfaceId.length === 0 || o == null) continue;
      o.updateWorldMatrix(true, false);
      let frame = this.frames.find((f) => f.id === surfaceId);
      frame ??= this.frames.find((f) => this.liesOn(o, f));
      if (frame === undefined) continue;
      const e = o.matrixWorld.elements;
      const s = o.scale.x;
      const x = new Vector3(e[0], e[1], e[2]).normalize();
      const y = new Vector3(e[4], e[5], e[6]).normalize();
      const z = new Vector3(e[8], e[9], e[10]).normalize();
      const c = new Vector3(e[12], e[13], e[14]);
      let inside = 0;
      for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = c.clone().addScaledVector(x, (sa * CARD_UNITS_W * s) / 2).addScaledVector(y, (sb * CARD_UNITS_H * s) / 2).sub(frame.origin);
        if (insideFrame(frame, p.dot(frame.u), p.dot(frame.v), 0.001)) inside += 1;
      }
      out.push({
        cardId: card.getValue(QuestCard, 'cardId') as string,
        title: card.getValue(QuestCard, 'title') as string,
        surfaceId: frame.id,
        kind: frame.kind,
        angleDeg: +((z.angleTo(frame.normal) * 180) / Math.PI).toFixed(3),
        gapMm: +(c.clone().sub(frame.origin).dot(frame.normal) * 1000).toFixed(2),
        cornersInside: inside,
        scale: +s.toFixed(3),
        upDotGravity: frame.kind === 'desk' ? null : +y.y.toFixed(4),
      });
    }
    return out;
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
    const text = `Release to ${target.verb ?? 'pin to'} ${target.label}`;
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
        frame.origin
          .clone()
          .addScaledVector(frame.u, frame.cx + su * hw)
          .addScaledVector(frame.v, frame.cz + sv * hh)
          .add(lift);
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
      const elapsed = now - f.startedAt;
      if (getSettings().reducedMotion) {
        // PR 10, reduced motion: no flight. Fade out where it was, appear on the surface, fade in.
        const t = Math.min(1, elapsed / REDUCED_FADE_MS);
        if (t < 0.4) {
          setCardFade(object, 1 - t / 0.4);
          continue;
        }
        setWorld(object, f.to, f.qTo);
        object.scale.setScalar(f.sTo);
        setCardFade(object, (t - 0.4) / 0.6);
        if (f.normal !== null && !f.tapped) {
          f.tapped = true;
          playTap();
          pulseHaptics(this.xrManager.getSession());
        }
        if (t >= 1) {
          setCardFade(object, 1);
          this.flights.delete(entity);
        }
        continue;
      }
      // 1. Fly to just above the surface, already in its final orientation.
      const t = Math.min(1, elapsed / FLIGHT_MS);
      const k = 1 - (1 - t) ** 3;
      const hover = this.tmpB.copy(f.to);
      if (f.normal !== null) hover.addScaledVector(f.normal, SETTLE_LIFT);
      setWorld(object, this.tmpA.copy(f.from).lerp(hover, k), this.tmpQ.copy(f.qFrom).slerp(f.qTo, k));
      object.scale.setScalar(f.sFrom + (f.sTo - f.sFrom) * k);
      if (t < 1) continue;
      if (f.normal === null) {
        this.flights.delete(entity);
        continue;
      }
      // 2. Settle: a short ease down onto the surface, a soft tap and a light pulse.
      if (!f.tapped) {
        f.tapped = true;
        playTap();
        pulseHaptics(this.xrManager.getSession());
      }
      const st = Math.min(1, (elapsed - FLIGHT_MS) / SETTLE_MS);
      const sk = 1 - (1 - st) ** 2;
      setWorld(object, this.tmpA.copy(hover).lerp(f.to, sk), f.qTo);
      if (st >= 1) this.flights.delete(entity);
    }
  }
}

// ------------------------------------------------------------------ helpers

function polygonExtent(polygon: readonly { x: number; z: number }[]): { width: number; height: number; cx: number; cz: number } {
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
  return Number.isFinite(minX)
    ? { width: maxX - minX, height: maxZ - minZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 }
    : { width: 0, height: 0, cx: 0, cz: 0 };
}

/** Point-in-polygon (plane-local x/z), even-odd rule. */
function insidePolygon(poly: readonly { x: number; z: number }[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Is a plane-local point inside the frame's polygon (or its rectangle)? */
function insideFrame(frame: Frame, x: number, z: number, slack = 0.002): boolean {
  if (frame.poly !== null) {
    if (insidePolygon(frame.poly, x, z)) return true;
    // Allow a hair of slack on the boundary (floating point on the edges).
    return (
      insidePolygon(frame.poly, x - Math.sign(x - frame.cx) * slack, z - Math.sign(z - frame.cz) * slack)
    );
  }
  return Math.abs(x - frame.cx) <= frame.width / 2 + slack && Math.abs(z - frame.cz) <= frame.height / 2 + slack;
}

function rayPlane(origin: Vector3, dir: Vector3, p0: Vector3, n: Vector3): number | null {
  const denom = dir.dot(n);
  if (Math.abs(denom) < 1e-4) return null;
  const t = (p0.x - origin.x) * n.x + (p0.y - origin.y) * n.y + (p0.z - origin.z) * n.z;
  const d = t / denom;
  return d > 0.05 ? d : null;
}

/** A light haptic pulse on every controller that has an actuator (hands have none: skipped). */
function pulseHaptics(session: XRSession | null): void {
  if (session == null) return;
  try {
    for (const source of session.inputSources) {
      const actuator = (source.gamepad as (Gamepad & { hapticActuators?: Array<{ pulse?: (v: number, ms: number) => Promise<boolean> }> }) | undefined)
        ?.hapticActuators?.[0];
      void actuator?.pulse?.(0.25, 25)?.catch?.(() => undefined);
    }
  } catch {
    // Haptics are a nicety; never let them break a pin.
  }
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
