import type { Entity } from '@iwsdk/core';
import type { BlurLevel } from './focus-store.js';

/**
 * Focus panel modes: 'focus' = Start focus, 'pick' = length chips,
 * 'done' = a running/paused focus (Complete + controls), 'disabled' = break,
 * 'hidden' = completed.
 */
export type CardActionMode = 'focus' | 'pick' | 'done' | 'disabled' | 'hidden';

export type FocusPanelInfo = {
  paused?: boolean;
  blur?: BlurLevel;
};

export type FocusCommand = 'pause-toggle' | 'extend' | 'end' | 'blur';

let focusStarter: ((entity: Entity, minutes: number) => boolean) | undefined;
let cardCompleter: ((entity: Entity) => void) | undefined;
let cardNudger: ((entity: Entity) => void) | undefined;
let focusCommander: ((entity: Entity, command: FocusCommand) => void) | undefined;
let cardActionModeHandler:
  | ((cardId: string, mode: CardActionMode, info?: FocusPanelInfo) => void)
  | undefined;

export function setFocusStarter(
  handler: ((entity: Entity, minutes: number) => boolean) | undefined,
): void {
  focusStarter = handler;
}

/** Start a focus of `minutes` on a pinned card. Returns false when refused. */
export function requestCardFocus(entity: Entity, minutes: number): boolean {
  return focusStarter?.(entity, minutes) ?? false;
}

export function setCardCompleter(handler: ((entity: Entity) => void) | undefined): void {
  cardCompleter = handler;
}

export function requestCardCompletion(entity: Entity): void {
  cardCompleter?.(entity);
}

export function setCardNudger(handler: ((entity: Entity) => void) | undefined): void {
  cardNudger = handler;
}

export function requestCardNudge(entity: Entity): void {
  cardNudger?.(entity);
}

export function setFocusCommander(
  handler: ((entity: Entity, command: FocusCommand) => void) | undefined,
): void {
  focusCommander = handler;
}

export function requestFocusCommand(entity: Entity, command: FocusCommand): void {
  focusCommander?.(entity, command);
}

export function setCardActionModeHandler(
  handler: ((cardId: string, mode: CardActionMode, info?: FocusPanelInfo) => void) | undefined,
): void {
  cardActionModeHandler = handler;
}

export function setCardActionMode(cardId: string, mode: CardActionMode, info?: FocusPanelInfo): void {
  cardActionModeHandler?.(cardId, mode, info);
}

// ---- AI buddy (PR 6): drive the real focus timer and completion by voice.

export type FocusSnapshot = {
  cardId: string;
  durationMs: number;
  endsAt: number;
  pausedRemainingMs: number | null;
};

export type BuddyFocusApi = {
  /** The running/paused focus, or null when idle or on a break. */
  snapshot(): FocusSnapshot | null;
  /** Start focus on any card (floating ones too). False when a focus is already running. */
  start(entity: Entity, minutes: number): boolean;
  /** pause | resume | extend (+minutes) | end on the running focus. False when nothing changed. */
  control(command: 'pause' | 'resume' | 'extend' | 'end', minutes?: number): boolean;
  /** Put the focus back exactly as a snapshot had it (null: end any focus). For Undo. */
  restore(snapshot: FocusSnapshot | null): boolean;
  /** Finish a card: the focus completion when it is the focus card, else the same chime, XP and shelf. Returns XP awarded. */
  complete(entity: Entity, visual?: 'shelf' | 'crumple'): number;
  /** PR 10: where finished cards land (the trophy shelf), for the paper-ball arc. */
  shelfPoint?(): [number, number, number];
  /** Undo a completion: take the XP back. */
  revokeXp(amount: number): void;
};

let buddyFocusApi: BuddyFocusApi | undefined;
export function setBuddyFocusApi(api: BuddyFocusApi | undefined): void {
  buddyFocusApi = api;
}
export function getBuddyFocusApi(): BuddyFocusApi | undefined {
  return buddyFocusApi;
}
