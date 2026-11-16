/**
 * Tiny link between the mic (quest-input.ts) and the buddy (buddy/ui.ts), so
 * neither imports the other. One mic, one orb: the mic reports its state and
 * level here; a transcript that reads as a command is handed to the buddy.
 */
export type MicState = 'idle' | 'listening' | 'transcribing' | 'cards' | 'error';

/** A brain-dump item the buddy may be asked about (PR 8 duplicate check). */
export type DumpItem = { title: string; category?: string; xp?: number };

type BuddyLink = {
  command(text: string, source: 'voice' | 'tap'): void;
  mic(state: MicState, detail?: string): void;
  level(level: number): void;
  /** PR 8: indices of the items that duplicate a card already on the board. */
  duplicates?(titles: string[]): number[];
  /** PR 8: ask once about these duplicates ("2 of these are already on your board..."). */
  askDuplicates?(items: DumpItem[], added: number): void;
  /** PR 8: is the buddy waiting for an answer this utterance gives (yes / skip / show it)? */
  wantsAnswer?(text: string): boolean;
  /** PR 8: another command came in: drop a pending question without a word. */
  dismissQuestion?(): void;
};

let link: BuddyLink | undefined;

export function setBuddyLink(next: BuddyLink | undefined): void {
  link = next;
}

/** True when the buddy is running (it registered itself). */
export function buddyReady(): boolean {
  return link !== undefined;
}

export function sendBuddyCommand(text: string, source: 'voice' | 'tap' = 'voice'): void {
  link?.command(text, source);
}

/** PR 8: indices of brain-dump titles that duplicate an existing card ([] without a buddy). */
export function findDumpDuplicates(titles: string[]): number[] {
  return link?.duplicates?.(titles) ?? [];
}

export function askDumpDuplicates(items: DumpItem[], added: number): void {
  link?.askDuplicates?.(items, added);
}

/** PR 8: true when this transcript answers the buddy's pending question (route it to the buddy). */
export function buddyWantsAnswer(text: string): boolean {
  return link?.wantsAnswer?.(text) ?? false;
}

export function dismissBuddyQuestion(): void {
  link?.dismissQuestion?.();
}

export function reportMic(state: MicState, detail?: string): void {
  link?.mic(state, detail);
}

export function reportMicLevel(level: number): void {
  link?.level(level);
}

// PR 7: talk mode. Pinching the pill orb asks the buddy to start or stop a
// GPT-Live talk session; when it can't (no server key, offline, no WebRTC)
// it returns false and the mic falls back to push-to-talk.
let talkToggle: (() => boolean) | undefined;
let pushToTalk: (() => void) | undefined;

export function setTalkToggle(fn: (() => boolean) | undefined): void {
  talkToggle = fn;
}

export function toggleBuddyTalk(): boolean {
  return talkToggle?.() ?? false;
}

export function setPushToTalk(fn: (() => void) | undefined): void {
  pushToTalk = fn;
}

export function startPushToTalk(): void {
  pushToTalk?.();
}
