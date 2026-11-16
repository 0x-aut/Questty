/**
 * PR 7: resolve a spatial buddy target ("the wall on my left", "the desk") to
 * one of the room's snap surfaces, from where the user sits.
 *
 * Walls are told apart by their inward normal relative to the user's home
 * forward direction (the way they faced when the session started), so "left"
 * stays the same wall when the head turns. Pure apart from three's Vector3, so
 * the harness can unit-test it with esbuild.
 */
import { Vector3 } from 'three';
import type { PlaceTarget } from './actions.js';

export type SurfaceLike = {
  id: string;
  kind: 'wall' | 'desk' | 'door';
  label: string;
  center: Vector3;
  normal: Vector3;
  width: number;
  height: number;
};

export type Resolution =
  | { ok: true; surface: SurfaceLike; where: string }
  | { ok: false; wanted: string; nearest: { target: PlaceTarget; surface: SurfaceLike; where: string } | null };

const WHERE: Record<PlaceTarget, string> = {
  desk: 'your desk',
  wall_front: 'the wall in front of you',
  wall_left: 'the wall on your left',
  wall_right: 'the wall on your right',
  door: 'the door',
  here: 'right in front of you',
  next_to: 'next to it',
};
export const whereLabel = (t: PlaceTarget): string => WHERE[t];

/** Minimum cosine between a wall's inward normal and the wanted direction (about 50 degrees). */
const WALL_COS = 0.64;

function flat(v: Vector3): Vector3 {
  const out = new Vector3(v.x, 0, v.z);
  return out.lengthSq() < 1e-6 ? new Vector3(0, 0, -1) : out.normalize();
}

/** How well a wall matches front/left/right (higher is better), or -Infinity. */
export function wallScore(target: 'wall_front' | 'wall_left' | 'wall_right', s: SurfaceLike, head: Vector3, forward: Vector3): number {
  const f = flat(forward);
  const right = new Vector3(-f.z, 0, f.x);
  const n = flat(s.normal);
  // Inward normal: the front wall faces back at the user (-forward); the
  // left wall faces right (+right); the right wall faces left.
  const want = target === 'wall_front' ? f.clone().negate() : target === 'wall_left' ? right : right.clone().negate();
  const cos = n.dot(want);
  if (cos < WALL_COS) return -Infinity;
  const dist = Math.hypot(s.center.x - head.x, s.center.z - head.z);
  return cos * 4 - dist * 0.5 + Math.min(s.width, 3) * 0.2;
}

function deskScore(s: SurfaceLike, head: Vector3, forward: Vector3): number {
  const f = flat(forward);
  const to = new Vector3(s.center.x - head.x, 0, s.center.z - head.z);
  const dist = to.length();
  const ahead = dist > 1e-3 ? to.normalize().dot(f) : 1;
  const named = /desk|table/u.test(s.label.toLowerCase()) ? 0.5 : 0;
  // In front of the seat and close by wins; a table behind the user only as a last resort.
  return ahead * 2 - dist * 0.6 + named;
}

function best<T>(items: T[], score: (t: T) => number): { item: T; score: number } | null {
  let out: { item: T; score: number } | null = null;
  for (const item of items) {
    const value = score(item);
    if (!Number.isFinite(value)) continue;
    if (out === null || value > out.score) out = { item, score: value };
  }
  return out;
}

/** The surface for a target, or the nearest usable one to offer instead. */
export function resolvePlace(target: Exclude<PlaceTarget, 'here' | 'next_to'>, surfaces: SurfaceLike[], head: Vector3, forward: Vector3): Resolution {
  const walls = surfaces.filter((s) => s.kind === 'wall');
  const desks = surfaces.filter((s) => s.kind === 'desk');
  const doors = surfaces.filter((s) => s.kind === 'door');
  let hit: SurfaceLike | null = null;
  if (target === 'desk') hit = best(desks, (s) => deskScore(s, head, forward))?.item ?? null;
  else if (target === 'door') hit = best(doors, (s) => -s.center.distanceTo(head))?.item ?? null;
  else hit = best(walls, (s) => wallScore(target, s, head, forward))?.item ?? null;
  if (hit !== null) return { ok: true, surface: hit, where: WHERE[target] };

  // Nothing there: offer the nearest surface we do have (another wall first).
  const options: Array<{ target: Exclude<PlaceTarget, 'here' | 'next_to'>; surface: SurfaceLike }> = [];
  for (const t of ['wall_front', 'wall_left', 'wall_right'] as const) {
    if (t === target) continue;
    const w = best(walls, (s) => wallScore(t, s, head, forward));
    if (w !== null) options.push({ target: t, surface: w.item });
  }
  if (target !== 'desk' && desks.length > 0) options.push({ target: 'desk', surface: best(desks, (s) => deskScore(s, head, forward))!.item });
  if (target !== 'door' && doors.length > 0) options.push({ target: 'door', surface: doors[0] });
  options.sort((a, b) => a.surface.center.distanceTo(head) - b.surface.center.distanceTo(head));
  const nearest = options[0];
  return {
    ok: false,
    wanted: WHERE[target],
    nearest: nearest === undefined ? null : { target: nearest.target, surface: nearest.surface, where: WHERE[nearest.target] },
  };
}

/**
 * Where on a surface to aim a card: walls at about eye height straight out
 * from the seat; desks between the seat-side edge and the middle; doors in
 * the middle. The placement then clamps inside and steps around other cards.
 */
export function aimPoint(s: SurfaceLike, head: Vector3, index = 0, count = 1, spacing = 0): Vector3 {
  const n = s.normal.clone().normalize();
  let p: Vector3;
  if (s.kind === 'wall') {
    p = head.clone().addScaledVector(n, -head.clone().sub(s.center).dot(n));
    p.y = head.y - 0.12;
  } else if (s.kind === 'desk') {
    const foot = head.clone().addScaledVector(n, -head.clone().sub(s.center).dot(n));
    p = s.center.clone().lerp(foot, 0.25);
  } else {
    p = s.center.clone();
  }
  if (count > 1 && spacing > 0) {
    // A row along the surface, left to right as the user sees it.
    const up = s.kind === 'desk' ? head.clone().sub(p).setY(0).normalize().negate() : new Vector3(0, 1, 0);
    const across = new Vector3().crossVectors(up, n).normalize();
    p.addScaledVector(across, (index - (count - 1) / 2) * spacing);
  }
  return p;
}

/** A short "where is it" phrase for find: the surface kind plus its side from the seat. */
export function describeSpot(position: Vector3, surfaceKind: string, head: Vector3, forward: Vector3): string {
  const f = flat(forward);
  const right = new Vector3(-f.z, 0, f.x);
  const to = new Vector3(position.x - head.x, 0, position.z - head.z);
  const side = to.lengthSq() < 1e-6 ? 0 : to.normalize().dot(right);
  const ahead = to.dot(f);
  const dir = ahead < -0.3 ? 'behind you' : side < -0.45 ? 'on your left' : side > 0.45 ? 'on your right' : 'in front of you';
  if (surfaceKind === 'desk') return `on the desk ${dir === 'in front of you' ? 'in front of you' : dir}`;
  if (surfaceKind === 'door') return `on the door ${dir}`;
  if (surfaceKind === 'wall') return `on the wall ${dir}`;
  return `floating ${dir}`;
}
