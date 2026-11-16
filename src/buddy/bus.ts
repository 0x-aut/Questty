/**
 * Tiny link between the mic (quest-input.ts) and the buddy (buddy/ui.ts), so
 * neither imports the other. One mic, one orb: the mic reports its state and
 * level here; a transcript that reads as a command is handed to the buddy.
 */
export type MicState = 'idle' | 'listening' | 'transcribing' | 'cards' | 'error';

type BuddyLink = {
  command(text: string, source: 'voice' | 'tap'): void;
  mic(state: MicState, detail?: string): void;
  level(level: number): void;
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

export function reportMic(state: MicState, detail?: string): void {
  link?.mic(state, detail);
}

export function reportMicLevel(level: number): void {
  link?.level(level);
}
