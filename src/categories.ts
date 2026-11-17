/**
 * Time categories (PR 5): sort cards by WHEN, stick them anywhere.
 *
 * A card's category says when the user wants to do it (Today, Later, Before I
 * leave, or Unsorted). It is independent of where the card is stuck: any card
 * can sit on any wall, desk or door, or float.
 *
 * What lives here:
 *  - the public API (for the next PR's AI buddy): getCardsByCategory,
 *    setCardCategory, highlightCategory, onCategoryChanged, getCardCategory,
 *    categoryCounts;
 *  - CategorySystem: the chip under each card, the picker it opens, the
 *    card's edge accent, highlight pulses, the panel pill counts, and the
 *    stand-up "Before you go" reminder.
 *
 * The category list itself is in category-config.ts.
 */
import {
  Box3,
  CanvasTexture,
  createSystem,
  Grabbed,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PokeInteractable,
  Quaternion,
  RayInteractable,
  UIKit,
  UIKitMLAsset,
  Vector3,
  type Entity,
} from '@iwsdk/core';
import {
  BEFORE_LEAVE,
  countedCategories,
  getCategory,
  isCategoryId,
  LATER,
  listCategories,
  TODAY,
  UNSORTED,
  type CategoryId,
} from './category-config.js';
import { CARD_UNITS_H, CARD_UNITS_W } from './card-layout.js';
import { emitCardEvent, findQuestCard, onCardEvent } from './quest-card.js';
import { QuestCard, QuestCardTween } from './quest-component.js';
import { suppressPillOpen } from './panel.js';

export type { CategoryId } from './category-config.js';
export { listCategories, registerCategory, TODAY, LATER, BEFORE_LEAVE, UNSORTED } from './category-config.js';

// ------------------------------------------------------------------ public API

export type CategorySource = 'user' | 'voice' | 'api' | 'restore';
export type CategoryChange = {
  cardId: string;
  title: string;
  category: CategoryId;
  previous: CategoryId;
  source: CategorySource;
};
export type CategorizedCard = {
  cardId: string;
  title: string;
  category: CategoryId;
  /** Kind of surface it is stuck to ('wall' | 'desk' | 'door'), or '' when floating. */
  stuckTo: string;
};

type ChangeListener = (change: CategoryChange) => void;
const changeListeners = new Set<ChangeListener>();
const liveCards = new Map<string, Entity>();
let system: CategorySystem | undefined;

/** Called whenever a card's category changes (by the user, voice, or the API). Returns the unsubscribe. */
export function onCategoryChanged(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function cardEntity(cardId: string): Entity | undefined {
  const entity = findQuestCard(cardId) ?? liveCards.get(cardId);
  return entity?.active ? entity : undefined;
}

function summary(entity: Entity): CategorizedCard {
  return {
    cardId: entity.getValue(QuestCard, 'cardId') as string,
    title: entity.getValue(QuestCard, 'title') as string,
    category: entity.getValue(QuestCard, 'category') as string,
    stuckTo: entity.getValue(QuestCard, 'zoneId') as string,
  };
}

function activeCards(): Entity[] {
  return [...liveCards.values()].filter((e) => e.active && !e.hasComponent(QuestCardTween));
}

/** Every live card in a category (any surface, or floating). */
export function getCardsByCategory(category: CategoryId): CategorizedCard[] {
  return activeCards()
    .filter((e) => e.getValue(QuestCard, 'category') === category)
    .map(summary);
}

/** A card's category, or null when there is no such card. */
export function getCardCategory(cardId: string): CategoryId | null {
  const entity = cardEntity(cardId);
  return entity ? (entity.getValue(QuestCard, 'category') as string) : null;
}

/** Live card count per category (every category in the config, zeros included). */
export function categoryCounts(): Record<CategoryId, number> {
  const counts: Record<CategoryId, number> = {};
  for (const c of listCategories()) counts[c.id] = 0;
  for (const e of activeCards()) {
    const cat = e.getValue(QuestCard, 'category') as string;
    counts[cat] = (counts[cat] ?? 0) + 1;
  }
  return counts;
}

/**
 * Set a card's category. Returns false for an unknown card or category.
 * Saves it with the card and tells onCategoryChanged listeners. Never moves the card.
 */
export function setCardCategory(cardId: string, category: CategoryId, source: CategorySource = 'api'): boolean {
  const entity = cardEntity(cardId);
  if (entity === undefined || !isCategoryId(category)) return false;
  const previous = entity.getValue(QuestCard, 'category') as string;
  if (previous === category) return true;
  entity.setValue(QuestCard, 'category', category);
  system?.refreshCard(entity);
  emitCardEvent('categorized', entity);
  const change: CategoryChange = {
    cardId,
    title: entity.getValue(QuestCard, 'title') as string,
    category,
    previous,
    source,
  };
  notifyChange(change);
  return true;
}

function notifyChange(change: CategoryChange): void {
  for (const listener of changeListeners) {
    try {
      listener(change);
    } catch (error) {
      console.warn('[category] listener failed', error);
    }
  }
}

/** Softly pulse every card in a category, wherever it is. Returns how many cards pulse. */
export function highlightCategory(category: CategoryId, ms = HIGHLIGHT_MS): number {
  return system?.highlight(category, ms) ?? 0;
}

/**
 * Softly pulse specific cards (AI buddy, PR 6: "what's left today?" and the
 * acknowledge pulse when the buddy touches a card). Returns how many pulse.
 */
export function pulseCards(cardIds: readonly string[], ms = HIGHLIGHT_MS, color?: string): number {
  return system?.pulseIds(cardIds, ms, color) ?? 0;
}

// ------------------------------------------------------------------ visuals

const HIGHLIGHT_MS = 3300;
const CHIP_RENDER_ORDER = 2;
const CHIP_HALF_H = 0.18; // card units (category-chip.uikitml: 36px tall)
const CHIP_MARGIN = 0.07;
const CHIP_TILT_FROM = (35 * Math.PI) / 180;
const CHIP_MAX_TILT = (55 * Math.PI) / 180;
const X_AXIS = new Vector3(1, 0, 0);
const PICKER_RENDER_ORDER = 4;
const PULSE_PERIOD_MS = 1100;
const FACE_W = CARD_UNITS_W * 0.99;
const FACE_H = CARD_UNITS_H * 0.9;
const PICKER_W = 2.04;
const PICKER_FORWARD_M = 0.06;
const PICKER_BASE_SCALE = 0.09;
const PICKER_IDLE_MS = 25_000;
const TOAST_MS = 6_000;
const STAND_RISE_M = 0.35;
const STAND_HOLD_S = 1.0;
const SIT_BACK_M = 0.2;
const LEAVE_THROTTLE_MS = 10 * 60 * 1000;
const BASELINE_DOWN_S = 30;
const BASELINE_UP_S = 8;
const BASELINE_FOLLOW_M = 0.3;
const PICKER_SLOTS = ['today', 'later', 'before-leave', 'unsorted', 'custom'] as const;

let glowTexture: CanvasTexture | undefined;
function getGlowTexture(): CanvasTexture {
  if (glowTexture !== undefined) return glowTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    ctx.filter = 'blur(9px)';
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    const x = 16;
    const y = 16;
    const w = 96;
    const h = 96;
    const r = 18;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }
  glowTexture = new CanvasTexture(canvas);
  return glowTexture;
}

type CardDecor = {
  chip?: Entity;
  chipPanel?: UIKitMLAsset;
  chipPending: boolean;
  chipCleanup?: () => void;
  strip?: Mesh;
  glow?: Mesh;
  shown?: string;
  hitbox?: Mesh;
  hitTop?: number;
  tilt?: number;
};

type Pulse = { start: number; until: number; color: string };

export class CategorySystem extends createSystem({
  cards: { required: [QuestCard] },
}) {
  private readonly decor = new Map<string, CardDecor>();
  private readonly pulses = new Map<string, Pulse>();
  private picker?: { entity: Entity; panel: UIKitMLAsset };
  private pickerPending = false;
  private pickerCardId: string | null = null;
  private pickerOpenedAt = 0;
  /** How far the open picker is raised to clear a desk card (null: not measured yet for this open). */
  private pickerLift: number | null = null;
  private pickerSlots: Array<CategoryId | null> = [];
  private pickerCloseTimer: number | undefined;
  private toast?: { entity: Entity; panel: UIKitMLAsset };
  private toastPending = false;
  private toastUntil = 0;
  private toastText = '';
  private countsKey = '';
  private countsAt = 0;
  // Stand-up detection (seated baseline of the head height).
  private baseline: number | null = null;
  private baselineFrom = 0;
  private standFor = 0;
  private standing = false;
  private standAt = 0;
  private lastLeaveToastAt = -Infinity;
  private readonly standLog: Array<{ at: number; result: 'shown' | 'throttled' | 'none'; count: number }> = [];
  private readonly p = new Vector3();
  private readonly q = new Quaternion();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly normal = new Vector3();
  private readonly head = new Vector3();
  private readonly look = new Matrix4();
  private readonly tiltQ = new Quaternion();

  init(): void {
    system = this;
    const off = onCardEvent((type, entity, detail) => {
      const cardId = entity.getValue(QuestCard, 'cardId') as string;
      if (type === 'created') {
        liveCards.set(cardId, entity);
        void this.ensureChip(entity);
        const category = entity.getValue(QuestCard, 'category') as string;
        if (!detail.restored && category !== UNSORTED) {
          // A new card born with a category (voice timing words).
          notifyChange({
            cardId,
            title: entity.getValue(QuestCard, 'title') as string,
            category,
            previous: UNSORTED,
            source: 'voice',
          });
        }
      } else if (type === 'grabbed') {
        if (this.pickerCardId === cardId) this.closePicker();
      } else if (type === 'completed' || type === 'removed') {
        if (type === 'removed' && liveCards.get(cardId) === entity) liveCards.delete(cardId);
        if (this.pickerCardId === cardId) this.closePicker();
        this.disposeDecor(cardId);
        this.pulses.delete(cardId);
      }
    });
    for (const entity of this.queries.cards.entities) {
      liveCards.set(entity.getValue(QuestCard, 'cardId') as string, entity);
    }
    this.wirePill();

    const xr = this.world.renderer.xr;
    const onStart = () => {
      this.baseline = null;
      this.baselineFrom = performance.now() + 1500;
      this.standing = false;
      this.standFor = 0;
    };
    xr.addEventListener('sessionstart', onStart);

    if (import.meta.env.DEV) {
      const devChanges: CategoryChange[] = [];
      this.cleanupFuncs.push(onCategoryChanged((c) => devChanges.push(c)));
      const w = window as unknown as { __questty?: Record<string, unknown> };
      w.__questty = {
        ...w.__questty,
        categoryState: () => this.debugState(),
        categories: {
          getCardsByCategory,
          setCardCategory,
          highlightCategory,
          getCardCategory,
          categoryCounts,
          // Test view of onCategoryChanged: every change since load.
          changes: () => [...devChanges],
        },
      };
    }

    this.cleanupFuncs.push(off, () => {
      xr.removeEventListener('sessionstart', onStart);
      window.clearTimeout(this.pickerCloseTimer);
      if (system === this) system = undefined;
    });
  }

  update(): void {
    const now = performance.now();
    for (const card of this.queries.cards.entities) {
      const cardId = card.getValue(QuestCard, 'cardId') as string;
      if (!liveCards.has(cardId)) liveCards.set(cardId, card);
      const decor = this.decor.get(cardId);
      if (decor === undefined || (decor.chip === undefined && !decor.chipPending)) {
        void this.ensureChip(card);
        continue;
      }
      if (decor.shown !== (card.getValue(QuestCard, 'category') as string)) this.refreshCard(card);
      this.placeChip(card, decor);
      this.updatePulse(cardId, decor, now);
    }
    if (this.pickerCardId !== null) {
      const card = cardEntity(this.pickerCardId);
      if (card === undefined || card.hasComponent(Grabbed) || now - this.pickerOpenedAt > PICKER_IDLE_MS) {
        this.closePicker();
      } else {
        this.placePicker(card);
      }
    }
    if (now - this.countsAt > 300) {
      this.countsAt = now;
      this.updatePillCounts();
    }
    this.updateStand(now);
    if (this.toast !== undefined && this.toast.panel.visible) {
      if (now > this.toastUntil) this.toast.panel.visible = false;
      else this.placeToast();
    }
  }

  // ------------------------------------------------------------ chip

  private async ensureChip(card: Entity): Promise<void> {
    const cardId = card.getValue(QuestCard, 'cardId') as string;
    let decor = this.decor.get(cardId);
    if (decor === undefined) {
      decor = { chipPending: false };
      this.decor.set(cardId, decor);
    }
    if (decor.chip !== undefined || decor.chipPending || cardId.length === 0) return;
    decor.chipPending = true;
    try {
      const panel = await this.world.assets.instantiate<UIKitMLAsset>('category-chip');
      if (!card.active || this.decor.get(cardId) !== decor) {
        panel.dispose();
        return;
      }
      panel.name = `Category Chip ${cardId}`;
      const entity = this.world.createTransformEntity(panel);
      entity.object3D!.name = `Category Chip ${cardId}`;
      // Its own entity (not a child of the card): a pinch on it never reaches
      // the card's grab handle, so setting a category can't drag the card.
      entity.addComponent(RayInteractable);
      entity.addComponent(PokeInteractable);
      const chip = panel.requireElementById('cat-chip');
      // Drawn after the card face it sits on (both are transparent UIKit panels,
      // so without this the distance sort can hide the chip behind the card).
      chip.setProperties({ renderOrder: CHIP_RENDER_ORDER } as never);
      const onClick = () => this.togglePicker(cardId);
      chip.addEventListener('click', onClick);
      decor.chip = entity;
      decor.chipPanel = panel;
      decor.chipCleanup = () => chip.removeEventListener('click', onClick);
      this.refreshCard(card);
      this.placeChip(card, decor);
    } catch (error) {
      console.warn('[category] Could not create a category chip.', error);
    } finally {
      decor.chipPending = false;
    }
  }

  /** Re-draw a card's chip label, dot and edge accent from its category. */
  refreshCard(card: Entity): void {
    const cardId = card.getValue(QuestCard, 'cardId') as string;
    const decor = this.decor.get(cardId);
    if (decor === undefined) return;
    const cat = card.getValue(QuestCard, 'category') as string;
    const def = getCategory(cat) ?? getCategory(UNSORTED)!;
    decor.shown = cat;
    decor.chipPanel
      ?.getElementById<UIKit.Text>('cat-chip-label')
      ?.setProperties({ text: def.id === UNSORTED ? 'When?' : def.label });
    decor.chipPanel?.getElementById<UIKit.Text>('cat-chip-dot')?.setProperties({ backgroundColor: def.accent });
    // Wider chip for the long label; the card's header slot keeps the same width.
    const width = def.label.length > 9 ? 140 : 118;
    decor.chipPanel?.getElementById<UIKit.Text>('cat-chip')?.setProperties({ width } as never);
    const panel = card.object3D;
    if (panel == null) return;
    if (panel instanceof UIKitMLAsset) {
      panel.getElementById<UIKit.Text>('quest-chip-slot')?.setProperties({ width } as never);
    }
    if (decor.strip === undefined) {
      // A thin accent along the card's left edge, inside the paper face.
      const strip = new Mesh(
        new PlaneGeometry(0.075, FACE_H * 0.56),
        new MeshBasicMaterial({ color: def.accent, transparent: true, opacity: 0.95, depthWrite: false }),
      );
      strip.name = 'CategoryAccent';
      strip.renderOrder = CHIP_RENDER_ORDER; // after the card face (see the chip)
      strip.raycast = () => undefined;
      strip.position.set(-FACE_W / 2 + 0.1, -0.3, 0.012);
      panel.add(strip);
      decor.strip = strip;
    }
    (decor.strip.material as MeshBasicMaterial).color.set(def.accent);
    decor.strip.visible = def.id !== UNSORTED;
  }

  /** Over the card's header slot (top-left), a hair in front of the face. */
  private placeChip(card: Entity, decor: CardDecor): void {
    const chipObj = decor.chip?.object3D;
    const cardObj = card.object3D;
    if (chipObj == null || !(cardObj instanceof UIKitMLAsset)) return;
    const hidden = card.hasComponent(QuestCardTween);
    chipObj.visible = !hidden;
    if (hidden) return;
    const slot = cardObj.getElementById('quest-chip-slot');
    cardObj.updateWorldMatrix(true, false);
    cardObj.getWorldQuaternion(this.q);
    this.normal.set(0, 0, 1).applyQuaternion(this.q);
    if (slot != null) {
      slot.updateWorldMatrix(true, false);
      slot.getWorldPosition(this.p);
      this.trimHitbox(cardObj, decor);
    } else {
      cardObj.getWorldPosition(this.p);
      this.right.set(1, 0, 0).applyQuaternion(this.q);
      this.up.set(0, 1, 0).applyQuaternion(this.q);
      const s = cardObj.scale.x;
      this.p.addScaledVector(this.right, (-CARD_UNITS_W / 2 + 0.8) * s).addScaledVector(this.up, (CARD_UNITS_H / 2 - 0.45) * s);
    }
    // Seen at a slant (a card on a desk, or high on a wall), the chip flips up
    // like a paper tab, hinged on its lower edge, so it stays a big enough
    // pinch target; head-on it lies flat on the card.
    const s = cardObj.scale.x;
    this.world.player.head.getWorldPosition(this.head);
    const toHead = this.head.sub(this.p).normalize();
    this.up.set(0, 1, 0).applyQuaternion(this.q);
    const slant = Math.acos(Math.min(1, Math.max(-1, toHead.dot(this.normal))));
    const tilt = toHead.dot(this.up) < 0 ? Math.min(CHIP_MAX_TILT, Math.max(0, slant - CHIP_TILT_FROM)) : 0;
    const half = CHIP_HALF_H * s;
    chipObj.position
      .copy(this.p)
      .addScaledVector(this.normal, 0.003 + half * Math.sin(tilt))
      .addScaledVector(this.up, half * Math.cos(tilt) - half);
    this.tiltQ.setFromAxisAngle(X_AXIS, tilt);
    chipObj.quaternion.copy(this.q).multiply(this.tiltQ);
    decor.tilt = tilt;
    chipObj.scale.setScalar(cardObj.scale.x);
  }

  /**
   * The card's grab hitbox stops just below the chip (the face's height
   * follows its title, so the chip's height on the card varies): a pinch on
   * the chip can never start a drag of the card.
   */
  private trimHitbox(cardObj: UIKitMLAsset, decor: CardDecor): void {
    const hitbox = decor.hitbox ?? (cardObj.getObjectByName('QuestCardHitbox') as Mesh | undefined);
    if (hitbox === undefined) return;
    decor.hitbox = hitbox;
    const local = cardObj.worldToLocal(this.p.clone());
    const top = Math.min(CARD_UNITS_H / 2, local.y - CHIP_HALF_H - CHIP_MARGIN);
    if (decor.hitTop !== undefined && Math.abs(decor.hitTop - top) < 0.01) return;
    decor.hitTop = top;
    const height = Math.max(0.5, top + CARD_UNITS_H / 2);
    hitbox.scale.y = height / CARD_UNITS_H;
    hitbox.position.y = top - height / 2;
  }

  private disposeDecor(cardId: string): void {
    const decor = this.decor.get(cardId);
    if (decor === undefined) return;
    this.decor.delete(cardId);
    decor.chipCleanup?.();
    if (decor.chip?.active) decor.chip.dispose();
    for (const mesh of [decor.strip, decor.glow]) {
      if (mesh === undefined) continue;
      mesh.removeFromParent();
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
    }
  }

  // ------------------------------------------------------------ picker

  private togglePicker(cardId: string): void {
    if (this.pickerCardId === cardId) {
      this.closePicker();
      return;
    }
    void this.openPicker(cardId);
  }

  private async openPicker(cardId: string): Promise<void> {
    if (this.picker === undefined) {
      if (this.pickerPending) return;
      this.pickerPending = true;
      try {
        const panel = await this.world.assets.instantiate<UIKitMLAsset>('category-picker');
        panel.name = 'Category Picker';
        const entity = this.world.createTransformEntity(panel);
        entity.object3D!.name = 'Category Picker';
        entity.addComponent(RayInteractable);
        entity.addComponent(PokeInteractable);
        PICKER_SLOTS.forEach((slot, index) => {
          panel.requireElementById(`cat-opt-${slot}`).addEventListener('click', () => this.onPick(index));
        });
        panel.requireElementById('cat-picker').setProperties({ renderOrder: PICKER_RENDER_ORDER } as never);
        panel.visible = false;
        this.picker = { entity, panel };
      } catch (error) {
        console.warn('[category] Could not create the category picker.', error);
        return;
      } finally {
        this.pickerPending = false;
      }
    }
    const card = cardEntity(cardId);
    if (card === undefined) return;
    const current = card.getValue(QuestCard, 'category') as string;
    const custom = listCategories().find((c) => !c.builtin);
    this.pickerSlots = [TODAY, LATER, BEFORE_LEAVE, UNSORTED, custom?.id ?? null];
    const panel = this.picker.panel;
    PICKER_SLOTS.forEach((slot, index) => {
      const cat = this.pickerSlots[index];
      const def = cat !== null ? getCategory(cat) : undefined;
      const el = panel.getElementById<UIKit.Text>(`cat-opt-${slot}`);
      if (def === undefined) {
        el?.setProperties({ display: 'none' });
        return;
      }
      const selected = def.id === current;
      el?.setProperties({
        display: 'flex',
        backgroundColor: selected ? '#d8ceb8' : '#e7e0d0',
        borderColor: selected ? def.accent : '#e7e0d0',
        borderWidth: selected ? 2 : 1,
      } as never);
      panel.getElementById<UIKit.Text>(`cat-opt-${slot}-label`)?.setProperties({ text: def.label });
      panel.getElementById<UIKit.Text>(`cat-opt-${slot}-dot`)?.setProperties({ backgroundColor: def.accent });
    });
    window.clearTimeout(this.pickerCloseTimer);
    this.pickerCardId = cardId;
    this.pickerOpenedAt = performance.now();
    this.pickerLift = null;
    this.placePicker(card);
    panel.visible = true;
  }

  private onPick(index: number): void {
    const cardId = this.pickerCardId;
    const cat = this.pickerSlots[index];
    if (cardId === null || cat === null || cat === undefined || this.picker?.panel.visible !== true) return;
    setCardCategory(cardId, cat, 'user');
    // Show the choice for a beat, then get out of the way.
    const def = getCategory(cat);
    PICKER_SLOTS.forEach((slot, i) => {
      const on = i === index;
      this.picker?.panel.getElementById<UIKit.Text>(`cat-opt-${slot}`)?.setProperties({
        backgroundColor: on ? '#d8ceb8' : '#e7e0d0',
        borderColor: on ? (def?.accent ?? '#e7e0d0') : '#e7e0d0',
        borderWidth: on ? 2 : 1,
      } as never);
    });
    window.clearTimeout(this.pickerCloseTimer);
    this.pickerCloseTimer = window.setTimeout(() => {
      if (this.pickerCardId === cardId) this.closePicker();
    }, 350);
  }

  private closePicker(): void {
    window.clearTimeout(this.pickerCloseTimer);
    this.pickerCardId = null;
    if (this.picker !== undefined) this.picker.panel.visible = false;
  }

  /** In front of the card (toward the user), shifted to its left, facing the eyes. */
  private placePicker(card: Entity): void {
    const panel = this.picker?.panel;
    const cardObj = card.object3D;
    if (panel === undefined || cardObj == null) return;
    cardObj.updateWorldMatrix(true, false);
    cardObj.getWorldPosition(this.p);
    cardObj.getWorldQuaternion(this.q);
    this.normal.set(0, 0, 1).applyQuaternion(this.q);
    this.world.player.head.getWorldPosition(this.head);
    const s = cardObj.scale.x;
    const position = this.p.clone().addScaledVector(this.normal, PICKER_FORWARD_M);
    this.look.lookAt(this.head, position, new Vector3(0, 1, 0));
    panel.quaternion.setFromRotationMatrix(this.look);
    this.right.set(1, 0, 0).applyQuaternion(panel.quaternion);
    const distance = this.head.distanceTo(position);
    const scale = Math.min(0.3, PICKER_BASE_SCALE * Math.max(1, distance / 0.65));
    // Left of the card's centre, so the card's title stays in view on the right.
    position.addScaledVector(this.right, -((CARD_UNITS_W / 2) * s * 0.55 + (PICKER_W / 2) * scale * 0.35));
    panel.position.copy(position);
    panel.scale.setScalar(scale);
    // A card lying on a desk: keep the whole picker above the card. Its lower rows used to dip
    // below the desk top, behind the card's own hitbox, where a pinch-ray could not reach them
    // (UIKit draws over everything, so it looked fine). Seen once the lantern moved desk cards.
    // Measured once per open (the picker is re-placed every frame), then reused.
    if (this.normal.y > 0.7) {
      if (this.pickerLift === null) {
        panel.updateWorldMatrix(true, true);
        const minY = new Box3().setFromObject(panel).min.y;
        if (Number.isFinite(minY)) this.pickerLift = Math.max(0, this.p.y + 0.012 - minY);
      }
      panel.position.y += this.pickerLift ?? 0;
    }
  }

  // ------------------------------------------------------------ highlight

  highlight(category: CategoryId, ms: number): number {
    const def = getCategory(category);
    if (def === undefined) return 0;
    const now = performance.now();
    let n = 0;
    for (const card of activeCards()) {
      if (card.getValue(QuestCard, 'category') !== category) continue;
      const cardId = card.getValue(QuestCard, 'cardId') as string;
      this.pulses.set(cardId, { start: now, until: now + ms, color: def.accent });
      n += 1;
    }
    return n;
  }

  pulseIds(cardIds: readonly string[], ms: number, color?: string): number {
    const now = performance.now();
    let n = 0;
    for (const cardId of cardIds) {
      const card = cardEntity(cardId);
      if (card === undefined || card.hasComponent(QuestCardTween)) continue;
      const def = getCategory(card.getValue(QuestCard, 'category') as string) ?? getCategory(UNSORTED)!;
      // A short acknowledge pulse never cuts a longer highlight short.
      const current = this.pulses.get(cardId);
      if (current !== undefined && current.until > now + ms) continue;
      this.pulses.set(cardId, { start: now, until: now + ms, color: color ?? def.accent });
      n += 1;
    }
    return n;
  }

  private updatePulse(cardId: string, decor: CardDecor, now: number): void {
    const pulse = this.pulses.get(cardId);
    if (pulse === undefined) {
      if (decor.glow !== undefined && decor.glow.visible) decor.glow.visible = false;
      return;
    }
    if (now >= pulse.until) {
      this.pulses.delete(cardId);
      if (decor.glow !== undefined) decor.glow.visible = false;
      return;
    }
    const card = cardEntity(cardId);
    const panel = card?.object3D;
    if (card === undefined || panel == null) return;
    if (decor.glow === undefined) {
      const glow = new Mesh(
        new PlaneGeometry(CARD_UNITS_W * 1.38, CARD_UNITS_H * 1.3),
        new MeshBasicMaterial({ map: getGlowTexture(), transparent: true, opacity: 0, depthWrite: false }),
      );
      glow.name = 'CategoryGlow';
      glow.raycast = () => undefined;
      glow.renderOrder = -1;
      panel.add(glow);
      decor.glow = glow;
    }
    const s = Math.max(1e-3, panel.scale.x);
    const pinned = (card.getValue(QuestCard, 'surfaceId') as string).length > 0 && !card.hasComponent(Grabbed);
    // Behind the face: on the surface for a pinned card, a little behind a floating one.
    decor.glow.position.set(0, 0, (pinned ? -0.0012 : -0.004) / s);
    const material = decor.glow.material as MeshBasicMaterial;
    material.color.set(pulse.color);
    const t = (now - pulse.start) / PULSE_PERIOD_MS;
    material.opacity = 0.62 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t));
    decor.glow.visible = true;
  }

  // ------------------------------------------------------------ pill counts

  private wirePill(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    if (panel == null) return;
    const slots: Array<[string, () => CategoryId | undefined]> = [
      ['today', () => TODAY],
      ['later', () => LATER],
      ['before-leave', () => BEFORE_LEAVE],
      ['custom', () => listCategories().find((c) => !c.builtin)?.id],
    ];
    for (const [slot, cat] of slots) {
      const el = panel.getElementById(`pill-count-${slot}`);
      if (el == null) continue;
      const onClick = (event?: { stopPropagation?: () => void }) => {
        // This pinch highlights cards; it must not also open the panel.
        suppressPillOpen();
        event?.stopPropagation?.();
        const id = cat();
        if (id !== undefined) highlightCategory(id);
      };
      el.addEventListener('click', onClick as never);
      this.cleanupFuncs.push(() => el.removeEventListener('click', onClick as never));
    }
  }

  private updatePillCounts(): void {
    const counts = categoryCounts();
    const shown = countedCategories();
    const key = shown.map((c) => `${c.id}:${counts[c.id] ?? 0}`).join('|');
    if (key === this.countsKey) return;
    this.countsKey = key;
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    if (panel == null) return;
    const total = shown.reduce((sum, c) => sum + (counts[c.id] ?? 0), 0);
    panel.getElementById<UIKit.Text>('pill-counts')?.setProperties({ display: total > 0 ? 'flex' : 'none' });
    for (const def of shown) {
      const slot = def.builtin ? def.id : 'custom';
      panel.getElementById<UIKit.Text>(`pill-count-${slot}-text`)?.setProperties({ text: `${def.short} ${counts[def.id] ?? 0}` });
      if (!def.builtin) {
        panel.getElementById<UIKit.Text>('pill-count-custom')?.setProperties({ display: (counts[def.id] ?? 0) > 0 ? 'flex' : 'none' });
        panel.getElementById<UIKit.Text>('pill-count-custom-dot')?.setProperties({ backgroundColor: def.accent });
      }
    }
  }

  // ------------------------------------------------------------ stand-up reminder

  private updateStand(now: number): void {
    const xr = this.world.renderer.xr;
    if (!xr.isPresenting || now < this.baselineFrom) return;
    const head = this.world.player.head;
    head.updateWorldMatrix(true, false);
    const y = head.getWorldPosition(this.head).y;
    if (y < 0.4) return; // no tracking yet
    // Wall-clock step (frames can be slow), capped so a stall can't count as a hold.
    const dt = Math.min(1, Math.max(0, (now - (this.standAt || now)) / 1000));
    this.standAt = now;
    if (this.baseline === null) {
      this.baseline = y;
      return;
    }
    const rise = y - this.baseline;
    if (rise < 0) {
      // Lower than the baseline (leaning in for a closer look, or slouching):
      // follow slowly, so a short lean doesn't make sitting back up look like standing.
      this.baseline += rise * Math.min(1, dt / BASELINE_DOWN_S);
    } else if (rise < BASELINE_FOLLOW_M && !this.standing) {
      // Back up to (or a little above) the usual seated height: follow quicker.
      this.baseline += rise * Math.min(1, dt / BASELINE_UP_S);
    }
    if (rise > STAND_RISE_M) {
      this.standFor += dt;
      if (!this.standing && this.standFor > STAND_HOLD_S) {
        this.standing = true;
        this.onStandUp(now);
      }
    } else {
      this.standFor = 0;
      if (rise < SIT_BACK_M) this.standing = false;
    }
  }

  private onStandUp(now: number): void {
    const count = getCardsByCategory(BEFORE_LEAVE).length;
    if (count === 0) {
      this.standLog.push({ at: now, result: 'none', count });
      return;
    }
    if (now - this.lastLeaveToastAt < LEAVE_THROTTLE_MS) {
      this.standLog.push({ at: now, result: 'throttled', count });
      return;
    }
    this.lastLeaveToastAt = now;
    this.standLog.push({ at: now, result: 'shown', count });
    highlightCategory(BEFORE_LEAVE, 4400);
    void this.showToast(`Before you go: ${count} thing${count === 1 ? '' : 's'}`);
  }

  private async showToast(text: string): Promise<void> {
    this.toastText = text;
    this.toastUntil = performance.now() + TOAST_MS;
    if (this.toast === undefined) {
      if (this.toastPending) return;
      this.toastPending = true;
      try {
        const panel = await this.world.assets.instantiate<UIKitMLAsset>('category-toast');
        panel.name = 'Category Toast';
        const entity = this.world.createTransformEntity(panel);
        entity.object3D!.name = 'Category Toast';
        panel.requireElementById('cat-toast').setProperties({ renderOrder: PICKER_RENDER_ORDER } as never);
        this.toast = { entity, panel };
      } catch (error) {
        console.warn('[category] Could not create the toast.', error);
        return;
      } finally {
        this.toastPending = false;
      }
    }
    this.toast.panel.getElementById<UIKit.Text>('cat-toast-text')?.setProperties({ text: this.toastText });
    this.toast.panel.visible = true;
    this.placeToast();
  }

  /** Just above the home panel, facing the eyes. */
  private placeToast(): void {
    const toast = this.toast?.panel;
    const home = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    if (toast === undefined || home == null) return;
    home.updateWorldMatrix(true, false);
    home.getWorldPosition(this.p);
    this.world.player.head.getWorldPosition(this.head);
    const position = this.p.clone();
    position.y += 0.12;
    position.addScaledVector(this.head.clone().sub(position).normalize(), 0.03);
    this.look.lookAt(this.head, position, new Vector3(0, 1, 0));
    toast.quaternion.setFromRotationMatrix(this.look);
    toast.position.copy(position);
    toast.scale.setScalar(0.1);
  }

  // ------------------------------------------------------------ dev view

  private debugState() {
    const now = performance.now();
    return {
      cards: activeCards().map((card) => {
        const cardId = card.getValue(QuestCard, 'cardId') as string;
        const decor = this.decor.get(cardId);
        return {
          ...summary(card),
          chip: decor?.chip !== undefined,
          chipVisible: decor?.chip?.object3D?.visible ?? false,
          chipTiltDeg: +(((decor?.tilt ?? 0) * 180) / Math.PI).toFixed(1),
          chipLabel:
            (decor?.chipPanel?.getElementById('cat-chip-label') as unknown as {
              properties?: { peek?: () => { text?: string } };
            })?.properties?.peek?.()?.text ?? null,
          accentVisible: decor?.strip?.visible ?? false,
          pulsing: (this.pulses.get(cardId)?.until ?? 0) > now,
          glowOpacity: decor?.glow?.visible ? +(decor.glow.material as MeshBasicMaterial).opacity.toFixed(3) : 0,
        };
      }),
      counts: categoryCounts(),
      picker: {
        open: this.pickerCardId !== null && this.picker?.panel.visible === true,
        cardId: this.pickerCardId,
      },
      toast: {
        visible: this.toast?.panel.visible ?? false,
        text: this.toastText,
      },
      stand: {
        baseline: this.baseline,
        standing: this.standing,
        log: [...this.standLog],
      },
    };
  }
}
