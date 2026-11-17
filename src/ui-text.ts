/**
 * PR 11: the UI font (UIKit's MSDF atlas) has no curly quotes, middle dot,
 * dashes or ellipsis, so text from the AI (GPT-Live / Luna replies, card
 * titles) or from our own tags drew blanks and logged "Missing glyph" on
 * every frame it changed. Map them to plain ASCII before display.
 */
const MAP: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\u00B7': '-', '\u2022': '-', '\u2013': '-', '\u2014': '-', '\u2212': '-',
  '\u2026': '...', '\u00A0': ' ', '\u2009': ' ', '\u202F': ' ',
};
const RE = /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u00B7\u2022\u2013\u2014\u2212\u2026\u00A0\u2009\u202F]/gu;

export function uiSafe(text: string): string {
  return text.replace(RE, (c) => MAP[c] ?? c);
}
