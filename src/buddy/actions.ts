/**
 * The AI buddy's fixed action set (PR 6), shared by the AI path (/api/buddy)
 * and the offline phrase parser.
 *
 * Nothing the buddy says is ever executed as text: a reply is a list of these
 * actions, every one is validated here (known type, known card id, sane
 * values) before the executor touches the room. This module is pure (no
 * IWSDK imports), so the harness unit-tests it directly.
 */

import { cleanBody, cleanDocTitle, isKnownDocId } from '../documents.js';

export const BUDDY_CATEGORIES = ['today', 'later', 'before-leave', 'unsorted'] as const;
export type BuddyCategory = (typeof BUDDY_CATEGORIES)[number];

export const FOCUS_CONTROLS = ['pause', 'resume', 'extend', 'end'] as const;
export type FocusControl = (typeof FOCUS_CONTROLS)[number];

/**
 * Where a spatial action puts cards (PR 7). Resolved on the device against the
 * detected WebXR planes: walls by direction from the seat, the desk/table, the
 * door, the seated focus spot ("here"), or beside another card.
 */
export const PLACE_TARGETS = ['desk', 'wall_front', 'wall_left', 'wall_right', 'door', 'here', 'next_to'] as const;
export type PlaceTarget = (typeof PLACE_TARGETS)[number];
export const MAX_ARRANGE = 8;

export type BuddyAction =
  /** `xp` is internal (a brain-dump item added anyway keeps its XP); the validator never emits it. */
  | { type: 'add_card'; title: string; category?: BuddyCategory; xp?: number }
  | { type: 'rename_card'; card_id: string; title: string }
  | { type: 'set_category'; card_id: string; category: BuddyCategory }
  | { type: 'list_cards'; category: BuddyCategory | 'all' }
  | { type: 'start_focus'; card_id: string; minutes: number }
  | { type: 'focus_control'; command: FocusControl; minutes?: number }
  | { type: 'complete_card'; card_id: string }
  | { type: 'delete_card'; card_id: string }
  | { type: 'plan_day'; order: string[] }
  | { type: 'place_card'; card_id: string; target: PlaceTarget; ref_card_id?: string }
  | { type: 'arrange'; target: PlaceTarget; category?: BuddyCategory; card_ids?: string[] }
  | { type: 'focus_on'; card_id: string; minutes: number }
  | { type: 'find'; card_id: string }
  /** PR 9: "what's my streak?" - the app answers from the saved streak. */
  | { type: 'show_streak' }
  /**
   * PR 10: open a document in the reading view. Exactly one source: a known
   * document id (bundled sample or one the buddy wrote), a card (its notes),
   * or a title + body the buddy wrote just now (saved, then opened).
   */
  | { type: 'open_document'; doc_id: string }
  | { type: 'open_document'; card_id: string }
  | { type: 'open_document'; title: string; body: string };

export type BuddyActionType = BuddyAction['type'];
export const ACTION_TYPES: readonly BuddyActionType[] = [
  'add_card',
  'rename_card',
  'set_category',
  'list_cards',
  'start_focus',
  'focus_control',
  'complete_card',
  'delete_card',
  'plan_day',
  'place_card',
  'arrange',
  'focus_on',
  'find',
  'show_streak',
  'open_document',
];

/** What the buddy (AI or parser) is told about each card: compact, no poses. */
export type BuddyCardState = 'floating' | 'pinned' | 'focusing' | 'paused';
export type BuddyCard = {
  id: string;
  title: string;
  category: string;
  state: BuddyCardState;
};

export const MAX_ACTIONS = 8;
export const MAX_TITLE = 60;
export const MAX_REPLY = 140;

export type Rejection = { action: unknown; reason: string };
export type Validated = { actions: BuddyAction[]; rejected: Rejection[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Trim, collapse spaces, drop control characters; null when empty or too long. */
export function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (text.length === 0 || Array.from(text).length > MAX_TITLE) return null;
  return text;
}

function placeTarget(value: unknown): PlaceTarget | null {
  return typeof value === 'string' && (PLACE_TARGETS as readonly string[]).includes(value) ? (value as PlaceTarget) : null;
}

function category(value: unknown): BuddyCategory | null {
  return typeof value === 'string' && (BUDDY_CATEGORIES as readonly string[]).includes(value)
    ? (value as BuddyCategory)
    : null;
}

/**
 * Validate one raw action against the schema and the live card ids.
 * Returns the clean action, or a reason it was refused.
 */
export function validateAction(raw: unknown, cardIds: ReadonlySet<string>): BuddyAction | string {
  if (!isRecord(raw)) return 'not-an-object';
  const type = raw.type;
  if (typeof type !== 'string' || !(ACTION_TYPES as readonly string[]).includes(type)) return 'unknown-type';
  const card = (): string | null =>
    typeof raw.card_id === 'string' && cardIds.has(raw.card_id) ? raw.card_id : null;
  switch (type as BuddyActionType) {
    case 'add_card': {
      const title = cleanTitle(raw.title);
      if (title === null) return 'bad-title';
      const cat = raw.category === undefined || raw.category === null ? null : category(raw.category);
      if (raw.category !== undefined && raw.category !== null && cat === null) return 'bad-category';
      return cat !== null ? { type: 'add_card', title, category: cat } : { type: 'add_card', title };
    }
    case 'rename_card': {
      const id = card();
      if (id === null) return 'unknown-card';
      const title = cleanTitle(raw.title);
      if (title === null) return 'bad-title';
      return { type: 'rename_card', card_id: id, title };
    }
    case 'set_category': {
      const id = card();
      if (id === null) return 'unknown-card';
      const cat = category(raw.category);
      if (cat === null) return 'bad-category';
      return { type: 'set_category', card_id: id, category: cat };
    }
    case 'list_cards': {
      const value = raw.category ?? 'all';
      if (value === 'all') return { type: 'list_cards', category: 'all' };
      const cat = category(value);
      if (cat === null) return 'bad-category';
      return { type: 'list_cards', category: cat };
    }
    case 'start_focus': {
      const id = card();
      if (id === null) return 'unknown-card';
      const minutes = raw.minutes ?? 25;
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 180) return 'bad-minutes';
      return { type: 'start_focus', card_id: id, minutes };
    }
    case 'focus_control': {
      const command = raw.command;
      if (typeof command !== 'string' || !(FOCUS_CONTROLS as readonly string[]).includes(command)) return 'bad-command';
      if (command === 'extend') {
        const minutes = raw.minutes ?? 5;
        if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) return 'bad-minutes';
        return { type: 'focus_control', command: 'extend', minutes };
      }
      return { type: 'focus_control', command: command as FocusControl };
    }
    case 'complete_card': {
      const id = card();
      return id === null ? 'unknown-card' : { type: 'complete_card', card_id: id };
    }
    case 'delete_card': {
      const id = card();
      return id === null ? 'unknown-card' : { type: 'delete_card', card_id: id };
    }
    case 'plan_day': {
      if (!Array.isArray(raw.order) || raw.order.length === 0 || raw.order.length > 12) return 'bad-order';
      const seen = new Set<string>();
      for (const id of raw.order) {
        if (typeof id !== 'string' || !cardIds.has(id) || seen.has(id)) return 'unknown-card';
        seen.add(id);
      }
      return { type: 'plan_day', order: [...seen] };
    }
    case 'place_card': {
      const id = card();
      if (id === null) return 'unknown-card';
      const target = placeTarget(raw.target);
      if (target === null) return 'bad-target';
      if (target === 'next_to') {
        const ref = typeof raw.ref_card_id === 'string' && cardIds.has(raw.ref_card_id) ? raw.ref_card_id : null;
        if (ref === null || ref === id) return 'unknown-card';
        return { type: 'place_card', card_id: id, target, ref_card_id: ref };
      }
      return { type: 'place_card', card_id: id, target };
    }
    case 'arrange': {
      const target = placeTarget(raw.target);
      if (target === null || target === 'next_to') return 'bad-target';
      const hasIds = Array.isArray(raw.card_ids) && raw.card_ids.length > 0;
      if (hasIds) {
        const ids = raw.card_ids as unknown[];
        if (ids.length > MAX_ARRANGE) return 'bad-order';
        const seen = new Set<string>();
        for (const cid of ids) {
          if (typeof cid !== 'string' || !cardIds.has(cid) || seen.has(cid)) return 'unknown-card';
          seen.add(cid);
        }
        return { type: 'arrange', target, card_ids: [...seen] };
      }
      const value = raw.category ?? 'all';
      if (value === 'all') return { type: 'arrange', target };
      const cat = category(value);
      if (cat === null) return 'bad-category';
      return { type: 'arrange', target, category: cat };
    }
    case 'focus_on': {
      const id = card();
      if (id === null) return 'unknown-card';
      const minutes = raw.minutes ?? 25;
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 180) return 'bad-minutes';
      return { type: 'focus_on', card_id: id, minutes };
    }
    case 'find': {
      const id = card();
      return id === null ? 'unknown-card' : { type: 'find', card_id: id };
    }
    case 'show_streak':
      return { type: 'show_streak' };
    case 'open_document': {
      const hasBody = raw.body !== undefined && raw.body !== null;
      const hasDoc = raw.doc_id !== undefined && raw.doc_id !== null;
      const hasCard = raw.card_id !== undefined && raw.card_id !== null;
      if (Number(hasBody) + Number(hasDoc) + Number(hasCard) !== 1) return 'bad-document';
      if (hasDoc) return isKnownDocId(raw.doc_id) ? { type: 'open_document', doc_id: raw.doc_id } : 'unknown-document';
      if (hasCard) {
        const id = card();
        return id === null ? 'unknown-card' : { type: 'open_document', card_id: id };
      }
      const body = cleanBody(raw.body);
      const title = cleanDocTitle(raw.title);
      if (body === null) return 'bad-body';
      if (title === null) return 'bad-title';
      return { type: 'open_document', title, body };
    }
    default:
      return 'unknown-type';
  }
}

/** Validate a whole reply: keeps the good actions (at most MAX_ACTIONS), lists the refused ones. */
export function validateActions(raw: unknown, cardIds: ReadonlySet<string>): Validated {
  const out: Validated = { actions: [], rejected: [] };
  if (!Array.isArray(raw)) {
    out.rejected.push({ action: raw, reason: 'not-a-list' });
    return out;
  }
  for (const item of raw.slice(0, MAX_ACTIONS)) {
    const result = validateAction(item, cardIds);
    if (typeof result === 'string') out.rejected.push({ action: item, reason: result });
    else out.actions.push(result);
  }
  for (const item of raw.slice(MAX_ACTIONS)) out.rejected.push({ action: item, reason: 'too-many' });
  return out;
}

/** A reply line from the AI: plain text, short; null when unusable. */
export function cleanReply(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // The UI font has no em/en dash glyphs (Luna likes them): use a plain hyphen.
  const text = value.replace(/\s*[\u2014\u2013]\s*/gu, ' - ').replace(/\s+/gu, ' ').trim();
  if (text.length === 0) return null;
  const chars = Array.from(text);
  return chars.length <= MAX_REPLY ? text : `${chars.slice(0, MAX_REPLY - 3).join('')}...`;
}

/** Actions that change cards for good and need an explicit Confirm chip first. */
export function needsConfirm(action: BuddyAction): boolean {
  return action.type === 'delete_card';
}
