import {
  AudioSource,
  createSystem,
  Grabbed,
  OneHandGrabbable,
  PokeInteractable,
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
  setCardActionModeHandler,
} from './session-events.js';
import {
  beginZoneHold,
  endZoneHold,
  findNearestZone,
  getZonePlacement,
} from './zones.js';

export type QuestCardOptions = {
  title: string;
  xp: number;
  position: Vector3 | readonly [number, number, number];
  zoneId?: 'desk' | 'door' | 'wall';
};

const CARD_SCALE = 0.16;
const FOCUS_ACTION_SCALE = 0.16;
const localCardFront = new Vector3(0, 0, 1);
const localCardRight = new Vector3(1, 0, 0);
const localCardNormal = new Vector3(0, 0, 1);
let activeWorld: World | undefined;
let nextCardId = 1;
const FOCUS_ACTION_ASSET_ID = 'focus-action';

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
  zoneId,
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
  panel.scale.setScalar(CARD_SCALE);

  const entity = activeWorld.createTransformEntity(panel);
  const cardId = `quest-${nextCardId}`;
  nextCardId += 1;
  entity.addComponent(QuestCard, {
    cardId,
    title,
    xp: Math.round(xp),
    zoneId: zoneId ?? '',
    previousZoneId: '',
    previousPosition: worldPosition.toArray(),
  });
  entity.addComponent(OneHandGrabbable);
  entity.addComponent(AudioSource, {
    src: './audio/chime.mp3',
    maxInstances: 1,
    playbackMode: 'fade-restart',
  });
  setQuestCardState(
    entity,
    zoneId === undefined ? 'Grab and pin to a zone' : `Pinned to ${zoneId} - poke to focus`,
  );
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
  private readonly targetPosition = new Vector3();
  private readonly localPosition = new Vector3();
  private readonly normalBuffer = new Vector3();
  private readonly orientationBuffer = new Quaternion();
  private readonly parentQuaternion = new Quaternion();
  private readonly cardWorldPosition = new Vector3();
  private readonly cardWorldQuaternion = new Quaternion();
  private readonly actionPosition = new Vector3();
  private readonly actionRight = new Vector3();
  private readonly actionNormal = new Vector3();
  private readonly pendingFocusCardIds = new Set<string>();
  private readonly actionListeners = new Map<Entity, () => void>();

  init(): void {
    this.queries.heldCards.subscribe('qualify', (entity) => this.onGrab(entity));
    this.queries.heldCards.subscribe('disqualify', (entity) => this.onRelease(entity));
    this.queries.cards.subscribe('qualify', (entity) => {
      if ((entity.getValue(QuestCard, 'zoneId') as string).length > 0) {
        void this.ensureFocusAction(entity);
      }
    });
    this.queries.cards.subscribe('disqualify', (entity) => {
      this.removeActionsForCard(entity.getValue(QuestCard, 'cardId') as string);
    });
    this.queries.tweeningCards.subscribe('qualify', (entity) => {
      this.removeActionsForCard(entity.getValue(QuestCard, 'cardId') as string);
    });
    setCardActionModeHandler((cardId, mode) => this.setActionMode(cardId, mode));
    this.cleanupFuncs.push(() => {
      setCardActionModeHandler(undefined);
      for (const entity of this.queries.actions.entities) this.disposeAction(entity);
    });
  }

  update(): void {
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
    const zoneId = entity.getValue(QuestCard, 'zoneId') as string;
    entity.setValue(QuestCard, 'previousZoneId', zoneId);
    entity.setValue(QuestCard, 'zoneId', '');
    setQuestCardState(entity, 'Move to a zone, then release');
    this.removeActionsForCard(cardId);
    beginZoneHold(cardId);
  }

  private onRelease(entity: Entity): void {
    const cardId = entity.getValue(QuestCard, 'cardId') as string;
    endZoneHold(cardId);

    const object = entity.object3D;
    if (object == null) return;
    object.updateWorldMatrix(true, false);
    object.getWorldPosition(this.positionBuffer);

    const nearest = findNearestZone(this.positionBuffer, 0.4);
    if (nearest === null) {
      this.restorePreviousPosition(entity, object);
      return;
    }

    let stackIndex = 0;
    for (const card of this.queries.cards.entities) {
      if (
        card !== entity &&
        card.getValue(QuestCard, 'zoneId') === nearest.zone.id
      ) {
        stackIndex += 1;
      }
    }

    const placement = getZonePlacement(nearest.zone.id, stackIndex);
    this.normalBuffer
      .copy(placement?.normal ?? nearest.zone.normal)
      .normalize();
    this.targetPosition.copy(placement?.position ?? nearest.zone.position);

    this.setWorldPosition(object, this.targetPosition);
    this.orientationBuffer.setFromUnitVectors(localCardFront, this.normalBuffer);
    this.setWorldQuaternion(object, this.orientationBuffer);
    entity.setValue(QuestCard, 'zoneId', nearest.zone.id);
    entity.setValue(QuestCard, 'previousZoneId', '');
    this.storePreviousPosition(entity, this.targetPosition);
    setQuestCardState(entity, `Pinned to ${nearest.zone.label} - poke to focus`);
    void this.ensureFocusAction(entity);
  }

  private restorePreviousPosition(entity: Entity, object: NonNullable<Entity['object3D']>): void {
    const previous = entity.getVectorView(QuestCard, 'previousPosition');
    this.targetPosition.set(previous[0], previous[1], previous[2]);
    this.setWorldPosition(object, this.targetPosition);
    const previousZoneId = entity.getValue(QuestCard, 'previousZoneId') as string;
    entity.setValue(QuestCard, 'zoneId', previousZoneId);
    entity.setValue(QuestCard, 'previousZoneId', '');
    setQuestCardState(
      entity,
      previousZoneId ? `Pinned to ${previousZoneId} - poke to focus` : 'Grab and pin to a zone',
    );
    if (previousZoneId.length > 0) void this.ensureFocusAction(entity);
  }

  private setWorldPosition(
    object: NonNullable<Entity['object3D']>,
    position: Vector3,
  ): void {
    if (object.parent == null) {
      object.position.copy(position);
      return;
    }
    object.parent.updateWorldMatrix(true, false);
    this.localPosition.copy(position);
    object.parent.worldToLocal(this.localPosition);
    object.position.copy(this.localPosition);
  }

  private setWorldQuaternion(
    object: NonNullable<Entity['object3D']>,
    quaternion: Quaternion,
  ): void {
    if (object.parent == null) {
      object.quaternion.copy(quaternion);
      return;
    }
    object.parent.updateWorldMatrix(true, false);
    object.parent.getWorldQuaternion(this.parentQuaternion);
    object.quaternion.copy(quaternion).premultiply(this.parentQuaternion.invert());
  }

  private storePreviousPosition(entity: Entity, position: Vector3): void {
    const previous = entity.getVectorView(QuestCard, 'previousPosition');
    previous[0] = position.x;
    previous[1] = position.y;
    previous[2] = position.z;
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
      panel.scale.setScalar(FOCUS_ACTION_SCALE);
      this.positionFocusAction(object, panel);
      const action = this.world.createTransformEntity(panel);
      action.object3D!.name = `Focus Action ${cardId}`;
      action.addComponent(QuestFocusAction, { cardId, mode: 'focus' });
      action.addComponent(PokeInteractable);
      const button = panel.requireElementById('focus-action-button');
      const onClick = () => {
        const mode = action.getValue(QuestFocusAction, 'mode') as string;
        if (mode === 'focus') requestCardFocus(card);
        else if (mode === 'done') requestCardCompletion(card);
      };
      button.addEventListener('click', onClick);
      this.actionListeners.set(action, () => button.removeEventListener('click', onClick));
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
    const normalOffset = Math.abs(this.actionNormal.y) >= 0.7 ? 0.35 : 0.08;
    this.actionPosition
      .copy(this.cardWorldPosition)
      .addScaledVector(this.actionRight, 0.39)
      .addScaledVector(this.actionNormal, normalOffset);
    panel.position.copy(this.actionPosition);
    panel.quaternion.copy(this.cardWorldQuaternion);
  }

  private findFocusAction(cardId: string): Entity | undefined {
    for (const action of this.queries.actions.entities) {
      if (action.getValue(QuestFocusAction, 'cardId') === cardId) return action;
    }
    return undefined;
  }

  private setActionMode(
    cardId: string,
    mode: 'focus' | 'done' | 'disabled' | 'hidden',
  ): void {
    const action = this.findFocusAction(cardId);
    const panel = action?.object3D;
    if (action == null || !(panel instanceof UIKitMLAsset)) return;
    const visible = mode === 'focus' || mode === 'done';
    panel.visible = visible;
    action.setValue(QuestFocusAction, 'mode', mode);
    if (visible) {
      panel
        .requireElementById<UIKit.Text>('focus-action-label')
        .setProperties({ text: mode === 'done' ? 'Done' : 'Start focus' });
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
