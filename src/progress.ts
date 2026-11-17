import { countDay, dayKey, isDayKey, type CountResult } from './streak.js';

export type ProgressState = {
  version: 1;
  xp: number;
  level: number;
  streak: number;
  lastCompletedAt: number | null;
  /** PR 9: local calendar day ('YYYY-MM-DD') the streak last counted. */
  lastDay: string | null;
};

/** What the last completion did (PR 9: the flame flares, the card shows the bonus). */
export type AwardEvent = {
  progress: ProgressState;
  base: number;
  bonusXp: number;
  streak: CountResult;
  levelBefore: number;
};

const awardListeners = new Set<(event: AwardEvent) => void>();
/** Listen for completions (quest or focus); returns an unsubscribe. */
export function onAward(listener: (event: AwardEvent) => void): () => void {
  awardListeners.add(listener);
  return () => awardListeners.delete(listener);
}
const progressListeners = new Set<(progress: ProgressState) => void>();
/** Listen for any saved change to the progress (award, undo, dev hook). */
export function onProgress(listener: (progress: ProgressState) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

export const PROGRESS_STORAGE_KEY = 'questty.progress.v1';
export const XP_PER_LEVEL = 100;

const DEFAULT_PROGRESS: ProgressState = {
  version: 1,
  xp: 0,
  level: 1,
  streak: 0,
  lastCompletedAt: null,
  lastDay: null,
};

export function getProgress(): ProgressState {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_PROGRESS };
    const raw = localStorage.getItem(PROGRESS_STORAGE_KEY);
    if (raw === null) return { ...DEFAULT_PROGRESS };
    const value = JSON.parse(raw) as Partial<ProgressState>;
    if (
      value.version !== 1 ||
      !Number.isFinite(value.xp) ||
      !Number.isInteger(value.level) ||
      !Number.isInteger(value.streak) ||
      !(value.lastCompletedAt === null || Number.isFinite(value.lastCompletedAt))
    ) {
      return { ...DEFAULT_PROGRESS };
    }
    return {
      version: 1,
      xp: Math.max(0, value.xp as number),
      level: Math.max(1, value.level as number),
      streak: Math.max(0, value.streak as number),
      lastCompletedAt: value.lastCompletedAt ?? null,
      // Saves from before PR 9 have no lastDay: derive it from the last completion (local date).
      lastDay: isDayKey(value.lastDay)
        ? value.lastDay
        : typeof value.lastCompletedAt === 'number'
          ? dayKey(value.lastCompletedAt)
          : null,
    };
  } catch {
    return { ...DEFAULT_PROGRESS };
  }
}

export function saveProgress(progress: ProgressState): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Storage may be disabled or full; quest completion still succeeds in memory.
  }
  for (const listener of progressListeners) listener(progress);
}

/**
 * A quest or focus session was completed: XP, level and the daily streak
 * (local calendar days, one grace day; see streak.ts). The first completion
 * of a day that continues a streak earns a small bonus (5 XP per streak day
 * beyond the first, max 25).
 */
export function awardXp(amount: number, now = Date.now()): ProgressState {
  const previous = getProgress();
  const earned = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
  const streak = countDay({ streak: previous.streak, lastDay: previous.lastDay }, dayKey(now));
  const xp = previous.xp + earned + streak.bonusXp;
  const next: ProgressState = {
    version: 1,
    xp,
    level: Math.floor(xp / XP_PER_LEVEL) + 1,
    streak: streak.streak,
    lastCompletedAt: now,
    lastDay: streak.lastDay,
  };
  saveProgress(next);
  const event: AwardEvent = { progress: next, base: earned, bonusXp: streak.bonusXp, streak, levelBefore: previous.level };
  lastAward = event;
  for (const listener of awardListeners) listener(event);
  return next;
}

let lastAward: AwardEvent | null = null;
/** The most recent completion this page saw (null before any). */
export function getLastAward(): AwardEvent | null {
  return lastAward;
}

/** Dev hook (PR 9): set the streak directly for tests and the demo video. */
export function setStreakForDev(streak: number, lastDay: string | null): ProgressState {
  const next: ProgressState = { ...getProgress(), streak: Math.max(0, Math.floor(streak)), lastDay };
  saveProgress(next);
  return next;
}

/** Take back XP from a completion the user undid (AI buddy Undo, PR 6). Streak is left alone. */
export function revokeXp(amount: number): ProgressState {
  const previous = getProgress();
  const lost = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
  const xp = Math.max(0, previous.xp - lost);
  const next: ProgressState = { ...previous, xp, level: Math.floor(xp / XP_PER_LEVEL) + 1 };
  saveProgress(next);
  return next;
}
