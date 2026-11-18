/**
 * PR 11: the buddy says short lines out loud (the rotating break prompts).
 *
 * The line is synthesised by /api/speak (OpenAI text-to-speech, the talk
 * mode's voice) and played from the orb. Each line is cached per device
 * (localStorage), so a prompt costs one call the first time only. Without a
 * server key, or if that fails, the browser's own speech synthesis says it.
 * The caption bubble always shows the words too.
 */
import { isTalkActive, playBuddySpeech, stopBuddySpeech } from './sfx.js';

const CACHE_PREFIX = 'questty.voice.v1.';
const MAX_CACHE_CHARS = 400_000;
const memory = new Map<string, ArrayBuffer>();
const inflight = new Map<string, Promise<ArrayBuffer | null>>();
/** Lines whose preload failed: not fetched again ahead of time (speaking them still tries once). */
const preloadFailed = new Set<string>();
let serverOff = false;
let speakSeq = 0;
const speechLog: Array<{ at: number; key: string; via: 'cache' | 'api' | 'browser' | 'none' }> = [];

function cacheKey(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return CACHE_PREFIX + h.toString(36);
}

function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function fetchLine(text: string, key: string): Promise<ArrayBuffer | null> {
  const stored = (() => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  })();
  if (stored) return fromBase64(stored);
  if (serverOff) return null;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 500 || res.status === 404) serverOff = true;
      return null;
    }
    const payload = (await res.json()) as { audio?: unknown };
    if (typeof payload.audio !== 'string' || payload.audio.length === 0) return null;
    if (payload.audio.length < MAX_CACHE_CHARS) {
      try {
        localStorage.setItem(key, payload.audio);
      } catch {
        // storage full: it is fetched again next time
      }
    }
    return fromBase64(payload.audio);
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function browserSpeak(text: string): boolean {
  if (isTalkActive()) return false;
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (synth === undefined || typeof SpeechSynthesisUtterance === 'undefined') return false;
  try {
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    synth.speak(u);
    return true;
  } catch {
    return false;
  }
}

/** Fetch (and cache) a line ahead of time so it plays without a wait. */
export function preloadBuddyLine(text: string): void {
  const key = cacheKey(text);
  if (memory.has(key) || inflight.has(key) || preloadFailed.has(key)) return;
  const p = fetchLine(text, key).then((buf) => {
    if (buf !== null) memory.set(key, buf);
    else preloadFailed.add(key);
    inflight.delete(key);
    return buf;
  });
  inflight.set(key, p);
}

/**
 * Say `text` in the buddy's voice. `stillWanted` is checked once the audio is
 * ready (a break skipped meanwhile stays silent). One line at a time: a newer
 * line replaces the one still playing. While a live talk session owns the
 * voice, nothing is spoken (the caption still shows).
 */
export async function speakBuddyLine(text: string, stillWanted: () => boolean = () => true): Promise<void> {
  if (isTalkActive()) return;
  const seq = (speakSeq += 1);
  const key = cacheKey(text);
  try {
    let via: 'cache' | 'api' | 'browser' | 'none' = memory.has(key) ? 'cache' : 'api';
    let buf = memory.get(key) ?? null;
    if (buf === null) {
      const pending = inflight.get(key) ?? fetchLine(text, key);
      buf = await pending;
      if (buf !== null) memory.set(key, buf);
    }
    // A newer line was asked for meanwhile, talk took over, or the break ended.
    if (seq !== speakSeq || isTalkActive() || !stillWanted()) return;
    stopBuddySpeech();
    if (buf !== null && (await playBuddySpeech(buf, 'speech'))) {
      speechLog.push({ at: Date.now(), key, via });
      return;
    }
    if (seq !== speakSeq || isTalkActive()) return;
    via = browserSpeak(text) ? 'browser' : 'none';
    speechLog.push({ at: Date.now(), key, via });
  } finally {
    if (speechLog.length > 30) speechLog.shift();
  }
}

/** Dev/test: what was said and how. */
export function buddySpeechLog(): ReadonlyArray<{ at: number; key: string; via: string }> {
  return speechLog;
}
