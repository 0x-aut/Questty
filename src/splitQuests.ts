export type QuestSuggestion = {
  title: string;
  xp: number;
  zone: 'desk' | 'door' | 'wall';
};

const ZONES: QuestSuggestion['zone'][] = ['desk', 'door', 'wall'];

/** Split an utterance into up to five short, deterministic fallback quests. */
export function splitQuests(text: string): QuestSuggestion[] {
  const chunks = text
    .replace(/([.!?])\s+/gu, '$1|')
    .replace(/[\r\n,;]+|\s+\band\b\s+/giu, '|')
    .split('|')
    .map((chunk) => chunk.replace(/^[\s.!?,;]+|[\s.!?,;]+$/gu, '').trim())
    .filter((chunk) => chunk.length > 0);

  if (chunks.length > 5) {
    chunks.splice(4, chunks.length - 4, chunks.slice(4).join(' '));
  }

  return chunks.map((chunk, index) => {
    const words = chunk.split(/\s+/u).slice(0, 6);
    const title = words.join(' ');
    return {
      title,
      xp: Math.min(50, Math.max(10, 10 + words.length * 5)),
      zone: ZONES[index % ZONES.length],
    };
  });
}
