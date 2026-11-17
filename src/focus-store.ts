import { playSound, primeAudio } from './sfx.js';
/**
 * Small persistence + clock helpers for the focus timer.
 *
 * Timer math always uses wall-clock time (Date.now()), never summed frame
 * deltas, so a backgrounded tab or a stalled frame never loses time.
 */

export type BlurLevel = 'off' | 'soft' | 'strong';
export const BLUR_LEVELS: readonly BlurLevel[] = ['off', 'soft', 'strong'];

const BLUR_KEY = 'questty.focusBlur.v1';
const TIMER_KEY = 'questty.focusTimer.v1';

/** Dev-only time scale (?focusTimeScale=60 makes a minute pass per second). */
let timeScale = 1;
let scaleEpoch = 0;
if (import.meta.env.DEV) {
  const raw = Number(new URLSearchParams(window.location.search).get('focusTimeScale'));
  if (Number.isFinite(raw) && raw > 1 && raw <= 600) {
    timeScale = raw;
    scaleEpoch = Date.now();
    console.info(`[focus] dev time scale x${raw}`);
  }
}

/** Clock for the focus timer. Production: exactly Date.now(). */
export function focusNow(): number {
  if (import.meta.env.DEV && timeScale !== 1) {
    return scaleEpoch + (Date.now() - scaleEpoch) * timeScale;
  }
  return Date.now();
}

export function loadBlurLevel(): BlurLevel {
  try {
    const value = localStorage.getItem(BLUR_KEY);
    return value === 'off' || value === 'soft' || value === 'strong' ? value : 'soft';
  } catch {
    return 'soft';
  }
}

export function saveBlurLevel(level: BlurLevel): void {
  try {
    localStorage.setItem(BLUR_KEY, level);
  } catch {
    // Storage may be unavailable; the choice still applies for this visit.
  }
}

export type SavedFocusTimer = {
  version: 1;
  /** Stable card id (PR 4); older saves have none. */
  cardId?: string;
  title: string;
  xp: number;
  zoneId: string;
  surfaceId: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: number;
  durationMs: number;
  endsAt: number;
  pausedRemainingMs: number | null;
  consecutiveSkips: number;
};

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function loadFocusTimer(): SavedFocusTimer | null {
  try {
    const raw = localStorage.getItem(TIMER_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as Partial<SavedFocusTimer>;
    if (
      v.version !== 1 ||
      typeof v.title !== 'string' ||
      v.title.length === 0 ||
      v.title.length > 200 ||
      !isNum(v.xp) ||
      typeof v.zoneId !== 'string' ||
      typeof v.surfaceId !== 'string' ||
      !Array.isArray(v.position) ||
      v.position.length !== 3 ||
      !v.position.every(isNum) ||
      !Array.isArray(v.quaternion) ||
      v.quaternion.length !== 4 ||
      !v.quaternion.every(isNum) ||
      !isNum(v.scale) ||
      !isNum(v.durationMs) ||
      !isNum(v.endsAt) ||
      !(v.pausedRemainingMs === null || isNum(v.pausedRemainingMs)) ||
      !isNum(v.consecutiveSkips) ||
      !(v.cardId === undefined || (typeof v.cardId === 'string' && v.cardId.length <= 64))
    ) {
      clearFocusTimer();
      return null;
    }
    return v as SavedFocusTimer;
  } catch {
    return null;
  }
}

export function saveFocusTimer(timer: SavedFocusTimer): void {
  try {
    localStorage.setItem(TIMER_KEY, JSON.stringify(timer));
  } catch {
    // Not fatal: the timer just will not survive a reload.
  }
}

export function clearFocusTimer(): void {
  try {
    localStorage.removeItem(TIMER_KEY);
  } catch {
    // ignore
  }
}

/**
 * Sounds moved to sfx.ts in PR 11 (one shared AudioContext, an effects bus
 * with a mute setting, and the buddy's spatial panner). These keep their old
 * names for the callers.
 */
export function primeChime(): void {
  primeAudio();
}

/** The completion chime (three-note bell). Awards play it through the XP bar system. */
export function playChime(reason = 'chime'): void {
  playSound('chime', reason);
}

/** A soft "tap" as a card settles onto a surface; silent until a pinch primed audio. */
export function playTap(): void {
  playSound('tap');
}

const BREAK_KEY = 'questty.break.v1';
/** PR 11: the last break prompt shown, so the next break asks for the next one (survives reloads). */
export function loadLastBreakPrompt(): string | null {
  try {
    return localStorage.getItem(BREAK_KEY);
  } catch {
    return null;
  }
}
export function saveLastBreakPrompt(id: string): void {
  try {
    localStorage.setItem(BREAK_KEY, id);
  } catch {
    // not fatal
  }
}
