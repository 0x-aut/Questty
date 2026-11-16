import { createSystem, Grabbed, Quaternion, Vector3, type Entity, type World } from '@iwsdk/core';
import { loadCards, saveCards, type SavedCard, type SavedSurface, type Vec3, type Quat } from './card-store.js';
import {
  createQuestCard,
  onCardEvent,
  pinnedHint,
  repositionFocusAction,
  setQuestCardState,
  showFocusActionFor,
} from './quest-card.js';
import { QuestCard, QuestCardTween } from './quest-component.js';
import { allSurfaceInfo, setCardWorldPose, surfaceInfo, type SurfaceInfo } from './surfaces.js';

/*
 * Cards persist in the room across reloads and XR sessions (see card-store.ts).
 *
 * Anchors: WebXR Anchors (https://immersive-web.github.io/anchors/) plus Meta's
 * persistent handles in Quest Browser: anchor.requestPersistentHandle(),
 * session.restorePersistentAnchor(uuid), session.deletePersistentAnchor(uuid).
 * IWSDK's own XRAnchor component keeps one shared anchor for a whole group, so
 * cards use their own anchor each (one per pinned card) through raw WebXR here.
 * Like IWSDK's plane entities, the XR reference space is treated as world space.
 */

type AnchorLike = {
  anchorSpace: XRSpace;
  delete?: () => void;
  requestPersistentHandle?: () => Promise<string>;
};
type AnchorSession = XRSession & {
  restorePersistentAnchor?: (uuid: string) => Promise<AnchorLike>;
  deletePersistentAnchor?: (uuid: string) => Promise<void>;
};
type AnchorFrame = XRFrame & {
  createAnchor?: (pose: XRRigidTransform, space: XRSpace) => Promise<AnchorLike>;
};

export type RestoreVia = 'anchor' | 'surface' | 'pose';

const SURFACE_MATCH_M = 1.0;
const records = new Map<string, SavedCard>();
const restoredVia = new Map<string, RestoreVia>();

const v3 = (v: Vector3): Vec3 => [v.x, v.y, v.z];
const q4 = (q: Quaternion): Quat => [q.x, q.y, q.z, q.w];

/**
 * Re-create every saved card at its saved world pose (call once at startup).
 * Pinned cards come back pinned, with their focus control.
 */
export async function restoreSavedCards(): Promise<number> {
  records.clear();
  for (const card of loadCards()) records.set(card.id, card);
  let count = 0;
  for (const card of records.values()) {
    try {
      const entity = await createQuestCard({
        id: card.id,
        title: card.title,
        xp: card.xp,
        position: card.pose.position,
        restored: true,
      });
      setCardWorldPose(
        entity,
        new Vector3(...card.pose.position),
        new Quaternion(...card.pose.quaternion),
        card.pose.scale,
      );
      entity.setValue(QuestCard, 'userPlaced', true);
      if (card.zoneId !== '') {
        entity.setValue(QuestCard, 'zoneId', card.zoneId);
        entity.setValue(QuestCard, 'surfaceId', `restored-${card.zoneId}`);
        setQuestCardState(entity, pinnedHint(card.zoneId));
        showFocusActionFor(entity);
      } else {
        setQuestCardState(entity, 'Pinch it onto a wall, desk or door');
      }
      restoredVia.set(card.id, 'pose');
      count += 1;
    } catch (error) {
      console.warn('[persist] Could not restore a card.', error);
    }
  }
  if (count > 0) console.info(`[persist] Restored ${count} saved card(s).`);
  return count;
}

export class CardPersistenceSystem extends createSystem({
  cards: { required: [QuestCard] },
}) {
  /** Card ids waiting for an anchor (created inside the next XR frame). */
  private readonly pendingAnchors = new Set<string>();
  /** Live anchors this session, by card id; cards follow them while not held. */
  private readonly anchors = new Map<string, AnchorLike>();
  private readonly entities = new Map<string, Entity>();
  private refineTimer: number | undefined;
  private readonly p = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();

  init(): void {
    const off = onCardEvent((type, entity, detail) => {
      const id = entity.getValue(QuestCard, 'cardId') as string;
      if (type === 'created') {
        this.entities.set(id, entity);
        if (!detail.restored || !records.has(id)) this.save(entity, null);
      } else if (type === 'grabbed') {
        this.anchors.delete(id); // stop following; the old handle is dropped on release
      } else if (type === 'pinned') {
        this.save(entity, detail.target?.surfaceId ?? null);
        // Wait for the flight to land before anchoring the final pose.
        window.setTimeout(() => this.pendingAnchors.add(id), 350);
      } else if (type === 'floated') {
        this.save(entity, null);
        this.dropAnchor(id);
      } else if (type === 'completed' || type === 'removed') {
        this.entities.delete(id);
        this.pendingAnchors.delete(id);
        this.dropAnchor(id);
        if (records.delete(id)) saveCards(records.values());
        restoredVia.delete(id);
      }
    });

    const xr = this.world.renderer.xr;
    const onStart = () => {
      window.clearTimeout(this.refineTimer);
      // Room planes arrive a moment after the session starts.
      this.refineTimer = window.setTimeout(() => void this.refine(), 1_500);
    };
    const onEnd = () => {
      window.clearTimeout(this.refineTimer);
      this.anchors.clear();
      this.pendingAnchors.clear();
    };
    xr.addEventListener('sessionstart', onStart);
    xr.addEventListener('sessionend', onEnd);

    if (import.meta.env.DEV) {
      const w = window as unknown as { __questty?: Record<string, unknown> };
      w.__questty = {
        ...w.__questty,
        savedCards: () => [...records.values()],
        restoredVia: () => Object.fromEntries(restoredVia),
        anchorFeature: () => {
          const s = xr.getSession() as AnchorSession | null;
          return {
            enabled: s?.enabledFeatures?.includes('anchors') ?? false,
            persistent: typeof s?.restorePersistentAnchor === 'function',
            live: [...this.anchors.keys()],
          };
        },
      };
    }

    this.cleanupFuncs.push(off, () => {
      window.clearTimeout(this.refineTimer);
      xr.removeEventListener('sessionstart', onStart);
      xr.removeEventListener('sessionend', onEnd);
    });
  }

  update(): void {
    const xr = this.world.renderer.xr;
    const frame = xr.getFrame() as AnchorFrame | null;
    const space = xr.getReferenceSpace();
    if (frame == null || space == null) return;
    if (this.pendingAnchors.size > 0) {
      for (const id of this.pendingAnchors) this.createAnchor(frame, space, id);
      this.pendingAnchors.clear();
    }
    for (const [id, anchor] of this.anchors) {
      const entity = this.entities.get(id);
      const record = records.get(id);
      if (entity === undefined || !entity.active || record === undefined) continue;
      if (entity.hasComponent(Grabbed) || entity.hasComponent(QuestCardTween)) continue;
      let pose: XRPose | undefined;
      try {
        pose = frame.getPose(anchor.anchorSpace, space) ?? undefined;
      } catch {
        pose = undefined;
      }
      if (pose === undefined) continue;
      const t = pose.transform;
      this.p.set(t.position.x, t.position.y, t.position.z);
      this.q.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
      const object = entity.object3D;
      if (object == null) continue;
      object.updateWorldMatrix(true, false);
      object.getWorldPosition(this.s);
      if (this.s.distanceToSquared(this.p) < 0.004 * 0.004) continue;
      setCardWorldPose(entity, this.p, this.q, record.pose.scale);
      repositionFocusAction(entity);
    }
  }

  // ------------------------------------------------------------ saving

  private save(entity: Entity, surfaceId: string | null): void {
    const id = entity.getValue(QuestCard, 'cardId') as string;
    const object = entity.object3D;
    if (object == null || id.length === 0) return;
    object.updateWorldMatrix(true, false);
    const position = object.getWorldPosition(new Vector3());
    const quaternion = object.getWorldQuaternion(new Quaternion());
    // Pinned cards save where they will land (the flight target), not mid-flight.
    let scale = object.scale.x;
    const zone = (entity.getValue(QuestCard, 'zoneId') as string) as SavedCard['zoneId'];
    const previous = records.get(id);
    const record: SavedCard = {
      id,
      title: entity.getValue(QuestCard, 'title') as string,
      xp: entity.getValue(QuestCard, 'xp') as number,
      state: 'active',
      createdAt: previous?.createdAt ?? Date.now(),
      zoneId: zone === 'wall' || zone === 'desk' || zone === 'door' ? zone : '',
      pose: { position: v3(position), quaternion: q4(quaternion), scale },
      anchor: previous?.anchor,
    };
    if (surfaceId !== null) {
      // Re-read after the flight lands so the pose and the plane offset are final.
      window.setTimeout(() => {
        if (!entity.active || entity.getValue(QuestCard, 'surfaceId') !== surfaceId) return;
        object.updateWorldMatrix(true, false);
        object.getWorldPosition(position);
        object.getWorldQuaternion(quaternion);
        scale = object.scale.x;
        record.pose = { position: v3(position), quaternion: q4(quaternion), scale };
        const info = surfaceInfo(surfaceId);
        if (info !== null) record.surface = toSurfaceRecord(info, position, quaternion);
        records.set(id, record);
        saveCards(records.values());
      }, 340);
    }
    records.set(id, record);
    saveCards(records.values());
  }

  // ------------------------------------------------------------ anchors

  private createAnchor(frame: AnchorFrame, space: XRReferenceSpace, id: string): void {
    const entity = this.entities.get(id);
    const object = entity?.object3D;
    if (entity === undefined || object == null || typeof frame.createAnchor !== 'function') return;
    if ((entity.getValue(QuestCard, 'zoneId') as string).length === 0) return;
    object.updateWorldMatrix(true, false);
    const p = object.getWorldPosition(new Vector3());
    const q = object.getWorldQuaternion(new Quaternion());
    const session = this.world.renderer.xr.getSession() as AnchorSession | null;
    let transform: XRRigidTransform;
    try {
      transform = new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w });
    } catch {
      return;
    }
    const oldHandle = records.get(id)?.anchor;
    frame
      .createAnchor(transform, space)
      .then(async (anchor) => {
        const record = records.get(id);
        if (record === undefined || !entity.active || this.world.renderer.xr.getSession() !== session) {
          anchor.delete?.();
          return;
        }
        this.anchors.set(id, anchor);
        let handle: string | undefined;
        if (typeof anchor.requestPersistentHandle === 'function') {
          handle = await anchor.requestPersistentHandle().catch(() => undefined);
        }
        if (oldHandle !== undefined && oldHandle !== handle) {
          void session?.deletePersistentAnchor?.(oldHandle).catch(() => undefined);
        }
        record.anchor = handle;
        saveCards(records.values());
        console.info(`[persist] Anchored ${id}${handle ? ' (persistent)' : ' (this session only)'}.`);
      })
      .catch((error: unknown) => console.warn('[persist] Anchor creation failed; plane/pose fallback stays.', error));
  }

  private dropAnchor(id: string): void {
    const anchor = this.anchors.get(id);
    this.anchors.delete(id);
    anchor?.delete?.();
    const record = records.get(id);
    const handle = record?.anchor;
    if (handle === undefined) return;
    if (record !== undefined) record.anchor = undefined;
    const session = this.world.renderer.xr.getSession() as AnchorSession | null;
    void session?.deletePersistentAnchor?.(handle).catch(() => undefined);
    saveCards(records.values());
  }

  // ------------------------------------------------------------ restore

  /** After a session starts: put each saved card back by anchor, else by plane, else by pose. */
  private async refine(attempt = 0): Promise<void> {
    const session = this.world.renderer.xr.getSession() as AnchorSession | null;
    if (session === null) return;
    const surfaces = allSurfaceInfo();
    const needsPlanes = [...records.values()].some((r) => r.surface !== undefined);
    if (needsPlanes && surfaces.length === 0 && attempt < 6) {
      // Room planes (or the virtual room) are not in yet: try again shortly.
      this.refineTimer = window.setTimeout(() => void this.refine(attempt + 1), 1_000);
      return;
    }
    for (const record of records.values()) {
      const entity = this.entities.get(record.id);
      if (entity === undefined || !entity.active || entity.hasComponent(Grabbed)) continue;
      let via: RestoreVia = 'pose';
      if (record.anchor !== undefined && typeof session.restorePersistentAnchor === 'function') {
        try {
          const anchor = await session.restorePersistentAnchor(record.anchor);
          this.anchors.set(record.id, anchor);
          via = 'anchor';
        } catch (error) {
          console.warn(`[persist] Persistent anchor for ${record.id} not restored; using the plane.`, error);
          record.anchor = undefined;
        }
      }
      const match = record.surface !== undefined ? matchSurface(record.surface, surfaces) : null;
      if (via !== 'anchor' && match !== null && record.surface !== undefined) {
        const world = fromSurface(match, record.surface);
        setCardWorldPose(entity, world.position, world.quaternion, record.pose.scale);
        via = 'surface';
      }
      if (match !== null) entity.setValue(QuestCard, 'surfaceId', match.surfaceId);
      if (record.zoneId !== '') {
        repositionFocusAction(entity);
        // Re-anchor cards that had no (or a lost) persistent anchor.
        if (via !== 'anchor') this.pendingAnchors.add(record.id);
      }
      restoredVia.set(record.id, via);
    }
    saveCards(records.values());
    console.info('[persist] Card restore:', JSON.stringify(Object.fromEntries(restoredVia)));
  }
}

function toSurfaceRecord(info: SurfaceInfo, position: Vector3, quaternion: Quaternion): SavedSurface {
  const inv = new Quaternion().copy(info.quaternion).invert();
  const localPosition = position.clone().sub(info.origin).applyQuaternion(inv);
  const localQuaternion = inv.clone().multiply(quaternion);
  return {
    kind: info.kind,
    label: info.label,
    origin: v3(info.origin),
    quaternion: q4(info.quaternion),
    local: { position: v3(localPosition), quaternion: q4(localQuaternion) },
  };
}

/** Same kind (same semantic label preferred), nearest to where the plane was. */
function matchSurface(saved: SavedSurface, surfaces: SurfaceInfo[]): SurfaceInfo | null {
  const origin = new Vector3(...saved.origin);
  let best: SurfaceInfo | null = null;
  let bestScore = Infinity;
  for (const s of surfaces) {
    if (s.kind !== saved.kind) continue;
    const d = s.origin.distanceTo(origin);
    if (d > SURFACE_MATCH_M) continue;
    const score = d + (s.label === saved.label ? 0 : 0.5);
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  if (best !== null) return best;
  // The tracking origin may have moved (a new session elsewhere): accept the
  // one surface of the same kind and label, if it is unambiguous.
  const same = surfaces.filter((s) => s.kind === saved.kind && s.label === saved.label);
  return same.length === 1 ? same[0] : null;
}

function fromSurface(info: SurfaceInfo, saved: SavedSurface): { position: Vector3; quaternion: Quaternion } {
  const position = new Vector3(...saved.local.position).applyQuaternion(info.quaternion).add(info.origin);
  const quaternion = info.quaternion.clone().multiply(new Quaternion(...saved.local.quaternion));
  return { position, quaternion };
}

/** Exposed for index.ts so the world is referenced only where needed. */
export function registerPersistence(world: World): void {
  world.registerSystem(CardPersistenceSystem);
}
