/** Focus lengths offered on the focus panel, in minutes. */
export const FOCUS_CHOICES_MIN = [5, 15, 25, 45] as const;
export const DEFAULT_FOCUS_MIN = 25;
export const EXTEND_MS = 5 * 60_000;
export const MAX_FOCUS_MS = 180 * 60_000;
export const BREAK_MS = 20_000;

export type FocusPhase = {
  phase: 'focus';
  questId: string;
  /** Total planned length, including any +5 min extensions. */
  durationMs: number;
  /** Wall-clock end time while running (Date.now() based, never frame deltas). */
  endsAt: number;
  /** Time left when paused, or null while running. */
  pausedRemainingMs: number | null;
  consecutiveSkips: number;
};

export type SessionState =
  | { phase: 'idle'; consecutiveSkips: number }
  | FocusPhase
  | { phase: 'break'; questId: string; endsAt: number; consecutiveSkips: number; promptId?: BreakPromptId };

/** PR 11: the enforced 20 s break rotates what it asks for. */
export type BreakPromptId = 'far-point' | 'shoulders' | 'water';
export type BreakPrompt = { id: BreakPromptId; status: string; buddy: string };
export const BREAK_PROMPTS: readonly BreakPrompt[] = [
  { id: 'far-point', status: 'Look at the farthest point you can see', buddy: 'Break time. Find the farthest point in the room and let your eyes rest on it.' },
  { id: 'shoulders', status: 'Roll your shoulders back, slowly', buddy: 'Break time. Roll your shoulders back slowly, five times, and breathe out.' },
  { id: 'water', status: 'Take a sip of water', buddy: 'Break time. Have a sip of water, then we go again.' },
];

/** The prompt after `lastId` (the first one when there was none or it is unknown). */
export function nextBreakPrompt(lastId: string | null | undefined): BreakPrompt {
  const i = BREAK_PROMPTS.findIndex((p) => p.id === lastId);
  return BREAK_PROMPTS[(i + 1) % BREAK_PROMPTS.length];
}

export function breakPromptById(id: string | null | undefined): BreakPrompt {
  return BREAK_PROMPTS.find((p) => p.id === id) ?? BREAK_PROMPTS[0];
}

export const IDLE_SESSION: SessionState = { phase: 'idle', consecutiveSkips: 0 };

/** Suggested length from a title such as "Deep work 25m" or "Read 15 min". */
export function suggestedFocusMinutes(title: string): number | null {
  const match = /\b(\d{1,3})\s*(?:m|min|mins|minutes?)\b/iu.exec(title);
  if (match === null) return null;
  const minutes = Number(match[1]);
  return minutes >= 1 && minutes <= 180 ? minutes : null;
}

/** The four chips shown on the panel; a suggestion replaces the nearest default. */
export function focusChoices(suggested: number | null): number[] {
  const choices: number[] = [...FOCUS_CHOICES_MIN];
  if (suggested === null || choices.includes(suggested)) return choices;
  let nearest = 0;
  for (let i = 1; i < choices.length; i += 1) {
    if (Math.abs(choices[i] - suggested) < Math.abs(choices[nearest] - suggested)) nearest = i;
  }
  choices[nearest] = suggested;
  return choices.sort((a, b) => a - b);
}

export function startFocus(
  state: SessionState,
  questId: string,
  now: number,
  durationMs: number,
): SessionState {
  if (state.phase !== 'idle') return state;
  const length = Math.max(1_000, Math.min(MAX_FOCUS_MS, durationMs));
  return {
    phase: 'focus',
    questId,
    durationMs: length,
    endsAt: now + length,
    pausedRemainingMs: null,
    consecutiveSkips: state.consecutiveSkips,
  };
}

export function focusRemainingMs(state: SessionState, now: number): number {
  if (state.phase !== 'focus') return 0;
  if (state.pausedRemainingMs !== null) return Math.max(0, state.pausedRemainingMs);
  return Math.max(0, state.endsAt - now);
}

export function pauseFocus(state: SessionState, now: number): SessionState {
  if (state.phase !== 'focus' || state.pausedRemainingMs !== null) return state;
  return { ...state, pausedRemainingMs: Math.max(0, state.endsAt - now) };
}

export function resumeFocus(state: SessionState, now: number): SessionState {
  if (state.phase !== 'focus' || state.pausedRemainingMs === null) return state;
  return { ...state, endsAt: now + state.pausedRemainingMs, pausedRemainingMs: null };
}

export function extendFocus(state: SessionState, now: number, extraMs = EXTEND_MS): SessionState {
  if (state.phase !== 'focus') return state;
  const remaining = focusRemainingMs(state, now);
  const room = MAX_FOCUS_MS - remaining;
  const extra = Math.max(0, Math.min(extraMs, room));
  if (extra === 0) return state;
  return {
    ...state,
    durationMs: state.durationMs + extra,
    endsAt: state.pausedRemainingMs === null ? state.endsAt + extra : state.endsAt,
    pausedRemainingMs: state.pausedRemainingMs === null ? null : state.pausedRemainingMs + extra,
  };
}

/** Next state when a deadline passes. A running focus that ran out becomes 'expired'. */
export function focusExpired(state: SessionState, now: number): boolean {
  return state.phase === 'focus' && state.pausedRemainingMs === null && now >= state.endsAt;
}

export function advanceBreak(state: SessionState, now: number): SessionState {
  if (state.phase !== 'break' || now < state.endsAt) return state;
  return IDLE_SESSION;
}

export function completeFocus(state: SessionState, now: number, promptId?: BreakPromptId): SessionState {
  if (state.phase !== 'focus') return state;
  return {
    phase: 'break',
    questId: state.questId,
    endsAt: now + BREAK_MS,
    consecutiveSkips: state.consecutiveSkips,
    ...(promptId !== undefined ? { promptId } : {}),
  };
}

/** Can the current break be skipped? Never twice in a row: a skipped break makes the next one stick. */
export function canSkipBreak(state: SessionState): boolean {
  return state.phase === 'break' && state.consecutiveSkips === 0;
}

export function endFocusEarly(state: SessionState): SessionState {
  if (state.phase !== 'focus') return state;
  return { phase: 'idle', consecutiveSkips: state.consecutiveSkips };
}

export function skipBreak(state: SessionState): SessionState {
  if (state.phase !== 'break' || state.consecutiveSkips > 0) return state;
  return { phase: 'idle', consecutiveSkips: state.consecutiveSkips + 1 };
}

export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
