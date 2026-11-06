export type ProgressState = {
  version: 1;
  xp: number;
  level: number;
  streak: number;
  lastCompletedAt: number | null;
};

export const PROGRESS_STORAGE_KEY = 'questty.progress.v1';
const XP_PER_LEVEL = 100;

const DEFAULT_PROGRESS: ProgressState = {
  version: 1,
  xp: 0,
  level: 1,
  streak: 0,
  lastCompletedAt: null,
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
}

export function awardXp(amount: number, now = Date.now()): ProgressState {
  const previous = getProgress();
  const earned = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
  const previousDay =
    previous.lastCompletedAt === null
      ? null
      : Math.floor(previous.lastCompletedAt / 86_400_000);
  const today = Math.floor(now / 86_400_000);
  const streak =
    previousDay === null
      ? 1
      : previousDay === today
        ? previous.streak
        : previousDay === today - 1
          ? previous.streak + 1
          : 1;
  const xp = previous.xp + earned;
  const next: ProgressState = {
    version: 1,
    xp,
    level: Math.floor(xp / XP_PER_LEVEL) + 1,
    streak,
    lastCompletedAt: now,
  };
  saveProgress(next);
  return next;
}
