/**
 * PR 10: a tiny bus so systems outside the buddy (return ritual, tier-up,
 * physical finish, documents) can have the buddy say a line in its caption
 * bubble, with chips (an Undo, Roll over...). BuddySystem registers the
 * handler; with no buddy the call is a no-op that returns false.
 */
export type AnnounceChip = { label: string; kind?: 'primary' | 'plain' | 'danger'; run: () => void };
export type AnnounceOptions = { tag?: string; ms?: number; chips?: AnnounceChip[] };
type Announcer = (text: string, options: AnnounceOptions) => void;
type UndoPusher = (label: string, run: () => Promise<string[]>) => void;

let announcer: Announcer | undefined;
let undoPusher: UndoPusher | undefined;
const log: Array<{ text: string; at: number; tag: string }> = [];

export function setAnnouncer(fn: Announcer | undefined, undo?: UndoPusher): void {
  announcer = fn;
  undoPusher = undo;
}

/** Have the buddy say `text` (its caption bubble). */
export function announce(text: string, options: AnnounceOptions = {}): boolean {
  log.push({ text, at: Date.now(), tag: options.tag ?? 'QUESTTY' });
  if (log.length > 40) log.shift();
  if (announcer === undefined) return false;
  announcer(text, options);
  return true;
}

/** Put an undo on the buddy's stack (so "undo" by voice works too). */
export function pushBuddyUndo(label: string, run: () => Promise<string[]>): void {
  undoPusher?.(label, run);
}

/** Dev/test: the recent announcements. */
export function announceLog(): Array<{ text: string; at: number; tag: string }> {
  return [...log];
}
