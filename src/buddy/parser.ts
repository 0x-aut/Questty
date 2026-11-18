/**
 * Offline buddy (PR 6): a local phrase parser for every buddy command, used
 * when /api/buddy is not configured, offline or returns something unusable.
 * It also routes the one mic: list-like brain dumps make cards (the existing
 * /api/quests path), commands go to the buddy.
 *
 * Pure (no IWSDK imports): the harness unit-tests it with esbuild.
 */
import { inferCategory, stripTiming } from '../category-config.js';
import type { BuddyCard, BuddyCategory, PlaceTarget } from './actions.js';
import { draftOutline, matchDoc, soundsLikeDoc } from '../documents.js';

export type ParseResult =
  | { kind: 'command'; actions: Array<Record<string, unknown>>; reply?: string }
  | { kind: 'undo' }
  | { kind: 'accept' }
  | { kind: 'miss'; reply: string }
  | { kind: 'dump' }
  /** "do that again": replay the last actions from memory (offline fallback). */
  | { kind: 'again' }
  /** "forget our conversation": clear the buddy's memory (local, no API). */
  | { kind: 'forget' };

// ------------------------------------------------------------------ helpers

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fortyfive: 45, fifty: 50, sixty: 60,
  half: 30,
};

/** "25", "twenty five", "fifteen", "an hour" -> minutes; null when none. */
export function parseMinutes(text: string): number | null {
  const t = text.toLowerCase();
  if (/\b(an|one) hour\b/u.test(t)) return 60;
  if (/\bhalf (an )?hour\b/u.test(t)) return 30;
  const digits = /\b(\d{1,3})\b/u.exec(t);
  if (digits !== null) return Number(digits[1]);
  const words = /\b(twenty|thirty|forty|fifty)[\s-]+(one|two|three|four|five|six|seven|eight|nine)\b/u.exec(t);
  if (words !== null) return NUMBER_WORDS[words[1]] + NUMBER_WORDS[words[2]];
  const single = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty)\b/u.exec(t);
  return single !== null ? NUMBER_WORDS[single[1]] : null;
}

const STOP = new Set([
  'the', 'a', 'an', 'my', 'card', 'quest', 'task', 'one', 'thing', 'item', 'to', 'for', 'on', 'of', 'that', 'this',
  'please', 'about', 'with', 'it',
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]s\b/gu, '')
    .replace(/[^a-z0-9\s]/gu, ' ')
    .split(/\s+/u)
    .filter((w) => w.length > 0 && !STOP.has(w));
}

function wordMatch(a: string, b: string): number {
  if (a === b) return 1;
  // Simple stemming: "calls"/"call", "dentist"/"dentists", "laundry"/"laundr".
  const min = Math.min(a.length, b.length);
  if (min >= 4 && (a.startsWith(b) || b.startsWith(a))) return 0.85;
  if (min >= 5 && a.slice(0, 5) === b.slice(0, 5)) return 0.7;
  return 0;
}

/**
 * Fuzzy match a spoken card reference ("the dentist one", "gym") to a card by
 * title. Returns the best card when it is a clear enough match.
 */
export function matchCard(ref: string, cards: readonly BuddyCard[]): { card: BuddyCard; score: number } | null {
  const want = tokens(ref);
  if (want.length === 0) return null;
  let best: { card: BuddyCard; score: number } | null = null;
  for (const card of cards) {
    const have = tokens(card.title);
    if (have.length === 0) continue;
    let hit = 0;
    for (const w of want) hit += Math.max(0, ...have.map((h) => wordMatch(w, h)));
    // Mostly about how much of what was SAID matches, a little about coverage of the title.
    let score = (hit / want.length) * 0.8 + (hit / Math.max(have.length, want.length)) * 0.2;
    if (card.title.toLowerCase().includes(ref.toLowerCase().trim())) score += 0.1;
    if (best === null || score > best.score) best = { card, score };
  }
  return best !== null && best.score >= 0.45 ? best : null;
}

function cleanRef(text: string): string {
  return text
    .replace(/^(the|my|a)\s+/iu, '')
    .replace(/\s+(card|one|quest|task|thing)$/iu, '')
    .replace(/[.!?]+$/u, '')
    .trim();
}

function capitalize(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}

/** A spoken category name to an id ("later", "tomorrow", "before I leave", "today"). */
export function categoryFromWords(text: string): BuddyCategory | null {
  const t = text.toLowerCase();
  if (/\b(unsorted|no time|whenever|inbox)\b/u.test(t)) return 'unsorted';
  if (/\bbefore (i|we) (leave|go)\b|\bon (my|the) way out\b|\bleave\b/u.test(t)) return 'before-leave';
  const inferred = inferCategory(t);
  if (inferred === 'today' || inferred === 'later' || inferred === 'before-leave') return inferred;
  if (/\bnow\b/u.test(t)) return 'today';
  return null;
}

const CATEGORY_LABEL: Record<BuddyCategory | 'all', string> = {
  today: 'today',
  later: 'later',
  'before-leave': 'before you leave',
  unsorted: 'unsorted',
  all: 'in your room',
};
export const categoryLabel = (c: BuddyCategory | 'all'): string => CATEGORY_LABEL[c];

// ------------------------------------------------------------------ places (PR 7)

/**
 * A spoken place in the room to a spatial target: "the desk", "the wall on my
 * left", "the door", "here" / "in front of me", "next to the gym card".
 * Returns null when the words name no place (so "move gym to later" stays a
 * category move).
 */
export function placeFromWords(text: string): { target: PlaceTarget; ref?: string } | null {
  const t = ` ${text.toLowerCase().replace(/[.!?]+$/u, '').trim()} `;
  const next = /\b(?:next to|beside|by|alongside)\s+(.+?)\s*$/u.exec(t.trim());
  if (next !== null && !/^(the\s+)?(door|desk|table|wall|window)\b/u.test(next[1])) return { target: 'next_to', ref: next[1] };
  const wall = /\bwalls?\b/u.test(t);
  if (/\bleft\b/u.test(t) && (wall || /\b(on|to) (my|the) left\b|\bmy left\b|\bleft side\b/u.test(t))) return { target: 'wall_left' };
  if (/\bright\b/u.test(t) && (wall || /\b(on|to) (my|the) right\b|\bmy right\b|\bright side\b/u.test(t))) return { target: 'wall_right' };
  if (wall) return { target: 'wall_front' };
  if (/\b(desk|table|coffee table|counter)\b/u.test(t)) return { target: 'desk' };
  if (/\bdoor(way)?\b/u.test(t)) return { target: 'door' };
  if (/\b(here|over here|in front of me|front of me|to me|my focus spot|focus spot|where i can see it|close(r)? to me)\b/u.test(t)) return { target: 'here' };
  return null;
}

const PLACE_LABEL: Record<PlaceTarget, string> = {
  desk: 'your desk',
  wall_front: 'the wall in front of you',
  wall_left: 'the wall on your left',
  wall_right: 'the wall on your right',
  door: 'the door',
  here: 'right in front of you',
  next_to: 'next to it',
};
export const placeLabel = (t: PlaceTarget): string => PLACE_LABEL[t];

// ------------------------------------------------------------------ planning

const MORNING = /\b(morning|breakfast|first thing|am)\b/iu;
const EVENING = /\b(evening|tonight|night|dinner|after work)\b/iu;

/**
 * Offline plan for the day: Today cards ordered by any time in the title
 * ("at 3", "morning"), then quick wins before bigger ones, keeping the
 * user's own order otherwise. Falls back to Unsorted cards when Today is empty.
 */
export function planOrder(cards: readonly BuddyCard[]): string[] {
  let pool = cards.filter((c) => c.category === 'today');
  if (pool.length === 0) pool = cards.filter((c) => c.category === 'unsorted');
  const rank = (c: BuddyCard, index: number): number => {
    const t = c.title;
    const at = /\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/iu.exec(t);
    if (at !== null) {
      let h = Number(at[1]);
      if (at[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
      else if (at[3] === undefined && h >= 1 && h <= 7) h += 12; // "at 3" means the afternoon
      return h * 100 + Number(at[2] ?? 0);
    }
    if (MORNING.test(t)) return 800 + index;
    if (EVENING.test(t)) return 1900 + index;
    // Unscheduled: keep their order, slotted around late morning.
    return 1000 + index;
  };
  return pool
    .map((c, i) => ({ c, r: rank(c, i) }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.c.id);
}

// ------------------------------------------------------------------ routing

/** PR 10: "write an outline for my talk", "draft notes on the launch". */
const WRITE_DOC = /^(?:write|draft|make|create|give me)\s+(?:me\s+)?(?:an?\s+|some\s+)?(outline|draft|notes|plan|summary)\s+(?:for|on|about|of)\s+(.+)$/iu;

const COMMAND_START =
  /^(add|create|new|make|remind me|rename|retitle|change|call it|move|push|put|shift|send|bump|what|what's|whats|show|list|how many|start|begin|focus|do \d|pause|hold|resume|continue|unpause|keep going|extend|give me|end|stop|finish|mark|tick|check off|complete|done|i finished|i'm done|i am done|i did|delete|remove|trash|get rid|drop|plan|order|undo|yes|yeah|yep|sure|ok|okay|do it|find|where|where's|wheres|locate|place|stick|pin|bring|hang|take|line up|line them|arrange|lay out|tidy|point)\b/iu;

/**
 * One mic, two jobs: is this a buddy command, or a brain dump that should
 * become cards? Commands start with a command verb or ask a question; a dump
 * is everything else (lists, "I need to...", a single thing to remember).
 */
/** PR 11: "review my day", "evening review", "wrap up the day": the evening review, handled on the device. */
export const REVIEW_RE = /\b(evening review|review (my|the|to)?\s*day|(day|daily) review|wrap (up )?(my|the) day|end of (the )?day review|roll (the rest|everything|it all) (over )?to tomorrow)\b/iu;
export function wantsEveningReview(text: string): boolean {
  return REVIEW_RE.test(normalize(text));
}
/**
 * "close the review", "dismiss the evening review", "get rid of this review",
 * "I'm done reviewing": dismisses it for the day (no automatic offer until asked).
 */
export const CLOSE_REVIEW_RE = /\b((close|dismiss|hide|stop|cancel|end|skip|exit|remove|clear|get rid of|lose|kill)( the| my| this| that)?( evening| daily| day)? review|(i'?m|i am|we'?re|all) done (reviewing|with (the|this|my) review)|no more review(ing)?)\b/iu;
export function wantsCloseReview(text: string): boolean {
  return CLOSE_REVIEW_RE.test(normalize(text));
}
/** Short brush-offs that mean the review while it is on screen ("not now", "later", "go away"). */
export const REVIEW_BRUSH_OFF_RE = /^(ok(ay)? |no |nah |um |uh )*(not now|later|maybe later|not tonight|no thanks|go away|close (it|this|that)|get rid of (it|this|that)|done|i'?m done|that'?s enough|skip (it|this|that))( thanks| thank you| please)?$/iu;
export function brushesOffReview(text: string): boolean {
  return REVIEW_BRUSH_OFF_RE.test(normalize(text).replace(/[.,!?]/gu, '').replace(/\s+/gu, ' ').trim());
}

export function classify(text: string): 'command' | 'dump' {
  const t = normalize(text);
  if (t.length === 0) return 'dump';
  if (REVIEW_RE.test(t) && t.split(' ').length <= 9) return 'command';
  if (CLOSE_REVIEW_RE.test(t) && t.split(' ').length <= 9) return 'command';
  // "I need to X, Y and Z" or a long list is a dump even if a verb sneaks in.
  const commas = (t.match(/,/gu) ?? []).length;
  if (/^(okay |so |um |uh )*(today |later |tomorrow )?(i (need|have|got|want|should|must) to|i've got to|gotta)\b/iu.test(t)) return 'dump';
  if (COMMAND_START.test(t) && commas < 2) return 'command';
  if (/\b(streak|my flame|the flame)\b/iu.test(t) && t.split(' ').length <= 9) return 'command';
  // Follow-ups that lean on the conversation so far ("do the same for the gym one", "again", "forget our conversation").
  if (/^(again|repeat|same|forget (our|the|this|what|everything)|clear (our|the) (conversation|chat))\b|\b(do (that|it|this) again|the same (for|with|to)|same (for|with) the|that one too|as well)\b/iu.test(t) && commas < 2 && t.split(' ').length <= 12) return 'command';
  // PR 10: "open my essay", "read the project brief", "write an outline for my talk".
  const docVerb = /^(open|read|pull up|bring up|show me|show)\s+(.+)$/iu.exec(t);
  if (docVerb !== null && commas < 2 && (soundsLikeDoc(docVerb[2]) || /^(open|read)\b/iu.test(t) && /\b(card|notes?)$/iu.test(docVerb[2]))) return 'command';
  if (WRITE_DOC.test(t) && commas < 2) return 'command';
  if (/\b(plan my day|what's left|whats left|what is left|add \d+ min|add five min)\b/iu.test(t)) return 'command';
  return 'dump';
}

function normalize(text: string): string {
  return text
    .replace(/[“”]/gu, '"')
    .replace(/’/gu, "'")
    .replace(/^(?:(?:hey|hi|ok|okay|so|um+|uh+|questty|buddy)[,\s]+)+/iu, '')
    .replace(/^(can you|could you|please|would you)\s+/iu, '')
    .replace(/\s+please[.!?]*$/iu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

// ------------------------------------------------------------------ the parser

/**
 * Parse one spoken or tapped command into raw buddy actions (card references
 * already matched to ids). The executor validates them like any AI reply.
 */
export function parseCommand(input: string, cards: readonly BuddyCard[]): ParseResult {
  const text = normalize(input).replace(/[.!?]+$/u, '');
  const lower = text.toLowerCase();
  if (lower.length === 0) return { kind: 'miss', reply: "I didn't catch that." };

  const card = (ref: string): BuddyCard | null => matchCard(cleanRef(ref), cards)?.card ?? null;
  const notFound = (ref: string): ParseResult => ({
    kind: 'miss',
    reply: `I couldn't find a card like "${cleanRef(ref).slice(0, 30)}".`,
  });
  const focusing = cards.find((c) => c.state === 'focusing' || c.state === 'paused');

  if (/^undo\b|^take that back\b/u.test(lower)) return { kind: 'undo' };
  if (/^(forget (our|the|this) (conversation|chat)|forget (what|everything) (we|i) said|clear (our|the) (conversation|chat))$/u.test(lower)) return { kind: 'forget' };
  if (/^((please )?(do|say)? ?(that|it|this) again|again|repeat( that)?|same again|one more time)( please)?$/u.test(lower)) return { kind: 'again' };
  if (/^(yes|yeah|yep|sure|ok|okay|do it|go|start it|start the first one|let's go)$/u.test(lower)) return { kind: 'accept' };

  // ---- streak (PR 9): "what's my streak?", "how's my flame doing", "how many days in a row"
  if (/\bstreak\b|\b(my|the) flame\b|\bdays? in a row\b/u.test(lower)) {
    return { kind: 'command', actions: [{ type: 'show_streak' }] };
  }

  // ---- documents (PR 10): "open my essay", "read the project brief", "open the notes on gym", "write an outline for my talk"
  const write = WRITE_DOC.exec(lower);
  if (write !== null) {
    const topic = write[2].replace(/[.!?]+$/u, '').trim();
    const draft = draftOutline(topic);
    return { kind: 'command', actions: [{ type: 'open_document', title: draft.title, body: draft.body }] };
  }
  const openDoc = /^(open|read|pull up|bring up|show me|show)\s+(?:up\s+)?(.+)$/u.exec(lower);
  if (openDoc !== null) {
    const words = openDoc[2].replace(/\s+(?:for me|again|now)$/u, '');
    const showing = openDoc[1].startsWith('show');
    const doc = matchDoc(words);
    const notesOf =
      /^(?:the\s+|my\s+)?notes?\s+(?:on|for|about|from)\s+(?:the\s+|my\s+)?(.+?)(?:\s+card)?$/u.exec(words) ??
      /^(?:the\s+|my\s+)?(.+?)\s+(?:card\s+)?notes?$/u.exec(words) ??
      (showing ? null : /^(?:the\s+|my\s+)?(.+?)\s+card$/u.exec(words));
    if (notesOf !== null) {
      const target = card(notesOf[1]);
      if (target !== null) return { kind: 'command', actions: [{ type: 'open_document', card_id: target.id }] };
    }
    if (doc !== null) return { kind: 'command', actions: [{ type: 'open_document', doc_id: doc.id }] };
    if (notesOf !== null) return notFound(notesOf[1]);
    if (soundsLikeDoc(words)) return { kind: 'miss', reply: `I couldn't find a document like "${cleanRef(words).slice(0, 30)}".` };
  }

  // ---- plan my day
  if (/\b(plan|order|organi[sz]e) (my|the|out my)? ?day\b|^what should i do first\b|^plan\b/u.test(lower)) {
    const order = planOrder(cards);
    if (order.length === 0) return { kind: 'miss', reply: 'Nothing for today yet. Add a few things first.' };
    return { kind: 'command', actions: [{ type: 'plan_day', order }] };
  }

  // ---- find (PR 7): "where's the gym card?", "find the pitch deck", "show me where laundry is"
  const find =
    /^(?:find|locate|point (?:me )?(?:to|at)|show me where|where(?:'s| is| are| did i put| did you put)?|wheres|which one is)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:is|are|went|card))?$/u.exec(lower);
  if (find !== null && !/^(what|whats)\b/u.test(lower)) {
    const target = card(find[1]);
    if (target === null) return notFound(find[1]);
    return { kind: 'command', actions: [{ type: 'find', card_id: target.id }] };
  }

  // ---- arrange (PR 7): "line up my today cards on the desk", "arrange everything on the left wall"
  const arrange =
    /^(?:line up|line|arrange|lay out|lay|tidy(?: up)?|organi[sz]e|put|move|stick|pin)\s+(?:up\s+)?(?:all\s+(?:of\s+)?)?(?:the\s+|my\s+)?(.*?)\b(cards|quests|tasks|everything|them all|them)\b(?:\s+up)?\s+(?:on|onto|along|across|to|against|over|in|(?=here\b))\s*(.+)$/u.exec(lower);
  if (arrange !== null) {
    const place = placeFromWords(arrange[3]);
    if (place !== null && place.target !== 'next_to') {
      const cat = categoryFromWords(arrange[1]);
      const action: Record<string, unknown> = { type: 'arrange', target: place.target };
      if (cat !== null) action.category = cat;
      return { kind: 'command', actions: [action] };
    }
  }

  // ---- place (PR 7): "move the gym card to the left wall", "put laundry on the desk", "bring the deck here"
  const placeVerb = /^(?:move|put|place|stick|send|pin|bring|hang|take|drop|push)\s+(.+)$/u.exec(lower);
  if (placeVerb !== null) {
    const rest = placeVerb[1];
    const split =
      /^(.+?)\s+(?:on|onto|to|over to|up on|against|at|in|into)\s+(?:the\s+|my\s+)?((?:wall|desk|table|coffee table|door|left|right|focus|front).*)$/u.exec(rest) ??
      /^(.+?)\s+((?:over\s+)?here|in front of me|to me|closer|next to .+|beside .+|alongside .+)$/u.exec(rest);
    if (split !== null) {
      const place = placeFromWords(split[2]);
      if (place !== null) {
        const target = card(split[1]);
        if (target === null) return notFound(split[1]);
        if (place.target === 'next_to') {
          const ref = card(place.ref ?? '');
          if (ref === null) return notFound(place.ref ?? '');
          if (ref.id === target.id) return { kind: 'miss', reply: 'Next to which other card?' };
          return { kind: 'command', actions: [{ type: 'place_card', card_id: target.id, target: 'next_to', ref_card_id: ref.id }] };
        }
        return { kind: 'command', actions: [{ type: 'place_card', card_id: target.id, target: place.target }] };
      }
    }
  }

  // ---- questions: what's left today / later / before I leave
  const ask = /^(what's|whats|what is|what do i have|what have i got|show( me)?|list|how many)\b(.*)$/u.exec(lower);
  if (ask !== null) {
    const rest = ask[ask.length - 1] ?? '';
    const cat = categoryFromWords(rest);
    return { kind: 'command', actions: [{ type: 'list_cards', category: cat ?? (/\bleft\b/u.test(rest) ? 'today' : 'all') }] };
  }

  // ---- focus controls (no card needed)
  if (/^(pause|hold on|hold it|pause it|pause the timer|take a break)\b/u.test(lower)) {
    return { kind: 'command', actions: [{ type: 'focus_control', command: 'pause' }] };
  }
  if (/^(resume|continue|unpause|keep going|carry on)\b/u.test(lower)) {
    return { kind: 'command', actions: [{ type: 'focus_control', command: 'resume' }] };
  }
  const extend =
    /^(?:add|give me|extend(?: it| the timer| focus)?(?: by)?|another)\s+(\d{1,3}|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty)(?:\s+more)?\s*(?:min|mins|minute|minutes)\b/u.exec(lower);
  if (extend !== null) {
    const minutes = parseMinutes(extend[1]) ?? (/^an?$/u.test(extend[1]) ? 1 : 5);
    return { kind: 'command', actions: [{ type: 'focus_control', command: 'extend', minutes }] };
  }
  if (/^(end|stop|cancel|quit)( it| this| now| focus| focusing| the (timer|session|focus))?$/u.test(lower) || /^(end|stop) (the )?focus\b/u.test(lower)) {
    return { kind: 'command', actions: [{ type: 'focus_control', command: 'end' }] };
  }

  // ---- start focus: "start 25 on the pitch deck", "focus on taxes for 15 minutes", "start the pitch deck"
  const startA = /^(start|begin|do|focus)\s+(?:a\s+)?(.+?)\s*(?:min(?:ute)?s?|m)?(?:\s+(?:focus|timer|session))?\s+(?:on|for)\s+(.+)$/u.exec(lower);
  const startB = /^(?:start|begin)?\s*(?:focus(?:ing)?|working)\s+on\s+(.+?)(?:\s+for\s+(.+?)\s*(?:min(?:ute)?s?|m)?)?$/u.exec(lower);
  const startC = /^(?:start|begin)\s+(?:the\s+)?(.+?)(?:\s+for\s+(.+?)\s*(?:min(?:ute)?s?|m)?)?$/u.exec(lower);
  let startRef: string | null = null;
  let startMin: number | null = null;
  let startType: 'start_focus' | 'focus_on' = 'start_focus';
  if (startA !== null && parseMinutes(startA[2]) !== null) {
    startRef = startA[3];
    startMin = parseMinutes(startA[2]);
  } else if (startB !== null) {
    // "focus on X": bring the card to the seated focus spot and start (PR 7).
    startType = 'focus_on';
    startRef = startB[1];
    startMin = startB[2] !== undefined ? parseMinutes(startB[2]) : null;
  } else if (startC !== null && !/^(the )?(first|timer|focus)( one)?$/u.test(startC[1])) {
    startRef = startC[1];
    startMin = startC[2] !== undefined ? parseMinutes(startC[2]) : null;
  }
  if (startRef !== null) {
    const target = card(startRef);
    if (target === null) return notFound(startRef);
    return { kind: 'command', actions: [{ type: startType, card_id: target.id, minutes: startMin ?? 25 }] };
  }

  // ---- finish: "mark laundry done", "I finished the laundry", "laundry is done", "complete laundry"
  const done =
    /^(?:mark|tick|check)\s+(?:off\s+)?(.+?)(?:\s+(?:as\s+)?(?:done|complete|completed|finished))?$/u.exec(lower) ??
    /^(?:complete|finish|finished|i finished|i'm done with|i am done with|done with|i did)\s+(.+)$/u.exec(lower) ??
    /^(.+?)\s+(?:is|are)\s+(?:done|finished|complete)$/u.exec(lower);
  if (done !== null && !/^(end|stop)\b/u.test(lower)) {
    const ref = done[1];
    if (/^(it|this|that)$/u.test(ref.trim()) && focusing !== undefined) {
      return { kind: 'command', actions: [{ type: 'complete_card', card_id: focusing.id }] };
    }
    const target = card(ref);
    if (target === null) return notFound(ref);
    return { kind: 'command', actions: [{ type: 'complete_card', card_id: target.id }] };
  }

  // ---- delete (the executor asks for a Confirm chip first)
  const del = /^(?:delete|remove|trash|get rid of|drop|throw away)\s+(.+)$/u.exec(lower);
  if (del !== null) {
    const target = card(del[1]);
    if (target === null) return notFound(del[1]);
    return { kind: 'command', actions: [{ type: 'delete_card', card_id: target.id }] };
  }

  // ---- rename: "rename the dentist one to dentist at 3"
  const rename = /^(?:rename|retitle|change|call)\s+(.+?)\s+(?:to|as|into)\s+(.+)$/u.exec(text.replace(/^(\S+)/u, (m) => m.toLowerCase()));
  if (rename !== null && /^(rename|retitle|change|call)\b/iu.test(lower)) {
    const target = card(rename[1]);
    if (target === null) return notFound(rename[1]);
    const title = capitalize(rename[2].replace(/^["']|["']$/gu, '').trim());
    return { kind: 'command', actions: [{ type: 'rename_card', card_id: target.id, title }] };
  }

  // ---- move: "move the gym card to later", "push gym to tomorrow", "move gym later"
  const move =
    /^(?:move|push|put|shift|send|bump)\s+(.+?)\s+(?:to|for|into|until|till|onto)\s+(.+)$/u.exec(lower) ??
    /^(?:move|push|put|shift|send|bump)\s+(.+?)\s+(later|today|tomorrow|tonight)$/u.exec(lower);
  if (move !== null) {
    const cat = categoryFromWords(move[2]);
    if (cat === null) {
      // A place the room can't hold a card on ("the ceiling", "the floor", "the window").
      if (/\b(ceiling|floor|roof|window|couch|sofa|bed|chair|shelf|lamp)\b/u.test(move[2])) {
        return { kind: 'miss', reply: "Cards can't go there. Try a wall, the desk, the door, or here." };
      }
      return { kind: 'miss', reply: 'Move it to Today, Later or Before I leave?' };
    }
    const target = card(move[1]);
    if (target === null) return notFound(move[1]);
    return { kind: 'command', actions: [{ type: 'set_category', card_id: target.id, category: cat }] };
  }

  // ---- add: "add call mum for today", "remind me to water the plants before I leave"
  const add = /^(?:add|create|new|make|remind me to|remind me)\s+(?:a\s+)?(?:new\s+)?(?:card|quest|task|reminder)?\s*(?:to\s+|for\s+|called\s+)?(.+)$/iu.exec(text);
  if (add !== null) {
    const raw = add[1].trim();
    const cat = inferCategory(raw);
    let title = stripTiming(raw)
      .replace(/\s+(for|to|by|at|on)$/iu, '')
      .replace(/^(to|for)\s+/iu, '')
      .trim();
    if (title.length === 0) title = raw;
    const action: Record<string, unknown> = { type: 'add_card', title: capitalize(title) };
    if (cat === 'today' || cat === 'later' || cat === 'before-leave') action.category = cat;
    return { kind: 'command', actions: [action] };
  }

  return { kind: 'miss', reply: "Sorry, I can't do that yet. Try \"what's left today?\"" };
}
