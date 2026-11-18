/**
 * The buddy's short-term memory: a sliding window of recent turns plus a
 * cheap, deterministic summary of older ones (no extra model calls).
 *
 * Every buddy path shares it: typed and push-to-talk commands (/api/buddy)
 * and talk mode (GPT-Live delegations run through the same handler, and a new
 * talk session is seeded with memoryText()). It lives in memory and in
 * localStorage, expires after 12 hours, and is cleared by "forget our
 * conversation" or when the board is emptied.
 */
import type { BuddyAction, BuddyCard } from './actions.js';

export type MemoryTurn = {
  at: number;
  via: 'voice' | 'tap';
  /** What the user said. */
  user: string;
  /** What the buddy answered. */
  buddy: string;
  /** Compact, human-readable actions with card titles, e.g. `place_card "Gym" [c3] -> wall_left`. */
  did: string[];
  /** The validated actions, kept so the offline parser can replay "again". */
  actions: BuddyAction[];
  /** Cards this turn created or acted on (ids + titles after the turn): what "it" / "that one" / "them" mean next. */
  focus?: FocusCard[];
};

export type FocusCard = { id: string; title: string };

export type MemoryPayload = {
  summary: string;
  recent: Array<{ user: string; buddy: string; did: string }>;
  /** The cards the latest acting turn created or touched, newest turn only. */
  focus: FocusCard[];
};

const KEY = 'questty.buddy.memory.v1';
const EXPIRE_MS = 12 * 60 * 60_000;
const MAX_TURNS = 30;
export const RECENT_TURNS = 8;
const MAX_SUMMARY = 1200;
const MAX_TOTAL = 4000;

let turns: MemoryTurn[] | null = null;

const clip = (s: string, n: number): string => {
  const flat = s.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

function load(): MemoryTurn[] {
  if (turns !== null) return turns;
  turns = [];
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) {
      turns = parsed.filter(
        (t): t is MemoryTurn =>
          typeof t === 'object' && t !== null && typeof (t as MemoryTurn).at === 'number' && typeof (t as MemoryTurn).user === 'string',
      );
    }
  } catch {
    turns = [];
  }
  return prune(turns);
}

function prune(list: MemoryTurn[], now = Date.now()): MemoryTurn[] {
  const fresh = list.filter((t) => now - t.at < EXPIRE_MS).slice(-MAX_TURNS);
  if (fresh.length !== list.length) {
    turns = fresh;
    save();
  }
  return turns ?? fresh;
}

function save(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (turns === null || turns.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(turns));
  } catch {
    // storage full or blocked: memory still works for this session
  }
}

/** One action as a short line with card titles (ids kept in brackets so the model can reuse them). */
export function describeAction(a: BuddyAction, titleOf: (id: string) => string | undefined): string {
  const card = (id: string | undefined): string => {
    if (id === undefined) return '';
    const t = titleOf(id);
    return t !== undefined ? `"${clip(t, 40)}" [${id}]` : `[${id}]`;
  };
  switch (a.type) {
    case 'add_card':
      return `add_card "${clip(a.title, 40)}"${a.category ? ` (${a.category})` : ''}`;
    case 'rename_card':
      return `rename_card ${card(a.card_id)} -> "${clip(a.title, 40)}"`;
    case 'set_category':
      return `set_category ${card(a.card_id)} -> ${a.category}`;
    case 'list_cards':
      return `list_cards ${a.category}`;
    case 'start_focus':
    case 'focus_on':
      return `${a.type} ${card(a.card_id)} ${a.minutes} min`;
    case 'focus_control':
      return `focus_control ${a.command}${a.minutes ? ` ${a.minutes} min` : ''}`;
    case 'complete_card':
    case 'delete_card':
    case 'find':
      return `${a.type} ${card(a.card_id)}`;
    case 'plan_day':
      return `plan_day ${a.order.slice(0, 6).map((id) => card(id)).join(', ')}`;
    case 'place_card':
      return `place_card ${card(a.card_id)} -> ${a.target}${a.ref_card_id ? ` ${card(a.ref_card_id)}` : ''}`;
    case 'arrange':
      return `arrange -> ${a.target}${a.category ? ` (${a.category})` : ''}${a.card_ids ? ` ${a.card_ids.slice(0, 6).map((id) => card(id)).join(', ')}` : ''}`;
    case 'show_streak':
      return 'show_streak';
    case 'open_document':
      if ('doc_id' in a) return `open_document doc [${a.doc_id}]`;
      if ('card_id' in a) return `open_document notes of ${card(a.card_id)}`;
      if ('source_url' in a) return `open_document web ${a.kind} "${clip(a.title, 40)}"${a.subtitle ? ` ${clip(a.subtitle, 40)}` : ''} from ${clip(a.source_url, 80)}`;
      return `open_document wrote "${clip(a.title, 40)}"`;
    default:
      return (a as { type: string }).type;
  }
}

/** Store one finished turn (called after every buddy command, typed or spoken). */
export function rememberTurn(
  turn: { text: string; reply: string; source: 'voice' | 'tap'; actions: readonly BuddyAction[]; touched?: readonly string[] },
  cards: readonly BuddyCard[],
  after: readonly BuddyCard[] = cards,
): void {
  const user = clip(turn.text, 300);
  if (user.length === 0) return;
  const titles = new Map(cards.map((c) => [c.id, c.title]));
  const afterTitles = new Map(after.map((c) => [c.id, c.title]));
  // Cards this turn created: in creation order, so each add_card line gets its new id.
  const created = after.filter((c) => !titles.has(c.id)).map((c) => c.id);
  // A written document body can be long and a web chapter is ~10-60k chars:
  // keep only a short head for the record (the title, part and URL are kept whole).
  const actions = turn.actions.map((a) =>
    a.type === 'open_document' && 'body' in a ? { ...a, body: a.body.slice(0, 'source_url' in a ? 300 : 1500) } : a,
  ) as BuddyAction[];
  let made = 0;
  const did = actions.map((a) => {
    let line = describeAction(a, (id) => titles.get(id) ?? afterTitles.get(id));
    if (a.type === 'add_card' && made < created.length) line += ` -> [${created[made++]}]`;
    return clip(line, 160);
  }).slice(0, 8);
  const focusIds = [...new Set([...(turn.touched ?? []), ...created])].filter((id) => afterTitles.has(id)).slice(0, 8);
  const list = load();
  list.push({
    at: Date.now(),
    via: turn.source,
    user,
    buddy: clip(turn.reply, 200),
    did,
    actions,
    focus: focusIds.map((id) => ({ id, title: clip(afterTitles.get(id) ?? '', 60) })),
  });
  turns = list.slice(-MAX_TURNS);
  save();
}

/** A turn handled on the device without actions (undo, accepting an offer): still part of the conversation. */
export function rememberNote(text: string, reply: string, did: string, source: 'voice' | 'tap'): void {
  const user = clip(text, 300);
  if (user.length === 0) return;
  const list = load();
  list.push({ at: Date.now(), via: source, user, buddy: clip(reply, 200), did: [clip(did, 160)], actions: [] });
  turns = list.slice(-MAX_TURNS);
  save();
}

/** The cards the latest acting turn created or touched (empty when the last few turns touched none). */
export function lastFocus(): FocusCard[] {
  const list = load();
  for (let i = list.length - 1; i >= Math.max(0, list.length - 4); i -= 1) {
    const f = list[i].focus;
    if (f !== undefined && f.length > 0) return f;
  }
  return [];
}

/** The last turn's actions that actually did something ("do that again"). */
export function lastActions(): BuddyAction[] {
  const list = load();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].actions.length > 0) return list[i].actions;
  }
  return [];
}

export function forgetConversation(): void {
  turns = [];
  save();
}

export function memoryTurns(): MemoryTurn[] {
  return [...load()];
}

/** Last ~8 turns verbatim plus a one-line-per-turn summary of older ones, capped at ~4k chars. */
export function memoryPayload(now = Date.now()): MemoryPayload {
  const list = load().filter((t) => now - t.at < EXPIRE_MS);
  const recentTurns = list.slice(-RECENT_TURNS);
  const older = list.slice(0, Math.max(0, list.length - RECENT_TURNS));
  const lines = older.map((t) => clip(`asked "${t.user}"${t.did.length > 0 ? ` -> ${t.did.join('; ')}` : ` -> said "${t.buddy}"`}`, 180));
  let summary = '';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const next = `${lines[i]}\n${summary}`;
    if (next.length > MAX_SUMMARY) {
      summary = `(older turns omitted)\n${summary}`;
      break;
    }
    summary = next;
  }
  const recent = recentTurns.map((t) => ({ user: t.user, buddy: t.buddy, did: t.did.join('; ') }));
  const focus = lastFocus();
  // Hard cap on the whole payload: the newest turns win, so drop the summary, then the oldest recent turns.
  if (JSON.stringify({ summary, recent, focus }).length > MAX_TOTAL) summary = '';
  while (recent.length > 1 && JSON.stringify({ summary, recent, focus }).length > MAX_TOTAL) recent.shift();
  return { summary: summary.trim(), recent, focus };
}

/** Plain text of the same memory, for seeding a talk session. */
export function memoryText(now = Date.now()): string {
  const { summary, recent, focus } = memoryPayload(now);
  if (summary.length === 0 && recent.length === 0) return '';
  const parts: string[] = [];
  if (summary.length > 0) parts.push(`Earlier: \n${summary}`);
  for (const t of recent) parts.push(`User: ${t.user}\nBuddy: ${t.buddy}${t.did ? `\n(app did: ${t.did})` : ''}`);
  if (focus.length > 0) parts.push(`Last cards touched: ${focus.map((f) => `"${f.title}"`).join(', ')}`);
  // Keep the END: the newest turns matter most.
  return parts.join('\n').slice(-MAX_TOTAL);
}

/** Test hook: drop the in-memory cache so the next read comes from storage. */
export function _resetMemoryCache(): void {
  turns = null;
}
