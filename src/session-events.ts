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
