export const FOCUS_MS = 30_000;
export const BREAK_MS = 20_000;

export type SessionState =
  | { phase: 'idle'; consecutiveSkips: number }
  | { phase: 'focus'; questId: string; endsAt: number; consecutiveSkips: number }
  | { phase: 'break'; questId: string; endsAt: number; consecutiveSkips: number };

export const IDLE_SESSION: SessionState = { phase: 'idle', consecutiveSkips: 0 };

export function startFocus(
  state: SessionState,
  questId: string,
  now: number,
): SessionState {
  if (state.phase !== 'idle') return state;
  return {
    phase: 'focus',
    questId,
    endsAt: now + FOCUS_MS,
    consecutiveSkips: state.consecutiveSkips,
  };
}

export function advanceSession(state: SessionState, now: number): SessionState {
  if (state.phase === 'idle') return state;
  if (now < state.endsAt) return state;
  if (state.phase === 'focus') {
    return {
      phase: 'break',
      questId: state.questId,
      endsAt: now + BREAK_MS,
      consecutiveSkips: state.consecutiveSkips,
    };
  }
  return IDLE_SESSION;
}

export function completeFocus(state: SessionState, now: number): SessionState {
  if (state.phase !== 'focus') return state;
  return {
    phase: 'break',
    questId: state.questId,
    endsAt: now + BREAK_MS,
    consecutiveSkips: state.consecutiveSkips,
  };
}

export function skipBreak(state: SessionState): SessionState {
  if (state.phase !== 'break' || state.consecutiveSkips > 0) return state;
  return { phase: 'idle', consecutiveSkips: state.consecutiveSkips + 1 };
}
