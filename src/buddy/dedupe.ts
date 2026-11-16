/**
 * Duplicate-card check (PR 8): before the buddy (AI, offline parser, talk
 * mode, push-to-talk) or a brain dump adds a card, look for one already on
 * the board with the same meaning, and ask instead of adding a second one.
 *
 * Pure (no IWSDK imports), so the harness unit-tests it with esbuild.
 *
 * How two titles are compared
 * ---------------------------
 * 1. `titleTokens()` normalizes a title: lowercase, curly quotes and
 *    possessives folded, punctuation dropped, then articles, filler and
 *    timing words removed (STOP below: "go to the gym today" -> ["gym"]),
 *    and a light plural fold ("calls" -> "call", "groceries" -> "grocery").
 * 2. `titleSimilarity()` is the larger of two scores, both 0..1:
 *    - token overlap: words of A that also appear in B (exactly, or as a
 *      near-identical spelling for words of 5+ letters, Levenshtein ratio
 *      >= 0.8, so a misheard "launch"/"lunch" still counts), divided by the
 *      LONGER token list. Dividing by the longer list is what keeps
 *      "gym" vs "gym bag shopping" apart (1/3) while "gym" vs "Go to the
 *      gym" is 1/1.
 *    - Levenshtein ratio of the two normalized strings (1 - distance /
 *      longer length), which catches typos and spacing ("pitchdeck").
 * 3. A pair is a duplicate at >= DUP_THRESHOLD (0.8) on either score.
 *    So with 4-5 word titles one extra word still matches (4/5 = 0.8); with
 *    short titles every meaningful word has to be there (2 of 3 = 0.67 is
 *    not a match: "gym" vs "gym after lunch" is NOT a duplicate).
 * When a title is nothing but filler ("do it"), the plain lowercased strings
 * are compared instead.
 */

export const DUP_THRESHOLD = 0.8;
/** Per-word fuzzy equality, only for words of at least this many letters. */
export const WORD_FUZZY_MIN = 5;
export const WORD_FUZZY_RATIO = 0.8;
/** How long a "you already have X. Add another one?" question waits. */
export const DUP_QUESTION_MS = 20_000;
/** Identical Live delegations within this window run once. */
export const DELEGATION_DEDUPE_MS = 5_000;

const STOP = new Set([
  // articles, pronouns, glue
  'a', 'an', 'the', 'my', 'our', 'your', 'some', 'this', 'that', 'it', 'to', 'for', 'of', 'on', 'at', 'in', 'and',
  'with', 'about', 'up',
  // filler / framing
  'go', 'going', 'goes', 'do', 'doing', 'please', 'just', 'need', 'needs', 'i', 'have', 'got', 'gotta', 'must',
  'should', 'want', 'remember', 'reminder', 'card', 'quest', 'task', 'todo', 'new', 'also', 'again', 'really',
  'quick', 'quickly',
  // timing words (the category carries timing, not the title)
  'today', 'tonight', 'tomorrow', 'later', 'now', 'soon', 'morning', 'afternoon', 'evening', 'before', 'leave',
  'week', 'weekend', 'asap',
]);

function fold(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  return word;
}

/** Lowercase, punctuation-free, without articles/filler/timing words. */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[’‘`]/gu, "'")
    .replace(/'s\b/gu, '')
    .replace(/[^a-z0-9\s]/gu, ' ')
    .split(/\s+/u)
    .filter((w) => w.length > 0 && !STOP.has(w))
    .map(fold);
}

export function normalizeTitle(title: string): string {
  return titleTokens(title).join(' ');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1 - distance / longer length (1 = identical). */
export function levenshteinRatio(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  return longer === 0 ? 1 : 1 - levenshtein(a, b) / longer;
}

function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  return Math.min(a.length, b.length) >= WORD_FUZZY_MIN && levenshteinRatio(a, b) >= WORD_FUZZY_RATIO;
}

/** Shared words / the longer token list (each word of B used once). */
export function tokenOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const left = [...b];
  let hit = 0;
  for (const w of a) {
    const i = left.findIndex((x) => sameWord(w, x));
    if (i >= 0) {
      hit += 1;
      left.splice(i, 1);
    }
  }
  return hit / Math.max(a.length, b.length);
}

/** 0..1, see the header. */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.length === 0 || tb.length === 0) {
    const ra = a.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
    const rb = b.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
    return ra.length > 0 && ra === rb ? 1 : 0;
  }
  return Math.max(tokenOverlap(ta, tb), levenshteinRatio(ta.join(' '), tb.join(' ')));
}

export function isDuplicateTitle(a: string, b: string): boolean {
  return titleSimilarity(a, b) >= DUP_THRESHOLD;
}

/** The existing card that best matches `title`, when it is a duplicate. */
export function findDuplicate<T extends { title: string }>(title: string, cards: readonly T[]): { card: T; score: number } | null {
  let best: { card: T; score: number } | null = null;
  for (const card of cards) {
    const score = titleSimilarity(title, card.title);
    if (score >= DUP_THRESHOLD && (best === null || score > best.score)) best = { card, score };
  }
  return best;
}

// ------------------------------------------------------------------ answers

export type DupAnswer = 'add' | 'skip' | 'show';

function answerText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`]/gu, "'")
    .replace(/[^a-z'\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^((hey|hi|um+|uh+|questty|buddy|well|so|oh)\s+)+/u, '')
    .replace(/(\s+(please|thanks|thank you|then|for me|questty|buddy))+$/u, '')
    .trim();
}

const SHOW = /^(show( me)?( it| them| that( one)?| where( it is| they are)?| the (card|one)| me where)?|where( is it| are they|'s it| is that)?|find it|find them|which one|point( to it| me to it)?|where's that)$/u;
const SKIP =
  /^((no|nope|nah|no no)( thanks| thank you| don't| dont| skip( it| them)?| leave it| need| never ?mind)?|skip( it| them| that| those| this one)?|never ?mind|don't|dont|do not|don't add( it| them)?|leave it|forget it|cancel( it)?|no need|not needed|keep (just )?(the )?(one|old one|existing one))$/u;
const ADD =
  /^((yes|yeah|yep|yup|ya|sure|ok|okay|alright|right)( please| sure| do it| go ahead)?( (add|make)( it| them| one| another( one)?| a second( one)?)?( anyway| again| too| as well)?)?|(add|make)( it| them| one| another( one)?| a second( one)?| both)?( anyway| again| too| as well)?|another( one)?|one more|do it|go ahead|please do|keep both|both)$/u;

/**
 * Is this short reply an answer to a pending "Add another one?" question?
 * Null when it is something else (a new command, which cancels the question).
 */
export function answerKind(text: string): DupAnswer | null {
  const t = answerText(text);
  if (t.length === 0 || t.split(' ').length > 7) return null;
  if (SHOW.test(t)) return 'show';
  if (SKIP.test(t)) return 'skip';
  if (ADD.test(t)) return 'add';
  return null;
}

/** Key for "the same Live delegation heard twice": lowercase, no punctuation. */
export function delegationKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`]/gu, "'")
    .replace(/[^a-z0-9'\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** "on the wall on your left" -> "on the left wall" (shorter, for the question). */
export function shortWhere(where: string): string {
  return where
    .replace(/^on the wall on your (left|right)$/u, 'on the $1 wall')
    .replace(/^on the wall in front of you$/u, 'on the front wall')
    .replace(/^on the desk in front of you$/u, 'on the desk')
    .replace(/^on the door (in front of you|on your left|on your right|behind you)$/u, 'on the door');
}
