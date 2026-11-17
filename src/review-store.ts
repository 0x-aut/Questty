/**
 * PR 11: the evening review's saved state (localStorage `questty.review.v1`):
 * the review hour, the day it last ran, and the cards rolled to a later day.
 * No IWSDK imports: the return ritual and the settings panel read it too.
 */
import { parseReview, REVIEW_KEY, type ReviewStore } from './review-logic.js';

let store: ReviewStore = load();

function load(): ReviewStore {
  try {
    return parseReview(typeof localStorage === 'undefined' ? null : localStorage.getItem(REVIEW_KEY));
  } catch {
    return parseReview(null);
  }
}

export function getReviewStore(): ReviewStore {
  return store;
}

export function saveReviewStore(next: ReviewStore): ReviewStore {
  store = next;
  try {
    localStorage.setItem(REVIEW_KEY, JSON.stringify(next));
  } catch {
    // storage off: in memory only
  }
  return store;
}

/** Re-read after the harness (or another tab) changed it. */
export function reloadReviewStore(): ReviewStore {
  store = load();
  return store;
}

export function reviewHour(): number {
  return store.hour;
}

export function setReviewHour(hour: number): number {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return store.hour;
  saveReviewStore({ ...store, hour });
  return hour;
}

/** Ids rolled to a later day (the ritual leaves these alone: they were decided). */
export function scheduledIds(): Set<string> {
  return new Set(Object.keys(store.due));
}

let ritualRunning = false;
/** The return ritual is on screen (the evening review waits for it to finish). */
export function setRitualRunning(on: boolean): void {
  ritualRunning = on;
}
export function isRitualRunning(): boolean {
  return ritualRunning;
}
