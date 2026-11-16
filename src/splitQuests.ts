export type QuestSuggestion = {
  title: string;
  xp: number;
  zone: 'desk' | 'door' | 'wall';
};

const ZONES: QuestSuggestion['zone'][] = ['desk', 'door', 'wall'];
// Spoken lead-ins that are not tasks on their own ("Okay, so, ...").
const FILLER = /^(ok(ay)?|so|um+|uh+|right|alright|well|also|then|today|and)$/iu;
const LEAD_IN = /^(so |then |also |and |today )?(i (need|have|want|got) to |i should |i'?ll |i must |need to |have to )/iu;

/** Split an utterance into up to five short, deterministic fallback quests. */
export function splitQuests(text: string): QuestSuggestion[] {
  const chunks = text
    .replace(/([.!?])\s+/gu, '$1|')
    .replace(/[\r\n,;]+|\s+\band\b\s+/giu, '|')
    .split('|')
    .map((chunk) => chunk.replace(/^[\s.!?,;]+|[\s.!?,;]+$/gu, '').trim())
    .map((chunk) => chunk.replace(LEAD_IN, '').trim())
    .filter((chunk) => chunk.length > 0 && !FILLER.test(chunk));

  if (chunks.length > 5) {
    chunks.splice(4, chunks.length - 4, chunks.slice(4).join(' '));
  }

  return chunks.map((chunk, index) => {
    const words = chunk.split(/\s+/u).slice(0, 6);
    const joined = words.join(' ');
    const title = joined.charAt(0).toUpperCase() + joined.slice(1);
    return {
      title,
      xp: Math.min(50, Math.max(10, 10 + words.length * 5)),
      zone: ZONES[index % ZONES.length],
    };
  });
}
