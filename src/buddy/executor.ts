/**
 * Runs validated buddy actions on the real room (PR 6), for both the AI path
 * and the offline parser. Every change records an exact Undo; deletes wait
 * for an explicit Confirm chip; nothing here ever runs free text.
 */
import { Quaternion, Vector3, type Entity } from '@iwsdk/core';
import { QuestCard, QuestCardTween } from '../quest-component.js';
import {
  createQuestCard,
  emitCardEvent,
  findQuestCard,
  removeQuestCard,
  renameQuestCard,
  showFocusActionFor,
} from '../quest-card.js';
import { getCardCategory, setCardCategory } from '../categories.js';
import { getCategory } from '../category-config.js';
import { getBuddyFocusApi, type FocusSnapshot } from '../session-events.js';
import { setCardWorldPose } from '../surfaces.js';
import { suggestedFocusMinutes, DEFAULT_FOCUS_MIN } from '../session.js';
import { MAX_ARRANGE, needsConfirm, type BuddyAction, type BuddyCard, type BuddyCategory, type PlaceTarget } from './actions.js';
import { categoryLabel } from './parser.js';
import { getProgress } from '../progress.js';
import { dayKey, streakLine, viewStreak } from '../streak.js';
import { pingFlame } from '../flame.js';

export type UndoEntry = { label: string; run: () => Promise<string[]> };
export type Offer = { label: string; action: BuddyAction };

export type ExecResult = {
  /** Composed reply line (the AI's own line may replace it). */
  reply: string;
  /** Cards the buddy touched, in order: a light line goes to each. */
  touched: string[];
  /** Cards to pulse for a while (answers to "what's left?"). */
  highlight: string[];
  undo?: UndoEntry;
  /** Actions waiting for a Confirm chip (deletes). */
  confirm?: { label: string; actions: BuddyAction[]; reply: string };
  offer?: Offer;
  /** Did anything in the room change? */
  changed: boolean;
  /** Per action: ran / skipped (and why). */
  log: Array<{ type: string; ok: boolean; note?: string }>;
};

/** What the room did with a spatial request (PR 7). */
export type PlaceOutcome =
  | { ok: true; where: string; undo: () => void; /** How many cards really moved (arrange). */ count?: number }
  | { ok: false; reply: string; offer?: { label: string; target: PlaceTarget } };

export type ExecutorHost = {
  spawnCard(title: string, category?: string, xp?: number): Promise<Entity>;
  getPlan(): string[] | null;
  setPlan(order: string[] | null): void;
  cards(): BuddyCard[];
  /** A floating card the buddy starts focus on glides to the focus spot; returns how to send it back. */
  bringForward(entity: Entity): (() => void) | null;
  /** PR 7: glide a card to a place in the room (lands flush on surfaces, no overlaps). */
  place(entity: Entity, target: PlaceTarget, refId?: string): PlaceOutcome;
  /** PR 7: line several cards up on one place. */
  arrange(entities: Entity[], target: PlaceTarget): PlaceOutcome;
  /** PR 7: a short phrase for where a card is ("on the wall on your left"). */
  where(entity: Entity): string;
  /** PR 10: open a document in the reading view (doc-view.ts). */
  openDocument(request: DocRequest): Promise<DocOutcome>;
};

export type DocRequest =
  | { doc_id: string }
  | { card_id: string }
  | { title: string; body: string }
  | { title: string; body: string; source_url: string; kind: 'full_text' | 'summary'; subtitle?: string };
export type DocOutcome =
  | { ok: true; title: string; minutes: number; written: boolean; undo: () => void; web?: { pages: number; kind: 'full_text' | 'summary' } }
  | { ok: false; reply: string };

export type CardSnap = {
  id: string;
  title: string;
  xp: number;
  category: string;
  position: Vector3;
  quaternion: Quaternion;
  scale: number;
  zoneId: string;
  surfaceId: string;
};

export function snapCard(entity: Entity): CardSnap | null {
  const object = entity.object3D;
  if (object == null) return null;
  object.updateWorldMatrix(true, false);
  return {
    id: entity.getValue(QuestCard, 'cardId') as string,
    title: entity.getValue(QuestCard, 'title') as string,
    xp: entity.getValue(QuestCard, 'xp') as number,
    category: entity.getValue(QuestCard, 'category') as string,
    position: object.getWorldPosition(new Vector3()),
    quaternion: object.getWorldQuaternion(new Quaternion()),
    scale: object.scale.x,
    zoneId: entity.getValue(QuestCard, 'zoneId') as string,
    surfaceId: entity.getValue(QuestCard, 'surfaceId') as string,
  };
}

/** Put a deleted/completed card back exactly where it was (same id when free). */
export async function restoreCard(snap: CardSnap): Promise<Entity> {
  const old = findQuestCard(snap.id);
  if (old !== undefined) removeQuestCard(old); // still flying to the shelf
  const entity = await createQuestCard({
    id: snap.id,
    title: snap.title,
    xp: snap.xp,
    position: snap.position,
    quaternion: snap.quaternion,
    category: snap.category,
    restored: true,
  });
  setCardWorldPose(entity, snap.position, snap.quaternion, snap.scale);
  entity.setValue(QuestCard, 'zoneId', snap.zoneId);
  entity.setValue(QuestCard, 'surfaceId', snap.surfaceId);
  entity.setValue(QuestCard, 'userPlaced', true);
  emitCardEvent('updated', entity);
  if (snap.zoneId.length > 0) showFocusActionFor(entity);
  return entity;
}

const quote = (t: string): string => (t.length > 28 ? `${t.slice(0, 27)}...` : t);
const titleOf = (id: string): string => (findQuestCard(id)?.getValue(QuestCard, 'title') as string | undefined) ?? 'that card';
const live = (id: string): Entity | undefined => {
  const e = findQuestCard(id);
  return e !== undefined && !e.hasComponent(QuestCardTween) ? e : undefined;
};

export class BuddyExecutor {
  constructor(private readonly host: ExecutorHost) {}

  /**
   * Run validated actions. With `confirmed` false, deletes are held back and
   * returned as a pending confirmation instead.
   */
  async run(actions: BuddyAction[], { confirmed = false } = {}): Promise<ExecResult> {
    const result: ExecResult = { reply: '', touched: [], highlight: [], changed: false, log: [] };
    const undos: Array<() => Promise<string[]>> = [];
    const replies: string[] = [];
    const held = confirmed ? [] : actions.filter(needsConfirm);
    if (held.length > 0) {
      const names = held.map((a) => ('card_id' in a ? `"${quote(titleOf(a.card_id))}"` : '')).join(', ');
      result.confirm = {
        label: held.length === 1 ? 'Delete' : `Delete ${held.length}`,
        actions: held,
        reply: `Delete ${names}?`,
      };
      for (const a of held) {
        if ('card_id' in a) result.touched.push(a.card_id);
      }
    }
    const focus = getBuddyFocusApi();

    for (const action of actions) {
      if (!confirmed && needsConfirm(action)) continue;
      const log = (ok: boolean, note?: string) => result.log.push({ type: action.type, ok, note });
      switch (action.type) {
        case 'add_card': {
          const entity = await this.host.spawnCard(action.title, action.category, action.xp);
          const id = entity.getValue(QuestCard, 'cardId') as string;
          result.touched.push(id);
          result.changed = true;
          const when = action.category ? ` for ${categoryLabel(action.category)}` : '';
          replies.push(`Added "${quote(action.title)}"${when}.`);
          undos.push(async () => {
            const e = findQuestCard(id);
            if (e !== undefined) removeQuestCard(e);
            return [];
          });
          log(true);
          break;
        }
        case 'rename_card': {
          const entity = live(action.card_id);
          if (entity === undefined) {
            log(false, 'gone');
            break;
          }
          const before = entity.getValue(QuestCard, 'title') as string;
          renameQuestCard(entity, action.title);
          result.touched.push(action.card_id);
          result.changed = true;
          replies.push(`Renamed to "${quote(action.title)}".`);
          undos.push(async () => {
            const e = live(action.card_id);
            if (e !== undefined) renameQuestCard(e, before);
            return [action.card_id];
          });
          log(true);
          break;
        }
        case 'set_category': {
          const before = getCardCategory(action.card_id);
          if (before === null || !setCardCategory(action.card_id, action.category, 'api')) {
            log(false, 'gone');
            break;
          }
          result.touched.push(action.card_id);
          result.changed = true;
          replies.push(`Moved "${quote(titleOf(action.card_id))}" to ${getCategory(action.category)?.label ?? action.category}.`);
          undos.push(async () => {
            setCardCategory(action.card_id, before, 'api');
            return [action.card_id];
          });
          log(true);
          break;
        }
        case 'show_streak': {
          replies.push(streakLine(viewStreak(getProgress(), dayKey(Date.now()))));
          pingFlame();
          log(true);
          break;
        }
        case 'open_document': {
          const { type: _t, ...request } = action;
          const out = await this.host.openDocument(request as DocRequest);
          if (!out.ok) {
            replies.push(out.reply);
            log(false, 'no-document');
            break;
          }
          if ('card_id' in action) result.touched.push(action.card_id);
          result.changed = true;
          replies.push(
            out.web !== undefined
              ? `${out.web.kind === 'summary' ? 'Here is a summary of' : 'Opened'} "${quote(out.title)}"${out.web.pages > 1 ? ` (page 1 of ${out.web.pages}; say "next page" to go on)` : ''}. Pinch and drag to scroll.`
              : out.written
              ? `Wrote "${quote(out.title)}" and opened it. Pinch and drag to scroll.`
              : `Opened "${quote(out.title)}" (${out.minutes} min read). Pinch and drag to scroll.`,
          );
          undos.push(async () => {
            out.undo();
            return [];
          });
          log(true);
          break;
        }
        case 'list_cards': {
          const cards = this.host.cards().filter((c) => action.category === 'all' || c.category === action.category);
          const label = categoryLabel(action.category as BuddyCategory | 'all');
          if (cards.length === 0) {
            replies.push(action.category === 'today' ? 'Nothing left today. Nice.' : `Nothing ${label}.`);
          } else {
            const names = cards.slice(0, 3).map((c) => quote(c.title)).join(', ');
            const more = cards.length > 3 ? ` +${cards.length - 3} more` : '';
            replies.push(`${cards.length} ${action.category === 'today' ? 'left today' : label}: ${names}${more}.`);
          }
          result.highlight.push(...cards.map((c) => c.id));
          result.touched.push(...cards.map((c) => c.id));
          log(true);
          break;
        }
        case 'start_focus': {
          const entity = live(action.card_id);
          if (entity === undefined || focus === undefined) {
            log(false, 'gone');
            break;
          }
          const before = focus.snapshot();
          if (before !== null) {
            replies.push(`You're already focusing on "${quote(titleOf(before.cardId))}". Say "end it" first.`);
            log(false, 'busy');
            break;
          }
          if (!focus.start(entity, action.minutes)) {
            replies.push("I couldn't start a focus right now.");
            log(false, 'refused');
            break;
          }
          const sendBack = this.host.bringForward(entity);
          result.touched.push(action.card_id);
          result.changed = true;
          replies.push(`${action.minutes} minutes on "${quote(titleOf(action.card_id))}". Go.`);
          undos.push(async () => {
            focus.restore(null);
            sendBack?.();
            return [action.card_id];
          });
          log(true);
          break;
        }
        case 'focus_control': {
          const before: FocusSnapshot | null = focus?.snapshot() ?? null;
          if (focus === undefined || before === null) {
            replies.push('No focus is running.');
            log(false, 'idle');
            break;
          }
          if (!focus.control(action.command, action.minutes)) {
            replies.push(action.command === 'pause' ? 'Already paused.' : action.command === 'resume' ? "It's already running." : 'Nothing to change.');
            log(false, 'noop');
            break;
          }
          result.touched.push(before.cardId);
          result.changed = true;
          replies.push(
            action.command === 'pause'
              ? 'Paused.'
              : action.command === 'resume'
                ? 'Back to it.'
                : action.command === 'extend'
                  ? `Added ${action.minutes ?? 5} minutes.`
                  : 'Focus ended.',
          );
          undos.push(async () => {
            focus.restore(before);
            return [before.cardId];
          });
          log(true);
          break;
        }
        case 'complete_card': {
          const entity = live(action.card_id);
          if (entity === undefined || focus === undefined) {
            log(false, 'gone');
            break;
          }
          const snap = snapCard(entity);
          const focusBefore = focus.snapshot();
          const wasFocus = focusBefore?.cardId === action.card_id ? focusBefore : null;
          const xp = focus.complete(entity);
          if (snap === null) break;
          result.touched.push(action.card_id);
          result.changed = true;
          replies.push(`Done: "${quote(snap.title)}". +${xp} XP.`);
          undos.push(async () => {
            focus.revokeXp(xp);
            const back = await restoreCard(snap);
            const id = back.getValue(QuestCard, 'cardId') as string;
            if (wasFocus !== null) focus.restore({ ...wasFocus, cardId: id });
            return [id];
          });
          log(true);
          break;
        }
        case 'delete_card': {
          const entity = live(action.card_id);
          if (entity === undefined) {
            log(false, 'gone');
            break;
          }
          const snap = snapCard(entity);
          if (focus?.snapshot()?.cardId === action.card_id) focus.restore(null);
          removeQuestCard(entity);
          if (snap === null) break;
          result.changed = true;
          replies.push(`Deleted "${quote(snap.title)}".`);
          undos.push(async () => {
            const back = await restoreCard(snap);
            return [back.getValue(QuestCard, 'cardId') as string];
          });
          log(true);
          break;
        }
        case 'place_card': {
          const entity = live(action.card_id);
          if (entity === undefined) {
            log(false, 'gone');
            break;
          }
          const out = this.host.place(entity, action.target, action.ref_card_id);
          if (!out.ok) {
            replies.push(out.reply);
            if (out.offer !== undefined) {
              result.offer = { label: out.offer.label, action: { type: 'place_card', card_id: action.card_id, target: out.offer.target } };
            }
            result.touched.push(action.card_id);
            log(false, 'no-surface');
            break;
          }
          result.touched.push(action.card_id);
          result.changed = true;
          replies.push(`Moved "${quote(titleOf(action.card_id))}" to ${out.where}.`);
          undos.push(async () => {
            out.undo();
            return [action.card_id];
          });
          log(true);
          break;
        }
        case 'arrange': {
          const pool = action.card_ids ?? this.host.cards().filter((c) => action.category === undefined || c.category === action.category).map((c) => c.id);
          const entities = pool.map((id) => live(id)).filter((e): e is Entity => e !== undefined).slice(0, MAX_ARRANGE);
          if (entities.length === 0) {
            replies.push(action.category !== undefined ? `No cards ${categoryLabel(action.category)} to line up.` : 'No cards to line up.');
            log(false, 'empty');
            break;
          }
          const out = this.host.arrange(entities, action.target);
          const ids = entities.map((e) => e.getValue(QuestCard, 'cardId') as string);
          result.touched.push(...ids);
          if (!out.ok) {
            replies.push(out.reply);
            log(false, 'no-surface');
            break;
          }
          result.changed = true;
          const moved = out.count ?? entities.length;
          replies.push(`Lined up ${moved} ${moved === 1 ? 'card' : 'cards'} on ${out.where.replace(/^(right )?in front of you$/u, 'your focus spot')}.`);
          undos.push(async () => {
            out.undo();
            return ids;
          });
          log(true);
          break;
        }
        case 'focus_on': {
          const entity = live(action.card_id);
          if (entity === undefined || focus === undefined) {
            log(false, 'gone');
            break;
          }
          const before = focus.snapshot();
          if (before !== null && before.cardId !== action.card_id) {
            replies.push(`You're already focusing on "${quote(titleOf(before.cardId))}". Say "end it" first.`);
            log(false, 'busy');
            break;
          }
          // Bring it to the seated focus spot first (unpins it if needed), then start.
          const moved = this.host.place(entity, 'here');
          if (before !== null) {
            result.touched.push(action.card_id);
            if (moved.ok) {
              result.changed = true;
              undos.push(async () => {
                moved.undo();
                return [action.card_id];
              });
            }
            replies.push(`Already on "${quote(titleOf(action.card_id))}". It's right in front of you.`);
            log(true, 'already');
            break;
          }
          if (!focus.start(entity, action.minutes)) {
            if (moved.ok) moved.undo();
            replies.push("I couldn't start a focus right now.");
            log(false, 'refused');
            break;
          }
          result.touched.push(action.card_id);
          result.changed = true;
          replies.push(`${action.minutes} minutes on "${quote(titleOf(action.card_id))}", right in front of you.`);
          undos.push(async () => {
            focus.restore(null);
            if (moved.ok) moved.undo();
            return [action.card_id];
          });
          log(true);
          break;
        }
        case 'find': {
          const entity = findQuestCard(action.card_id);
          if (entity === undefined) {
            log(false, 'gone');
            break;
          }
          result.touched.push(action.card_id);
          result.highlight.push(action.card_id);
          replies.push(`"${quote(titleOf(action.card_id))}" is ${this.host.where(entity)}.`);
          log(true);
          break;
        }
        case 'plan_day': {
          const order = action.order.filter((id) => live(id) !== undefined);
          if (order.length === 0) {
            log(false, 'empty');
            break;
          }
          const before = this.host.getPlan();
          this.host.setPlan(order);
          result.touched.push(...order);
          result.changed = true;
          replies.push(`Here's your day: ${order.length} in order, starting with "${quote(titleOf(order[0]))}".`);
          undos.push(async () => {
            this.host.setPlan(before);
            return before ?? [];
          });
          const first = live(order[0]);
          if (first !== undefined && focus?.snapshot() === null) {
            const minutes = suggestedFocusMinutes(titleOf(order[0])) ?? DEFAULT_FOCUS_MIN;
            result.offer = { label: 'Start the first one?', action: { type: 'start_focus', card_id: order[0], minutes } };
          }
          log(true);
          break;
        }
      }
    }

    if (result.confirm !== undefined) replies.unshift(result.confirm.reply);
    result.reply = replies.join(' ') || "Sorry, I couldn't do that.";
    if (undos.length > 0) {
      result.undo = {
        label: 'Undo',
        run: async () => {
          const touched: string[] = [];
          for (const undo of undos.reverse()) touched.push(...(await undo()));
          return touched;
        },
      };
    }
    return result;
  }
}
