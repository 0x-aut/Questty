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
import { uiSafe } from './ui-text.js';
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
import { normalizeCategory } from './category-config.js';
import { DEFAULT_FOCUS_MIN, focusChoices, suggestedFocusMinutes } from './session.js';
import { primeChime, type BlurLevel } from './focus-store.js';
import { CARD_HIT_DEPTH, CARD_UNITS_H, CARD_UNITS_W, FLOAT_CARD_SCALE } from './card-layout.js';
import { setCardFade } from './card-decor.js';
import { getSettings } from './settings.js';

/** PR 10, reduced motion: completion tweens that fade in place instead of flying to the shelf. */
const fadeTweens = new WeakSet<Entity>();
import {
  type SnapTarget,
  flyCard,
  getDropTarget,
  landingTarget,
  setCardWorldPose,
  setGrabMode,
} from './surfaces.js';

export type QuestCardOptions = {
  title: string;
  xp: number;
  position: Vector3 | readonly [number, number, number];
  /** World orientation; defaults to facing +Z. */
  quaternion?: Quaternion;
  /** Stable id (restored cards keep theirs); a new one is minted when omitted. */
  id?: string;
  /** Focus session card: its focus panel works while it floats. */
  focusReady?: boolean;
  /** True when re-created from saved state (not a new card the user asked for). */
  restored?: boolean;
  /** Time category (category-config.ts); Unsorted when omitted or unknown. */
  category?: string;
};

export type CardEventType =
  | 'created'
  | 'grabbed'
  | 'pinned'
  | 'floated'
  | 'focused'
  | 'completed'
  | 'removed'
  | 'categorized'
  /** The title changed (AI buddy rename, PR 6). */
  | 'renamed'
  /** The pose/zone was put back without a hand (AI buddy undo, PR 6): save it. */
  | 'updated'
  /**
   * PR 7: the buddy is about to move the card without a hand (pin to another
   * surface, unpin, glide). Like 'grabbed' for persistence: stop following the
   * old anchor, or it pulls the card straight back to where it was.
   */
  | 'moving';
export type CardEventDetail = { restored?: boolean; target?: SnapTarget; focusReady?: boolean };
type CardListener = (type: CardEventType, entity: Entity, detail: CardEventDetail) => void;
const cardListeners = new Set<CardListener>();
const cardsById = new Map<string, Entity>();

/** Subscribe to card lifecycle events (persistence, coach marks). Returns the unsubscribe. */
export function onCardEvent(listener: CardListener): () => void {
  cardListeners.add(listener);
  return () => cardListeners.delete(listener);
}

/** Emit a card event from another module (categories.ts: 'categorized'). */
export function emitCardEvent(type: CardEventType, entity: Entity, detail: CardEventDetail = {}): void {
  emitCard(type, entity, detail);
}

function emitCard(type: CardEventType, entity: Entity, detail: CardEventDetail = {}): void {
  for (const listener of cardListeners) {
    try {
      listener(type, entity, detail);
    } catch (error) {
      console.warn('[quest] card listener failed', error);
    }
  }
}

/** The live card entity with this stable id, if any. */
export function findQuestCard(id: string): Entity | undefined {
  const entity = cardsById.get(id);
  return entity?.active ? entity : undefined;
}

/** Stable, unique across reloads: time + random (was quest-1, quest-2... per load). */
export function newCardId(): string {
  const random = Math.random().toString(36).slice(2, 7);
  return `q-${Date.now().toString(36)}-${random}`;
}


/** A focus timer started on this card (coach marks step aside). */
export function notifyCardFocused(card: Entity): void {
  emitCard('focused', card);
}

let releaseInterceptor: ((card: Entity) => boolean) | undefined;
/**
 * PR 10: a hook asked first on every card release (physical-finish.ts: a
 * flick). Returning true means it handled the card (no pin, no float).
 */
export function setReleaseInterceptor(fn: ((card: Entity) => boolean) | undefined): void {
  releaseInterceptor = fn;
}

let focusActionMover: ((card: Entity) => void) | undefined;
/** Re-place a card's focus panel after the card moved without a hand (anchor restore). */
export function repositionFocusAction(card: Entity): void {
  focusActionMover?.(card);
}

const FOCUS_ACTION_SCALE = 0.12;
const FLOATING_HINT = 'Pinch to grab, drop on a wall, desk or door';
let activeWorld: World | undefined;
const FOCUS_ACTION_ASSET_ID = 'focus-action';
const BLUR_LABEL: Record<BlurLevel, string> = { off: 'Blur: Off', soft: 'Blur: Soft', strong: 'Blur: Strong' };
let focusActionEnsurer: ((card: Entity) => void) | undefined;
let cardPinner: ((card: Entity, target: SnapTarget) => void) | undefined;

/**
 * Pin a card to a snap target exactly like a hand release does (PR 7: the
 * buddy's spatial tools): zone + surface + userPlaced, the flight that lands
 * it flush, the pinned hint, its focus panel and the 'pinned' event (saved).
 */
export function pinQuestCard(card: Entity, target: SnapTarget): boolean {
  if (cardPinner === undefined || !card.active) return false;
  emitCard('moving', card);
  cardPinner(card, target);
  return true;
}

/** Turn a pinned card back into a floating one in place (the caller moves it). */
export function unpinQuestCard(card: Entity): void {
  if (!card.active) return;
  emitCard('moving', card);
  card.setValue(QuestCard, 'zoneId', '');
  card.setValue(QuestCard, 'surfaceId', '');
  setQuestCardState(card, FLOATING_HINT);
}

/**
 * Cards whose focus panel works while floating: the Focus session quick-start
 * card and any card with a running focus timer. Other cards get it once pinned.
 */
const floatFocusIds = new Set<string>();
export function allowFloatingFocus(cardId: string): void {
  if (cardId.length > 0) floatFocusIds.add(cardId);
}
export function canFocusCard(card: Entity): boolean {
  return (
    (card.getValue(QuestCard, 'zoneId') as string).length > 0 ||
    floatFocusIds.has(card.getValue(QuestCard, 'cardId') as string)
  );
}

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

/** Change a card's title (AI buddy rename). Saved with the card; returns false for a dead card. */
export function renameQuestCard(entity: Entity, title: string): boolean {
  if (!entity.active) return false;
  entity.setValue(QuestCard, 'title', title);
  const panel = entity.object3D;
  if (panel instanceof UIKitMLAsset) {
    panel.getElementById<UIKit.Text>('quest-title')?.setProperties({ text: uiSafe(title) });
    panel.name = `Quest Card: ${title}`;
  }
  emitCard('renamed', entity);
  return true;
}

/** Take a card out of the room for good (AI buddy delete, after a Confirm chip). */
export function removeQuestCard(entity: Entity): void {
  if (entity.active) entity.dispose();
}

export function configureQuestCards(world: World): void {
  activeWorld = world;
}

export async function createQuestCard({
  title,
  xp,
  position,
  quaternion,
  id,
  restored = false,
  focusReady = false,
  category,
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
    .setProperties({ text: uiSafe(title) });
  panel
    .requireElementById<UIKit.Text>('quest-xp')
    .setProperties({ text: `+${Math.round(xp)} XP` });
  panel.name = `Quest Card: ${title}`;
  panel.position.copy(worldPosition);
  if (quaternion !== undefined) panel.quaternion.copy(quaternion);
  panel.scale.setScalar(FLOAT_CARD_SCALE);
  const hitbox = new Mesh(
    // Thin (about +-6 mm), so a pinch-ray at a shallow angle (a card on a desk
    // seen from a chair) can reach the category chip in the card's header;
    // CategorySystem also trims its top below the chip (PR 5).
    new BoxGeometry(CARD_UNITS_W, CARD_UNITS_H, CARD_HIT_DEPTH),
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
  const cardId = id !== undefined && id.length > 0 && !cardsById.has(id) ? id : newCardId();
  cardsById.set(cardId, entity);
  entity.addComponent(QuestCard, {
    cardId,
    title,
    xp: Math.round(xp),
    zoneId: '',
    surfaceId: '',
    userPlaced: false,
    category: normalizeCategory(category),
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
  if (focusReady) floatFocusIds.add(cardId);
  emitCard('created', entity, { restored, focusReady });
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
  private readonly grabStarts = new Map<
    Entity,
    { at: number; position: Vector3; quaternion: Quaternion; scale: number; zoneId: string; surfaceId: string }
  >();
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
      const cardId = entity.getValue(QuestCard, 'cardId') as string;
      if (cardsById.get(cardId) === entity) cardsById.delete(cardId);
      floatFocusIds.delete(cardId);
      emitCard('removed', entity);
      this.removeActionsForCard(cardId);
      this.disposeHitbox(entity);
    });
    this.queries.tweeningCards.subscribe('qualify', (entity) => {
      this.removeActionsForCard(entity.getValue(QuestCard, 'cardId') as string);
    });
    setCardActionModeHandler((cardId, mode, info) => this.setActionMode(cardId, mode, info));
    focusActionEnsurer = (card) => void this.ensureFocusAction(card);
    cardPinner = (card, target) => this.pin(card, target);
    focusActionMover = (card) => {
      const action = this.findFocusAction(card.getValue(QuestCard, 'cardId') as string);
      const panel = action?.object3D;
      if (card.object3D != null && panel instanceof UIKitMLAsset) this.positionFocusAction(card.object3D, panel);
    };
    this.cleanupFuncs.push(() => {
      setCardActionModeHandler(undefined);
      focusActionEnsurer = undefined;
      cardPinner = undefined;
      focusActionMover = undefined;
      for (const entity of this.queries.actions.entities) this.disposeAction(entity);
    });
  }

  update(): void {
    // A focus button only belongs next to a pinned card.
    for (const action of this.queries.actions.entities) {
      const cardId = action.getValue(QuestFocusAction, 'cardId') as string;
      let pinned = false;
      let owner: Entity | undefined;
      for (const card of this.queries.cards.entities) {
        if (card.getValue(QuestCard, 'cardId') === cardId) {
          pinned = (card.getValue(QuestCard, 'surfaceId') as string).length > 0 && !card.hasComponent(Grabbed);
          owner = card;
          break;
        }
      }
      const mode = action.getValue(QuestFocusAction, 'mode') as string;
      if (floatFocusIds.has(cardId)) {
        // A floating-focus card keeps its panel wherever it goes (held, flying, pinned).
        const panel = action.object3D;
        if (owner?.object3D != null && panel instanceof UIKitMLAsset) {
          this.positionFocusAction(owner.object3D, panel);
          panel.scale.setScalar(FOCUS_ACTION_SCALE * (owner.object3D.scale.x / 0.12));
        }
        continue;
      }
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
      if (fadeTweens.has(entity)) setCardFade(object, 1 - progress);
      if (progress >= 1) entity.dispose();
    }
  }

  private onGrab(entity: Entity): void {
    primeChime(); // inside the pinch: lets the settle "tap" play on release
    const cardId = entity.getValue(QuestCard, 'cardId') as string;
    const object = entity.object3D;
    if (object != null) {
      object.updateWorldMatrix(true, false);
      this.grabStarts.set(entity, {
        at: performance.now(),
        position: object.getWorldPosition(new Vector3()),
        quaternion: object.getWorldQuaternion(new Quaternion()),
        scale: object.scale.x,
        zoneId: entity.getValue(QuestCard, 'zoneId') as string,
        surfaceId: entity.getValue(QuestCard, 'surfaceId') as string,
      });
    }
    // Lifting a card off a surface unpins it; release decides where it goes.
    entity.setValue(QuestCard, 'zoneId', '');
    entity.setValue(QuestCard, 'surfaceId', '');
    entity.setValue(QuestCard, 'userPlaced', true);
    this.heldHints.set(entity, '');
    if (!floatFocusIds.has(cardId)) this.removeActionsForCard(cardId);
    emitCard('grabbed', entity);
  }

  private onRelease(entity: Entity): void {
    this.heldHints.delete(entity);
    if (!entity.active || entity.hasComponent(QuestCardTween)) return;
    const cardId = entity.getValue(QuestCard, 'cardId') as string;
    const object = entity.object3D;
    if (object == null) return;
    const start = this.grabStarts.get(entity);
    this.grabStarts.delete(entity);
    if (releaseInterceptor?.(entity) === true) return;
    if (start !== undefined && start.surfaceId.length > 0) {
      object.updateWorldMatrix(true, false);
      const moved = object.getWorldPosition(this.positionBuffer).distanceTo(start.position);
      if (performance.now() - start.at < 450 && moved < 0.03) {
        // A quick pinch-tap on a pinned card: leave it exactly where it was.
        setCardWorldPose(entity, start.position, start.quaternion, start.scale);
        entity.setValue(QuestCard, 'zoneId', start.zoneId);
        entity.setValue(QuestCard, 'surfaceId', start.surfaceId);
        setQuestCardState(entity, pinnedHint(start.zoneId));
        void this.ensureFocusAction(entity);
        return;
      }
    }
    const target = landingTarget(entity);
    if (target === null) {
      // Released in mid-air: stay exactly where it was let go, at floating size.
      object.updateWorldMatrix(true, false);
      object.getWorldPosition(this.positionBuffer);
      object.getWorldQuaternion(this.orientationBuffer);
      setCardWorldPose(entity, this.positionBuffer, this.orientationBuffer, FLOAT_CARD_SCALE);
      setQuestCardState(entity, 'Floating - pinch it onto a wall, desk or door');
      if (floatFocusIds.has(cardId)) void this.ensureFocusAction(entity);
      emitCard('floated', entity);
      return;
    }
    this.pin(entity, target);
  }

  private pin(entity: Entity, target: SnapTarget): void {
    entity.setValue(QuestCard, 'zoneId', target.kind);
    entity.setValue(QuestCard, 'surfaceId', target.surfaceId);
    entity.setValue(QuestCard, 'userPlaced', true);
    flyCard(entity, target);
    setQuestCardState(entity, pinnedHint(target.label));
    // The focus button is placed from the card's final pose, after the flight.
    window.setTimeout(() => {
      if (entity.active && entity.getValue(QuestCard, 'surfaceId') === target.surfaceId) {
        void this.ensureFocusAction(entity);
        emitCard('pinned', entity, { target });
      }
    }, 440);
  }

  private async ensureFocusAction(card: Entity): Promise<void> {
    const cardId = card.getValue(QuestCard, 'cardId') as string;
    if (
      cardId.length === 0 ||
      !canFocusCard(card) ||
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
        !canFocusCard(card) ||
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

  emitCard('completed', entity);
  const reduced = getSettings().reducedMotion;
  const targetPosition = worldPosition.clone();
  if (object.parent !== null) {
    object.parent.updateWorldMatrix(true, false);
    object.parent.worldToLocal(targetPosition);
  }
  if (reduced) fadeTweens.add(entity);
  entity.setValue(QuestCard, 'zoneId', '');
  entity.addComponent(QuestCardTween, {
    startPosition: object.position.toArray(),
    // Reduced motion (PR 10): it stays put and fades out.
    targetPosition: reduced ? object.position.toArray() : targetPosition.toArray(),
    startScale: object.scale.toArray(),
    targetScale: reduced ? object.scale.toArray() : [0.02, 0.02, 0.02],
    startedAt: performance.now(),
    durationMs: reduced ? Math.min(durationMs, 600) : durationMs,
  });
}

/**
 * PR 10, physical finish: the card crumples where it is (a quick shrink while
 * the paper ball grows in its place). Emits 'completed' (persistence drops
 * it) and disposes the card at the end, like the shelf tween.
 */
export function crumpleQuestCard(entity: Entity, durationMs = 260): void {
  const object = entity.object3D;
  if (object == null || entity.hasComponent(QuestCardTween)) return;
  emitCard('completed', entity);
  entity.setValue(QuestCard, 'zoneId', '');
  const reduced = getSettings().reducedMotion;
  if (reduced) fadeTweens.add(entity);
  entity.addComponent(QuestCardTween, {
    startPosition: object.position.toArray(),
    targetPosition: object.position.toArray(),
    startScale: object.scale.toArray(),
    targetScale: reduced ? object.scale.toArray() : [object.scale.x * 0.08, object.scale.y * 0.05, object.scale.z * 0.08],
    startedAt: performance.now(),
    durationMs,
  });
}
