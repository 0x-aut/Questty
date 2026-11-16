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

let audioContext: AudioContext | undefined;

/** Create/resume the AudioContext. Call from a pinch so autoplay rules allow it. */
export function primeChime(): void {
  try {
    if (audioContext === undefined) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor === undefined) return;
      audioContext = new Ctor();
    }
    if (audioContext.state === 'suspended') void audioContext.resume();
  } catch {
    audioContext = undefined;
  }
}

/** A gentle three-note bell made with WebAudio oscillators (no audio files). */
export function playChime(): void {
  primeChime();
  const ctx = audioContext;
  if (ctx === undefined) return;
  try {
    const master = ctx.createGain();
    master.gain.value = 0.22;
    master.connect(ctx.destination);
    const start = ctx.currentTime + 0.05;
    const notes = [659.25, 987.77, 1318.51]; // E5, B5, E6
    notes.forEach((frequency, index) => {
      const at = start + index * 0.18;
      for (const [ratio, level] of [
        [1, 1],
        [2.01, 0.18],
      ] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = frequency * ratio;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.6 * level, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.8);
        osc.connect(gain);
        gain.connect(master);
        osc.start(at);
        osc.stop(at + 1.9);
      }
    });
  } catch {
    // A blocked or missing audio device must never break completion.
  }
}
