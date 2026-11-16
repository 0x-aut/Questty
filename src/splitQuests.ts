import { inferCategory, startsWithTiming, stripTiming, type CategoryId } from './category-config.js';

export type QuestSuggestion = {
  title: string;
  xp: number;
  zone: 'desk' | 'door' | 'wall';
  /** When the user wants to do it (time category), if the words said so. Optional. */
  when?: CategoryId;
};

const ZONES: QuestSuggestion['zone'][] = ['desk', 'door', 'wall'];
// Spoken lead-ins that are not tasks on their own ("Okay, so, ...").
const FILLER = /^(ok(ay)?|so|um+|uh+|right|alright|well|also|then|today|and)$/iu;
const LEAD_IN = /^(so |then |also |and |today )?(i (need|have|want|got) to |i should |i'?ll |i must |need to |have to )/iu;

/** Break an utterance into raw clauses (sentences, commas, "and"). */
export function splitClauses(text: string): string[] {
  return text
    .replace(/([.!?])\s+/gu, '$1|')
    .replace(/[\r\n,;]+|\s+\band\b\s+/giu, '|')
    .split('|')
    .map((chunk) => chunk.replace(/^[\s.!?,;]+|[\s.!?,;]+$/gu, '').trim())
    .filter((chunk) => chunk.length > 0);
}

/**
 * Split an utterance into up to five short, deterministic fallback quests.
 * Timing words pre-set each quest's category ("today", "later"/"tomorrow",
 * "before I leave"); a clause that starts with one carries it to the next
 * clauses until another timing word comes up ("Before I leave, grab keys,
 * lock the door").
 */
export function splitQuests(text: string): QuestSuggestion[] {
  const items: Array<{ text: string; when?: CategoryId }> = [];
  let carry: CategoryId | null = null;
  for (const raw of splitClauses(text)) {
    const own = inferCategory(raw);
    if (own !== null && startsWithTiming(raw)) carry = own;
    const when = own ?? carry;
    const chunk = stripTiming(raw)
      .replace(/^[\s.!?,;]+|[\s.!?,;]+$/gu, '')
      .replace(LEAD_IN, '')
      .trim();
    if (chunk.length === 0 || FILLER.test(chunk)) continue;
    items.push(when !== null ? { text: chunk, when } : { text: chunk });
  }

  if (items.length > 5) {
    const tail = items.slice(4);
    items.splice(4, items.length - 4, { text: tail.map((i) => i.text).join(' '), when: tail[0].when });
  }

  return items.map((item, index) => {
    const words = item.text.split(/\s+/u).slice(0, 6);
    const joined = words.join(' ');
    const title = joined.charAt(0).toUpperCase() + joined.slice(1);
    const quest: QuestSuggestion = {
      title,
      xp: Math.min(50, Math.max(10, 10 + words.length * 5)),
      zone: ZONES[index % ZONES.length],
    };
    if (item.when !== undefined) quest.when = item.when;
    return quest;
  });
}

const STOP = new Set(['the', 'a', 'an', 'to', 'for', 'about', 'my', 'and', 'of', 'on', 'in', 'at', 'with']);
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9']+/u)
    .filter((w) => w.length > 2 && !STOP.has(w));

/**
 * Timing for a quest the AI made without one: the timing of the transcript
 * clause that shares the most words with its title (carried timing included),
 * else whatever the title itself says. Null when nothing says when.
 */
export function inferWhenFromTranscript(title: string, transcript: string): CategoryId | null {
  const fromTitle = inferCategory(title);
  if (fromTitle !== null) return fromTitle;
  const titleWords = new Set(words(title));
  if (titleWords.size === 0) return null;
  let carry: CategoryId | null = null;
  let best: { score: number; when: CategoryId | null } = { score: 0, when: null };
  for (const raw of splitClauses(transcript)) {
    const own = inferCategory(raw);
    if (own !== null && startsWithTiming(raw)) carry = own;
    const when = own ?? carry;
    const score = words(raw).filter((w) => titleWords.has(w)).length;
    if (score > best.score) best = { score, when };
  }
  return best.when;
}
