/**
 * PR 10: the return ritual's rules (pure: no IWSDK imports).
 *
 * When the app opens on a new local day, or after 4+ hours away, a short
 * welcome-back moment says what is waiting (counts by time category and the
 * streak), the cards due today glow in turn, and cards from an earlier day
 * that are not in Today are offered to roll over into Today with one pinch.
 * "Last seen" is saved while the app is open.
 */
import { dayKey } from './streak.js';

export const LAST_SEEN_KEY = 'questty.lastSeen.v1';
export const AWAY_MS = 4 * 60 * 60 * 1000;
/** The whole moment, without a rollover question. */
export const RITUAL_MS = 7_500;
/** With a rollover question: still under 10 s, then it goes and nothing changes. */
export const RITUAL_ROLL_MS = 9_500;
export const MAX_ROLLOVER = 6;
export const GLOW_STEP_MS = 650;
export const MAX_GLOW = 6;

export type WelcomeReason = 'new-day' | 'away';

/** Should the app greet the user? Never on a first run (no last seen). */
export function welcomeReason(lastSeen: number | null, now: number): WelcomeReason | null {
  if (lastSeen === null || !Number.isFinite(lastSeen) || lastSeen > now) return null;
  if (dayKey(lastSeen) !== dayKey(now)) return 'new-day';
  if (now - lastSeen >= AWAY_MS) return 'away';
  return null;
}

/** Card ids are 'q-<ms base 36>-<rand>' (quest-card.ts newCardId): when was it made? */
export function cardCreatedAt(id: string): number | null {
  const m = /^q-([0-9a-z]+)-/u.exec(id);
  if (m === null) return null;
  const t = parseInt(m[1], 36);
  return Number.isFinite(t) && t > 1_500_000_000_000 ? t : null;
}

export type RitualCard = { id: string; title: string; category: string };

/**
 * Yesterday's unfinished cards: made on an earlier day, still open and not in
 * Today. Oldest first, at most MAX_ROLLOVER.
 */
export function rolloverCandidates(cards: readonly RitualCard[], now: number, scheduled: ReadonlySet<string> = new Set()): RitualCard[] {
  const today = dayKey(now);
  return cards
    .map((c) => ({ c, at: cardCreatedAt(c.id) }))
    // PR 11: a card the evening review rolled to a later day was decided already: never asked about again.
    .filter((x) => x.c.category !== 'today' && !scheduled.has(x.c.id) && x.at !== null && dayKey(x.at) < today)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    .slice(0, MAX_ROLLOVER)
    .map((x) => x.c);
}

/** "3 for today, 2 later, 1 before you leave" (zeros left out); a calm line when nothing waits. */
export function countsLine(counts: Record<string, number>): string {
  const parts: string[] = [];
  const today = counts.today ?? 0;
  const later = counts.later ?? 0;
  const leave = counts['before-leave'] ?? 0;
  const unsorted = counts.unsorted ?? 0;
  if (today > 0) parts.push(`${today} for today`);
  if (later > 0) parts.push(`${later} later`);
  if (leave > 0) parts.push(`${leave} before you leave`);
  if (unsorted > 0) parts.push(`${unsorted} unsorted`);
  if (parts.length === 0) return 'Nothing waiting. A clear room.';
  if (parts.length === 1) return `${parts[0][0].toUpperCase()}${parts[0].slice(1)}.`;
  const line = `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${line[0].toUpperCase()}${line.slice(1)}.`;
}

export function streakPhrase(streak: number, status: string): string {
  if (status === 'ember') return `Your ${streak}-day streak is an ember: finish one thing today to keep it.`;
  if (streak <= 0) return 'Finish one thing to light your flame.';
  if (status === 'waiting') return `${streak}-day streak. One finish today keeps it going.`;
  return `${streak}-day streak. Nice.`;
}

/** What the buddy says (one short line for the caption bubble). */
export function welcomeLine(reason: WelcomeReason, counts: Record<string, number>, streak: number, rollover: number, promoted = 0): string {
  const hello = reason === 'new-day' ? 'Good to see you.' : 'Welcome back.';
  const roll = rollover > 0 ? ` ${rollover} from before - roll ${rollover === 1 ? 'it' : 'them'} into Today?` : '';
  const flame = streak > 0 ? ` ${streak}-day streak.` : '';
  // PR 11: cards the evening review rolled to today are already in Today.
  const moved = promoted > 0 ? ` ${promoted} from last night's review ${promoted === 1 ? 'is' : 'are'} in Today.` : '';
  return `${hello} ${countsLine(counts)}${flame}${moved}${roll}`;
}
