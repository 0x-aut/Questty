import {
  AudioSource,
  BoxGeometry,
  createSystem,
  DoubleSide,
  Grabbed,
  Mesh,
  MeshBasicMaterial,
  PokeInteractable,
  RayInteractable,
  Quaternion,
  UIKit,
  UIKitMLAsset,
  Vector3,
  type Entity,
  type World,
} from '@iwsdk/core';
import { QuestCard, QuestCardTween, QuestFocusAction } from './quest-component.js';
import {
  requestCardCompletion,
  requestCardFocus,
  requestCardNudge,
  requestFocusCommand,
  setCardActionModeHandler,
  type CardActionMode,
  type FocusCommand,
  type FocusPanelInfo,
} from './session-events.js';
import { DEFAULT_FOCUS_MIN, focusChoices, suggestedFocusMinutes } from './session.js';
import type { BlurLevel } from './focus-store.js';
import { CARD_UNITS_H, CARD_UNITS_W, FLOAT_CARD_SCALE } from './card-layout.js';
import {
  flyCard,
  getDropTarget,
  setCardWorldPose,
  setGrabMode,
} from './surfaces.js';

export type QuestCardOptions = {
  title: string;
  xp: number;
  position: Vector3 | readonly [number, number, number];
  /** World orientation; defaults to facing +Z. */
  quaternion?: Quaternion;
};

const FOCUS_ACTION_SCALE = 0.12;
const FLOATING_HINT = 'Pinch to grab, drop on a wall, desk or door';
let activeWorld: World | undefined;
let nextCardId = 1;
const FOCUS_ACTION_ASSET_ID = 'focus-action';
const BLUR_LABEL: Record<BlurLevel, string> = { off: 'Blur: Off', soft: 'Blur: Soft', strong: 'Blur: Strong' };
let focusActionEnsurer: ((card: Entity) => void) | undefined;

/** Show the focus panel next to a card that was pinned without a hand release (reload restore). */
export function showFocusActionFor(card: Entity): void {
  focusActionEnsurer?.(card);
}

export function pinnedHint(kind: string): string {
  return `Pinned to ${kind} - pinch Start focus`;
}

export function idleCardHint(entity: Entity): string {
  const zoneId = entity.getValue(QuestCard, 'zoneId') as string;
  return zoneId.length > 0 ? pinnedHint(zoneId) : FLOATING_HINT;
}

export function setQuestCardState(entity: Entity, text: string): void {
  const panel = entity.object3D;
  if (panel instanceof UIKitMLAsset) {
    panel.getElementById<UIKit.Text>('quest-card-state')?.setProperties({ text });
  }
}

export function configureQuestCards(world: World): void {
  activeWorld = world;
}

export async function createQuestCard({
  title,
  xp,
  position,
  quaternion,
}: QuestCardOptions): Promise<Entity> {
  if (activeWorld === undefined) {
    throw new Error('Quest cards have not been initialized with a world.');
  }

  const worldPosition =
    position instanceof Vector3
      ? position.clone()
      : new Vector3(position[0], position[1], position[2]);
  const panel = await activeWorld.assets.instantiate<UIKitMLAsset>('quest-card');
  panel
    .requireElementById<UIKit.Text>('quest-title')
    .setProperties({ text: title });
  panel
    .requireElementById<UIKit.Text>('quest-xp')
    .setProperties({ text: `+${Math.round(xp)} XP` });
  panel.name = `Quest Card: ${title}`;
  panel.position.copy(worldPosition);
  if (quaternion !== undefined) panel.quaternion.copy(quaternion);
  panel.scale.setScalar(FLOAT_CARD_SCALE);
  const hitbox = new Mesh(
    new BoxGeometry(CARD_UNITS_W, CARD_UNITS_H, 0.5),
    new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      colorWrite: false,
      depthWrite: false,
      side: DoubleSide,
    }),
  );
  hitbox.name = 'QuestCardHitbox';
  hitbox.position.z = 0;
  panel.add(hitbox);

  const entity = activeWorld.createTransformEntity(panel);
  const cardId = `quest-${nextCardId}`;
  nextCardId += 1;
  entity.addComponent(QuestCard, {
    cardId,
    title,
    xp: Math.round(xp),
    zoneId: '',
    surfaceId: '',
    userPlaced: false,
  });
  // Pinch-ray grab by default; SurfaceSystem switches to a direct grab when a
  // hand comes within reach of the card.
  setGrabMode(entity, 'ray');
  entity.addComponent(AudioSource, {
    src: './audio/chime.mp3',
    maxInstances: 1,
    playbackMode: 'fade-restart',
  });
  setQuestCardState(entity, FLOATING_HINT);
  return entity;
}

/** Snaps released quest cards to detected room zones. */
export class QuestCardSystem extends createSystem({
  cards: { required: [QuestCard] },
  heldCards: { required: [QuestCard, Grabbed] },
  tweeningCards: { required: [QuestCard, QuestCardTween] },
  actions: { required: [QuestFocusAction] },
}) {
  private readonly positionBuffer = new Vector3();
  private readonly orientationBuffer = new Quaternion();
  private readonly heldHints = new Map<Entity, string>();
  private readonly cardWorldPosition = new Vector3();
  private readonly cardWorldQuaternion = new Quaternion();
  private readonly actionPosition = new Vector3();
  private readonly actionRight = new Vector3();
  private readonly actionNormal = new Vector3();
  private readonly pendingFocusCardIds = new Set<string>();
  private readonly actionListeners = new Map<Entity, () => void>();
  /** Last mode requested per card, applied when its panel is created later. */
  private readonly desiredModes = new Map<string, { mode: CardActionMode; info?: FocusPanelInfo }>();
  private readonly lastInfo = new Map<string, FocusPanelInfo>();

  init(): void {
    this.queries.heldCards.subscribe('qualify', (entity) => this.onGrab(entity));
    this.queries.heldCards.subscribe('disqualify', (entity) => this.onRelease(entity));
    this.queries.cards.subscribe('disqualify', (entity) => {
      this.removeActionsForCard(entity.getValue(QuestCard, 'cardId') as string);
      this.disposeHitbox(entity);
    });
    this.queries.tweeningCards.subscribe('qualify', (entity) => {
      this.removeActionsForCard(entity.getValue(QuestCard, 'cardId') as string);
    });
    setCardActionModeHandler((cardId, mode, info) => this.setActionMode(cardId, mode, info));
    focusActionEnsurer = (card) => void this.ensureFocusAction(card);
    this.cleanupFuncs.push(() => {
      setCardActionModeHandler(undefined);
      focusActionEnsurer = undefined;
      for (const entity of this.queries.actions.entities) this.disposeAction(entity);
    });
  }

  update(): void {
    // A focus button only belongs next to a pinned card.
    for (const action of this.queries.actions.entities) {
      const cardId = action.getValue(QuestFocusAction, 'cardId') as string;
      let pinned = false;
      for (const card of this.queries.cards.entities) {
        if (card.getValue(QuestCard, 'cardId') === cardId) {
          pinned = (card.getValue(QuestCard, 'surfaceId') as string).length > 0 && !card.hasComponent(Grabbed);
          break;
        }
      }
      const mode = action.getValue(QuestFocusAction, 'mode') as string;
      if (!pinned && (mode === 'focus' || mode === 'pick')) this.disposeAction(action);
    }
    for (const [entity, last] of this.heldHints) {
      if (!entity.active) continue;
      const target = getDropTarget(entity.getValue(QuestCard, 'cardId') as string);
      const hint = target === null ? 'Point at a wall, desk or door' : `Release to pin to ${target.label}`;
      if (hint !== last) {
        setQuestCardState(entity, hint);
        this.heldHints.set(entity, hint);
      }
    }
    const now = performance.now();
    for (const entity of this.queries.tweeningCards.entities) {
      const object = entity.object3D;
      if (object == null) {
        entity.dispose();
        continue;
      }
      const duration = Math.max(1, entity.getValue(QuestCardTween, 'durationMs') as number);
      const startedAt = entity.getValue(QuestCardTween, 'startedAt') as number;
      const progress = Math.min(1, Math.max(0, (now - startedAt) / duration));
      const eased = 1 - (1 - progress) * (1 - progress) * (1 - progress);
      const start = entity.getVectorView(QuestCardTween, 'startPosition');
      const target = entity.getVectorView(QuestCardTween, 'targetPosition');
      const startScale = entity.getVectorView(QuestCardTween, 'startScale');
      const targetScale = entity.getVectorView(QuestCardTween, 'targetScale');
      object.position.set(
        start[0] + (target[0] - start[0]) * eased,
        start[1] + (target[1] - start[1]) * eased,
        start[2] + (target[2] - start[2]) * eased,
      );
      object.scale.set(
        startScale[0] + (targetScale[0] - startScale[0]) * eased,
        startScale[1] + (targetScale[1] - startScale[1]) * eased,
        startScale[2] + (targetScale[2] - startScale[2]) * eased,
      );
      if (progress >= 1) entity.dispose();
    }
  }

  private onGrab(entity: Entity): void {
    const cardId = entity.getValue(QuestCard, 'cardId') as string;
    // Lifting a card off a surface unpins it; release decides where it goes.
    entity.setValue(QuestCard, 'zoneId', '');
    entity.setValue(QuestCard, 'surfaceId', '');
    entity.setValue(QuestCard, 'userPlaced', true);
    this.heldHints.set(entity, '');
    this.removeActionsForCard(cardId);
  }

  private onRelease(entity: Entity): void {
    this.heldHints.delete(entity);
    if (!entity.active || entity.hasComponent(QuestCardTween)) return;
    const cardId = entity.getValue(QuestCard, 'cardId') as string;
    const object = entity.object3D;
    if (object == null) return;
    const target = getDropTarget(cardId);
    if (target === null) {
      // Released in mid-air: stay exactly where it was let go, at floating size.
      object.updateWorldMatrix(true, false);
      object.getWorldPosition(this.positionBuffer);
      object.getWorldQuaternion(this.orientationBuffer);
      setCardWorldPose(entity, this.positionBuffer, this.orientationBuffer, FLOAT_CARD_SCALE);
      setQuestCardState(entity, 'Floating - pinch it onto a wall, desk or door');
      return;
    }
    entity.setValue(QuestCard, 'zoneId', target.kind);
    entity.setValue(QuestCard, 'surfaceId', target.surfaceId);
    flyCard(entity, target);
    setQuestCardState(entity, pinnedHint(target.label));
    // The focus button is placed from the card's final pose, after the flight.
    window.setTimeout(() => {
      if (entity.active && entity.getValue(QuestCard, 'surfaceId') === target.surfaceId) {
        void this.ensureFocusAction(entity);
      }
    }, 320);
  }

  private async ensureFocusAction(card: Entity): Promise<void> {
    const cardId = card.getValue(QuestCard, 'cardId') as string;
    if (
      cardId.length === 0 ||
      (card.getValue(QuestCard, 'zoneId') as string).length === 0 ||
      this.pendingFocusCardIds.has(cardId) ||
      this.findFocusAction(cardId) !== undefined
    ) {
      return;
    }
    this.pendingFocusCardIds.add(cardId);
    let panel: UIKitMLAsset | undefined;
    try {
      panel = await this.world.assets.instantiate<UIKitMLAsset>(FOCUS_ACTION_ASSET_ID);
      if (
        !card.active ||
        (card.getValue(QuestCard, 'zoneId') as string).length === 0 ||
        this.findFocusAction(cardId) !== undefined
      ) {
        panel.dispose();
        return;
      }

      const object = card.object3D;
      if (object == null) {
        panel.dispose();
        return;
      }
      panel.name = `Focus Action ${cardId}`;
      panel.scale.setScalar(FOCUS_ACTION_SCALE * (object.scale.x / 0.12));
      this.positionFocusAction(object, panel);
      const action = this.world.createTransformEntity(panel);
      action.object3D!.name = `Focus Action ${cardId}`;
      action.addComponent(QuestFocusAction, { cardId, mode: 'focus' });
      // Pinch-ray (hands or controller trigger) and direct poke both press it.
      action.addComponent(RayInteractable);
      action.addComponent(PokeInteractable);
      const listeners: Array<() => void> = [];
      const on = (id: string, handler: () => void) => {
        const element = panel!.requireElementById(id);
        element.addEventListener('click', handler);
        listeners.push(() => element.removeEventListener('click', handler));
      };
      const mode = () => action.getValue(QuestFocusAction, 'mode') as string;
      on('focus-action-button', () => {
        if (mode() === 'focus') this.setActionMode(cardId, 'pick');
        else if (mode() === 'done') requestCardCompletion(card);
      });
      on('nudge-action-button', () => requestCardNudge(card));
      on('focus-pick-cancel', () => {
        if (mode() === 'pick') this.setActionMode(cardId, 'focus');
      });
      for (let index = 0; index < 4; index += 1) {
        on(`focus-len-${index}`, () => {
          if (mode() !== 'pick') return;
          const minutes = this.choicesFor(card)[index] ?? DEFAULT_FOCUS_MIN;
          if (!requestCardFocus(card, minutes) && mode() === 'pick') this.setActionMode(cardId, 'focus');
        });
      }
      const command = (name: FocusCommand) => () => {
        if (mode() === 'done') requestFocusCommand(card, name);
      };
      on('focus-pause', command('pause-toggle'));
      on('focus-extend', command('extend'));
      on('focus-end', command('end'));
      on('focus-blur', command('blur'));
      this.actionListeners.set(action, () => {
        for (const remove of listeners) remove();
      });
      const desired = this.desiredModes.get(cardId);
      this.desiredModes.delete(cardId);
      if (desired !== undefined) this.setActionMode(cardId, desired.mode, desired.info);
    } catch (error) {
      panel?.dispose();
      console.warn('[quest] Could not create a card focus control.', error);
    } finally {
      this.pendingFocusCardIds.delete(cardId);
    }
  }

  private positionFocusAction(cardObject: NonNullable<Entity['object3D']>, panel: UIKitMLAsset): void {
    cardObject.updateWorldMatrix(true, false);
    cardObject.getWorldPosition(this.cardWorldPosition);
    cardObject.getWorldQuaternion(this.cardWorldQuaternion);
    this.actionRight.set(1, 0, 0).applyQuaternion(this.cardWorldQuaternion);
    this.actionNormal.set(0, 0, 1).applyQuaternion(this.cardWorldQuaternion);
    // Just right of the card, in its plane, a hair in front of it.
    const cardScale = cardObject.scale.x;
    const actionHalfWidth = 1.0 * FOCUS_ACTION_SCALE * (cardScale / 0.12);
    this.actionPosition
      .copy(this.cardWorldPosition)
      .addScaledVector(this.actionRight, (CARD_UNITS_W / 2) * cardScale + actionHalfWidth + 0.015)
      .addScaledVector(this.actionNormal, 0.01);
    panel.position.copy(this.actionPosition);
    panel.quaternion.copy(this.cardWorldQuaternion);
  }

  private findFocusAction(cardId: string): Entity | undefined {
    for (const action of this.queries.actions.entities) {
      if (action.getValue(QuestFocusAction, 'cardId') === cardId) return action;
    }
    return undefined;
  }

  private choicesFor(card: Entity): number[] {
    return focusChoices(suggestedFocusMinutes(card.getValue(QuestCard, 'title') as string));
  }

  private setActionMode(cardId: string, mode: CardActionMode, info?: FocusPanelInfo): void {
    const merged = { ...this.lastInfo.get(cardId), ...info };
    this.lastInfo.set(cardId, merged);
    const action = this.findFocusAction(cardId);
    const panel = action?.object3D;
    if (action == null || !(panel instanceof UIKitMLAsset)) {
      // The panel may still be loading (or not exist yet): apply it on creation.
      this.desiredModes.set(cardId, { mode, info: merged });
      return;
    }
    const visible = mode === 'focus' || mode === 'pick' || mode === 'done';
    panel.visible = visible;
    action.setValue(QuestFocusAction, 'mode', mode);
    const show = (id: string, on: boolean) =>
      panel.requireElementById<UIKit.Text>(id).setProperties({ display: on ? 'flex' : 'none' });
    show('focus-action-button', mode === 'focus' || mode === 'done');
    show('focus-pick', mode === 'pick');
    show('focus-controls', mode === 'done');
    show('nudge-action-button', mode === 'done');
    if (mode === 'focus' || mode === 'done') {
      panel
        .requireElementById<UIKit.Text>('focus-action-label')
        .setProperties({ text: mode === 'done' ? 'Complete' : 'Start focus' });
    }
    if (mode === 'pick') {
      let card: Entity | undefined;
      for (const entity of this.queries.cards.entities) {
        if (entity.getValue(QuestCard, 'cardId') === cardId) card = entity;
      }
      const suggested = card ? suggestedFocusMinutes(card.getValue(QuestCard, 'title') as string) : null;
      const choices = card ? this.choicesFor(card) : focusChoices(null);
      const highlight = suggested ?? DEFAULT_FOCUS_MIN;
      choices.forEach((minutes, index) => {
        panel
          .requireElementById<UIKit.Text>(`focus-len-${index}-label`)
          .setProperties({ text: `${minutes}m` });
        panel
          .requireElementById<UIKit.Text>(`focus-len-${index}`)
          .setProperties({ variant: minutes === highlight ? 'primary' : 'secondary' } as never);
      });
    }
    if (mode === 'done') {
      panel
        .requireElementById<UIKit.Text>('focus-pause-label')
        .setProperties({ text: merged.paused ? 'Resume' : 'Pause' });
      panel
        .requireElementById<UIKit.Text>('focus-blur-label')
        .setProperties({ text: BLUR_LABEL[merged.blur ?? 'soft'] });
    }
  }

  private removeActionsForCard(cardId: string): void {
    for (const action of this.queries.actions.entities) {
      if (action.getValue(QuestFocusAction, 'cardId') === cardId) {
        this.disposeAction(action);
      }
    }
  }

  private disposeAction(action: Entity): void {
    this.actionListeners.get(action)?.();
    this.actionListeners.delete(action);
    if (action.active) action.dispose();
  }

  private disposeHitbox(entity: Entity): void {
    const hitbox = entity.object3D?.getObjectByName('QuestCardHitbox');
    if (!(hitbox instanceof Mesh)) return;
    hitbox.geometry.dispose();
    const materials = Array.isArray(hitbox.material)
      ? hitbox.material
      : [hitbox.material];
    for (const material of materials) material.dispose();
    hitbox.removeFromParent();
  }
}

export function tweenQuestCardTo(
  entity: Entity,
  worldPosition: Vector3,
  durationMs = 900,
): void {
  const object = entity.object3D;
  if (object == null || entity.hasComponent(QuestCardTween)) return;

  const targetPosition = worldPosition.clone();
  if (object.parent !== null) {
    object.parent.updateWorldMatrix(true, false);
    object.parent.worldToLocal(targetPosition);
  }
  entity.setValue(QuestCard, 'zoneId', '');
  entity.addComponent(QuestCardTween, {
    startPosition: object.position.toArray(),
    targetPosition: targetPosition.toArray(),
    startScale: object.scale.toArray(),
    targetScale: [0.02, 0.02, 0.02],
    startedAt: performance.now(),
    durationMs,
  });
}
