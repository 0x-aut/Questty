/**
 * Daily streak (PR 9: the streak flame). Pure: no IWSDK imports, so the
 * harness unit-tests it with esbuild under several TZ settings.
 *
 * A day counts when at least one focus session or one quest is completed on
 * that LOCAL calendar date. Days are stored as local 'YYYY-MM-DD' keys, so a
 * day boundary is the user's midnight, and a DST change (23 or 25 hour day)
 * never shifts the count.
 *
 * Missing a day is forgiven once: the day after a missed day is a grace day
 * (the flame drops to a low ember); completing something that day keeps the
 * streak going. Miss the grace day too and the streak resets.
 */

export type StreakStatus = 'out' | 'waiting' | 'lit' | 'ember';

export type StreakRecord = { streak: number; lastDay: string | null };

export type StreakView = {
  /** Streak shown to the user (0 once it has reset). */
  streak: number;
  /**
   * lit: today already counts. waiting: yesterday counted, today not yet.
   * ember: one day was missed, today is the grace day. out: no streak.
   */
  status: StreakStatus;
  /** Whole local days since the last counted day (null without one). */
  gap: number | null;
};

export type StreakTier = {
  id: 'unlit' | 'spark' | 'gold' | 'blue' | 'violet' | 'emerald';
  name: string;
  /** Lowest streak (days) of this tier. */
  from: number;
  /** Flame colours: hot core, body and outer edge (sRGB hex). */
  core: number;
  body: number;
  edge: number;
};

/**
 * The colour ladder. Warm fire first, then hotter and rarer colours, the way
 * a flame really changes as it burns hotter, ending on a rare emerald.
 * Low tiers use Duolingo's streak orange.
 */
export const STREAK_TIERS: readonly StreakTier[] = [
  // core = inner flame, body = mid flame, edge = outer flame. Duolingo orange at the bottom of the ladder.
  { id: 'unlit', name: 'Pilot', from: 0, core: 0xffe7b0, body: 0xffb04a, edge: 0xe5801e },
  { id: 'spark', name: 'Ember', from: 1, core: 0xfff4c2, body: 0xffc800, edge: 0xff9600 },
  { id: 'gold', name: 'Gold', from: 3, core: 0xfffbe8, body: 0xffe45c, edge: 0xffb300 },
  { id: 'blue', name: 'Blue', from: 7, core: 0xf2fbff, body: 0x8fdcff, edge: 0x1cb0f6 },
  { id: 'violet', name: 'Violet', from: 14, core: 0xfdf3ff, body: 0xd8a8ff, edge: 0x9b5cf0 },
  { id: 'emerald', name: 'Emerald', from: 30, core: 0xf0fff6, body: 0x7cf0b2, edge: 0x22c06a },
];

export const MAX_STREAK_BONUS_XP = 25;
const MS_PER_DAY = 86_400_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** Local calendar date of a timestamp as 'YYYY-MM-DD'. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function isDayKey(value: unknown): value is string {
  return typeof value === 'string' && DAY_RE.test(value);
}

/** Whole calendar days from `a` to `b` (b - a), independent of DST. */
export function daysBetween(a: string, b: string): number {
  const pa = DAY_RE.exec(a);
  const pb = DAY_RE.exec(b);
  if (pa === null || pb === null) return Number.NaN;
  const ua = Date.UTC(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3]));
  const ub = Date.UTC(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3]));
  return Math.round((ub - ua) / MS_PER_DAY);
}

/** What the flame shows on `today`. */
export function viewStreak(record: StreakRecord, today: string): StreakView {
  if (record.lastDay === null || record.streak <= 0) return { streak: 0, status: 'out', gap: null };
  const gap = daysBetween(record.lastDay, today);
  if (!Number.isFinite(gap)) return { streak: 0, status: 'out', gap: null };
  // A clock set back a day or more: treat as today rather than losing the streak.
  if (gap <= 0) return { streak: record.streak, status: 'lit', gap };
  if (gap === 1) return { streak: record.streak, status: 'waiting', gap };
  if (gap === 2) return { streak: record.streak, status: 'ember', gap };
  return { streak: 0, status: 'out', gap };
}

export type CountResult = StreakRecord & {
  /** First completion of this day (the streak moved). */
  firstOfDay: boolean;
  how: 'start' | 'same-day' | 'next-day' | 'grace' | 'reset';
  /** XP bonus for keeping the streak (first completion of a day, streak 2+). */
  bonusXp: number;
};

/** Count a completion on `today`. */
export function countDay(record: StreakRecord, today: string): CountResult {
  const bonus = (streak: number): number => Math.min(MAX_STREAK_BONUS_XP, 5 * Math.max(0, streak - 1));
  if (record.lastDay === null || record.streak <= 0) {
    return { streak: 1, lastDay: today, firstOfDay: true, how: 'start', bonusXp: 0 };
  }
  const gap = daysBetween(record.lastDay, today);
  if (!Number.isFinite(gap)) return { streak: 1, lastDay: today, firstOfDay: true, how: 'start', bonusXp: 0 };
  if (gap <= 0) return { streak: record.streak, lastDay: record.lastDay, firstOfDay: false, how: 'same-day', bonusXp: 0 };
  if (gap === 1 || gap === 2) {
    const streak = record.streak + 1;
    return { streak, lastDay: today, firstOfDay: true, how: gap === 1 ? 'next-day' : 'grace', bonusXp: bonus(streak) };
  }
  return { streak: 1, lastDay: today, firstOfDay: true, how: 'reset', bonusXp: 0 };
}

export function tierFor(streak: number): StreakTier {
  let tier = STREAK_TIERS[0];
  for (const t of STREAK_TIERS) if (streak >= t.from) tier = t;
  return tier;
}

/** Flame size multiplier: grows with the streak, clamped so it stays desk-sized. */
export const FLAME_SCALE_MIN = 0.8;
export const FLAME_SCALE_MAX = 1.25;
export function flameScale(view: StreakView): number {
  if (view.status === 'ember') return 0.42;
  if (view.streak <= 0) return 0.5;
  const grow = Math.log(1 + view.streak) / Math.log(31);
  const scale = FLAME_SCALE_MIN + (FLAME_SCALE_MAX - FLAME_SCALE_MIN) * grow;
  const clamped = Math.min(FLAME_SCALE_MAX, Math.max(FLAME_SCALE_MIN, scale));
  // Waiting for today's first completion: the same flame, a touch lower.
  return view.status === 'waiting' ? clamped * 0.9 : clamped;
}

/** The buddy's answer to "what's my streak?". */
export function streakLine(view: StreakView): string {
  const tier = tierFor(view.streak);
  if (view.status === 'out') return 'No streak yet. Finish one quest or focus session today to light the flame.';
  const days = `${view.streak} day${view.streak === 1 ? '' : 's'}`;
  if (view.status === 'lit') return `${days} and counting. Today's done - the flame's ${tier.name.toLowerCase()}.`;
  if (view.status === 'waiting') return `${days}. Finish one thing today to keep it going.`;
  return `${days}, but it's down to an ember. Finish one thing today or it resets.`;
}
