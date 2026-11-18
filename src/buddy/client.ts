/**
 * Talks to /api/buddy (PR 6). The OpenAI key never reaches the browser: the
 * route runs on the server (Vite dev plugin locally, a serverless function in
 * a deploy) and reads OPENAI_API_KEY there. This module only sends the
 * transcript plus a compact card list and gets back raw actions and a reply
 * line, which the caller validates (actions.ts) before anything runs.
 */
import type { BuddyCard } from './actions.js';
import { knownDocs } from '../documents.js';
import { memoryPayload } from './memory.js';
import { isReviewOpen } from '../review-store.js';

export type BuddyApiReply = { reply: unknown; actions: unknown };
export type FocusInfo = { card_id: string; paused: boolean; remaining_min: number } | null;

// The server may search the web and read a page first (up to ~25 s, hard stop 32 s).
const TIMEOUT_MS = 35_000;
/** After the server says it has no key, skip it for a while (go straight to the offline parser). */
const NOT_CONFIGURED_BACKOFF_MS = 60_000;
let skipUntil = 0;

export class BuddyApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function askBuddyApi(
  text: string,
  cards: readonly BuddyCard[],
  focus: FocusInfo,
  signal?: AbortSignal,
  /** Talk mode: the latest lines of the live voice conversation (both speakers), for "it" / "that one" / "yes". */
  talk?: string,
): Promise<BuddyApiReply> {
  if (performance.now() < skipUntil) throw new BuddyApiError('not-configured');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  signal?.addEventListener('abort', () => controller.abort());
  try {
    const response = await fetch('/api/buddy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // PR 10: the documents the buddy may open (ids + titles only, never their text).
      // The request is the END of what was said (talk mode can gather a few sentences): keep the tail.
      body: JSON.stringify({
        text: text.slice(-500),
        cards: cards.slice(0, 40),
        focus,
        docs: knownDocs().slice(0, 20).map((d) => ({ id: d.id, title: d.title })),
        memory: memoryPayload(),
        // PR 18: so "not now" / "get rid of this" can mean the evening review card.
        review: { open: isReviewOpen() },
        ...(talk ? { talk: talk.slice(-1500) } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      let code = `http-${response.status}`;
      try {
        const payload = (await response.json()) as { error?: unknown };
        if (typeof payload.error === 'string') code = payload.error;
      } catch {
        // not JSON
      }
      if (code === 'server-not-configured') skipUntil = performance.now() + NOT_CONFIGURED_BACKOFF_MS;
      throw new BuddyApiError(code);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    if (typeof payload !== 'object' || payload === null) throw new BuddyApiError('bad-payload');
    return { reply: payload.reply, actions: payload.actions };
  } catch (error) {
    if (error instanceof BuddyApiError) throw error;
    throw new BuddyApiError(controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    window.clearTimeout(timeout);
  }
}

/** A request that will probably need the web (an article, a docs page, a recipe, news, a chapter, a lookup). */
export function looksLikeWeb(text: string): boolean {
  return /\b(chapter|novel|article|search|look up|pull up|google|online|on the web|from the internet|fetch|wikipedia|wiki|gutenberg|recipe|news|headlines|docs|documentation|website)\b/iu.test(text);
}

/** Test/dev: forget the "not configured" backoff. */
export function resetBuddyApiBackoff(): void {
  skipUntil = 0;
}
