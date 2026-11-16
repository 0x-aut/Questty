/**
 * Saved quest cards (localStorage). Cards come back after a reload or a new
 * XR session, where the user left them.
 *
 * Each card keeps three ways to find its spot again, best first:
 *  1. `anchor`: a WebXR persistent anchor handle (Quest Browser keeps these per
 *     origin), restored with session.restorePersistentAnchor(uuid);
 *  2. `surface`: the room plane it was pinned to (kind + semantic label + the
 *     plane's pose) and the card pose in that plane's own frame, so it follows
 *     the plane if the tracking origin moved;
 *  3. `pose`: the plain world (local-floor) pose.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export type SavedSurface = {
  kind: 'wall' | 'desk' | 'door';
  label: string;
  origin: Vec3;
  quaternion: Quat;
  /** Card pose in the surface's own frame. */
  local: { position: Vec3; quaternion: Quat };
};

export type SavedCard = {
  id: string;
  title: string;
  xp: number;
  state: 'active';
  createdAt: number;
  zoneId: '' | 'wall' | 'desk' | 'door';
  pose: { position: Vec3; quaternion: Quat; scale: number };
  surface?: SavedSurface;
  anchor?: string;
};

const CARDS_KEY = 'questty.cards.v1';
const COACH_KEY = 'questty.coach.v1';
const MAX_CARDS = 40;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(isNum);

function validCard(v: unknown): v is SavedCard {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Partial<SavedCard>;
  const pose = c.pose;
  if (
    typeof c.id !== 'string' ||
    c.id.length === 0 ||
    c.id.length > 64 ||
    typeof c.title !== 'string' ||
    c.title.length === 0 ||
    c.title.length > 200 ||
    !isNum(c.xp) ||
    !(c.zoneId === '' || c.zoneId === 'wall' || c.zoneId === 'desk' || c.zoneId === 'door') ||
    pose === undefined ||
    !isVec(pose.position, 3) ||
    !isVec(pose.quaternion, 4) ||
    !isNum(pose.scale)
  ) {
    return false;
  }
  if (c.anchor !== undefined && typeof c.anchor !== 'string') return false;
  const s = c.surface;
  if (
    s !== undefined &&
    (typeof s.label !== 'string' ||
      !isVec(s.origin, 3) ||
      !isVec(s.quaternion, 4) ||
      !isVec(s.local?.position, 3) ||
      !isVec(s.local?.quaternion, 4))
  ) {
    return false;
  }
  return true;
}

export function loadCards(): SavedCard[] {
  try {
    const raw = localStorage.getItem(CARDS_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(validCard).slice(0, MAX_CARDS) : [];
  } catch {
    return [];
  }
}

export function saveCards(cards: Iterable<SavedCard>): void {
  try {
    localStorage.setItem(CARDS_KEY, JSON.stringify([...cards].slice(-MAX_CARDS)));
  } catch {
    // Storage full or blocked: cards still work for this visit.
  }
}

/** Has the user already pinned a card once (placement coach mark seen)? */
export function coachSeen(): boolean {
  try {
    return localStorage.getItem(COACH_KEY) === 'done';
  } catch {
    return false;
  }
}

export function markCoachSeen(): void {
  try {
    localStorage.setItem(COACH_KEY, 'done');
  } catch {
    // ignore
  }
}
