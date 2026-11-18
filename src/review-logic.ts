/**
 * PR 11: the evening review's rules (pure: no IWSDK imports).
 *
 * At or after the evening hour (default 18:00 local, configurable) the app
 * offers a short review once a day: flick the cards you finished away (the
 * physical-finish gestures complete them), and everything still open rolls to
 * tomorrow. A rolled card goes to Later with a due day (tomorrow's local
 * date); on that day it is promoted into Today by itself, before the return
 * ritual counts the room, so the ritual never asks about it again.
 */
import { dayKey } from './streak.js';

export const REVIEW_KEY = 'questty.review.v1';
export const DEFAULT_REVIEW_HOUR = 18;
/** Hours the settings row cycles through. */
export const REVIEW_HOURS = [17, 18, 19, 20, 21, 22] as const;
/** Categories that roll to tomorrow; Later stays Later. */
export const ROLLING = new Set(['today', 'unsorted', 'before-leave']);
export const MAX_ROLL = 12;

export type ReviewStore = {
  version: 1;
  hour: number;
  /** Local day the review last ran to an answer (rolled, or timed out unanswered). */
  lastDay: string | null;
  /**
   * Local day the user last dismissed it ("Not now", the X, or "close the review").
   * No automatic offer that day; asking ("review my day") still opens it.
   */
  lastDismissedDay: string | null;
  /** Rolled cards: card id -> local day it is due ('YYYY-MM-DD'). */
  due: Record<string, string>;
};

export const EMPTY_REVIEW: ReviewStore = { version: 1, hour: DEFAULT_REVIEW_HOUR, lastDay: null, lastDismissedDay: null, due: {} };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;

export function parseReview(raw: string | null): ReviewStore {
  if (raw === null) return { ...EMPTY_REVIEW, due: {} };
  try {
    const v = JSON.parse(raw) as Partial<ReviewStore>;
    const hour = Number.isInteger(v.hour) && (v.hour as number) >= 0 && (v.hour as number) <= 23 ? (v.hour as number) : DEFAULT_REVIEW_HOUR;
    const lastDay = typeof v.lastDay === 'string' && DAY_RE.test(v.lastDay) ? v.lastDay : null;
    const lastDismissedDay = typeof v.lastDismissedDay === 'string' && DAY_RE.test(v.lastDismissedDay) ? v.lastDismissedDay : null;
    const due: Record<string, string> = {};
    if (typeof v.due === 'object' && v.due !== null) {
      for (const [id, day] of Object.entries(v.due)) {
        if (typeof id === 'string' && id.length > 0 && id.length <= 64 && typeof day === 'string' && DAY_RE.test(day)) due[id] = day;
      }
    }
    return { version: 1, hour, lastDay, lastDismissedDay, due };
  } catch {
    return { ...EMPTY_REVIEW, due: {} };
  }
}

/** Tomorrow's local day key (noon-anchored, so a 23 or 25 hour DST day is still one day). */
export function tomorrowKey(now: number): string {
  const d = new Date(now);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12, 0, 0, 0);
  return dayKey(next.getTime());
}

/**
 * Should the review offer itself now? At/after the hour, with something open,
 * and not on a day it already ran to an answer or the user dismissed it.
 */
export function reviewDue(now: number, store: Pick<ReviewStore, 'hour' | 'lastDay'> & Partial<Pick<ReviewStore, 'lastDismissedDay'>>, openCount: number): boolean {
  if (openCount <= 0) return false;
  const today = dayKey(now);
  if (store.lastDay === today || store.lastDismissedDay === today) return false;
  return new Date(now).getHours() >= store.hour;
}

export type ReviewCard = { id: string; title: string; category: string };
export type RollStep = { id: string; title: string; from: string; to: 'later'; dueDay: string };

/** What "roll the rest to tomorrow" does: every open card in Today / Unsorted / Before I leave. */
export function rollPlan(cards: readonly ReviewCard[], now: number, due: Record<string, string> = {}): RollStep[] {
  const day = tomorrowKey(now);
  return cards
    .filter((c) => ROLLING.has(c.category) && due[c.id] === undefined)
    .slice(0, MAX_ROLL)
    .map((c) => ({ id: c.id, title: c.title, from: c.category, to: 'later' as const, dueDay: day }));
}

/** Apply a roll to the store (the due map only; categories are set by the caller). */
export function withRolled(store: ReviewStore, steps: readonly RollStep[], now: number): ReviewStore {
  const due = { ...store.due };
  for (const s of steps) due[s.id] = s.dueDay;
  return { ...store, due, lastDay: dayKey(now) };
}

/**
 * Cards whose day has come: promote them into Today. Returns the ids to
 * promote and the store without them. Ids of cards that no longer exist are
 * dropped too (`exists`).
 */
export function promoteDue(store: ReviewStore, now: number, exists: (id: string) => boolean): { promote: string[]; store: ReviewStore } {
  const today = dayKey(now);
  const promote: string[] = [];
  const due: Record<string, string> = {};
  for (const [id, day] of Object.entries(store.due)) {
    if (!exists(id)) continue;
    if (day <= today) promote.push(id);
    else due[id] = day;
  }
  return { promote, store: { ...store, due } };
}

/** "6 pm" for the settings row. */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const suffix = h < 12 ? 'am' : 'pm';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${suffix}`;
}

export function nextReviewHour(hour: number): number {
  const i = REVIEW_HOURS.indexOf(hour as (typeof REVIEW_HOURS)[number]);
  return REVIEW_HOURS[(i + 1) % REVIEW_HOURS.length];
}

/** The review's line: "4 still open. Flick away what you finished; the rest roll to tomorrow." */
export function reviewLine(open: number): string {
  if (open <= 0) return 'Nothing left open. A clear evening.';
  return `${open} still open. Flick away what you finished; the rest roll to tomorrow.`;
}
