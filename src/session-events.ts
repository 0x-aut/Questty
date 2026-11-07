import type { Entity } from '@iwsdk/core';

export type CardActionMode = 'focus' | 'done' | 'disabled' | 'hidden';

let focusStarter: ((entity: Entity) => void) | undefined;
let cardCompleter: ((entity: Entity) => void) | undefined;
let cardNudger: ((entity: Entity) => void) | undefined;
let cardActionModeHandler:
  | ((cardId: string, mode: CardActionMode) => void)
  | undefined;

export function setFocusStarter(handler: ((entity: Entity) => void) | undefined): void {
  focusStarter = handler;
}

export function requestCardFocus(entity: Entity): void {
  focusStarter?.(entity);
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

export function setCardActionModeHandler(
  handler: ((cardId: string, mode: CardActionMode) => void) | undefined,
): void {
  cardActionModeHandler = handler;
}

export function setCardActionMode(cardId: string, mode: CardActionMode): void {
  cardActionModeHandler?.(cardId, mode);
}
