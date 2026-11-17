/**
 * PR 11: the XP progress bar toward the next level (pure: no IWSDK imports).
 *
 * Level = floor(xp / XP_PER_LEVEL) + 1 (progress.ts), so the bar is the XP
 * gathered inside the current level over XP_PER_LEVEL. An award that crosses
 * one or more level boundaries animates as segments: fill the old level to the
 * end, then start each new level from empty.
 */
import { XP_PER_LEVEL } from './progress.js';

export type XpBarView = {
  level: number;
  /** XP inside the current level (0..perLevel-1). */
  into: number;
  perLevel: number;
  /** into / perLevel, 0..1 (never 1: a full bar is the next level at 0). */
  fraction: number;
  /** XP still needed for the next level. */
  toNext: number;
};

export function xpBarView(xp: number, perLevel = XP_PER_LEVEL): XpBarView {
  const total = Number.isFinite(xp) ? Math.max(0, Math.floor(xp)) : 0;
  const level = Math.floor(total / perLevel) + 1;
  const into = total - (level - 1) * perLevel;
  return { level, into, perLevel, fraction: into / perLevel, toNext: perLevel - into };
}

export type BarSegment = { level: number; from: number; to: number };

/**
 * The animation from one XP total to another. Going up across levels: one
 * segment per level touched (the old one filling to 1, full middle levels,
 * the new one from 0). Going down (an Undo): one segment straight to the new
 * value. At most 6 segments (a huge jump shows the last ones).
 */
export function barSegments(fromXp: number, toXp: number, perLevel = XP_PER_LEVEL): BarSegment[] {
  const a = xpBarView(fromXp, perLevel);
  const b = xpBarView(toXp, perLevel);
  if (toXp <= fromXp || a.level === b.level) {
    return [{ level: b.level, from: a.level === b.level ? a.fraction : b.fraction, to: b.fraction }];
  }
  const out: BarSegment[] = [{ level: a.level, from: a.fraction, to: 1 }];
  for (let level = a.level + 1; level < b.level; level += 1) out.push({ level, from: 0, to: 1 });
  out.push({ level: b.level, from: 0, to: b.fraction });
  return out.length > 6 ? [out[0], ...out.slice(out.length - 5)] : out;
}

/** How long each segment animates (ms): longer for a bigger move, 250-900 ms. */
export function segmentMs(segment: BarSegment): number {
  return Math.round(250 + 650 * Math.min(1, Math.abs(segment.to - segment.from)));
}

/** Smoothstep-style ease for the fill. */
export function easeOut(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return 1 - (1 - c) * (1 - c) * (1 - c);
}

/** The label beside the bar: "Lv 3  |  40 / 100 XP". */
export function barLabel(view: XpBarView): string {
  return `Lv ${view.level}  |  ${view.into} / ${view.perLevel} XP`;
}
