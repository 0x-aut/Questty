/**
 * POST /api/speak (PR 11): the buddy's voice for short spoken lines (the
 * rotating break prompts). Sends one line to OpenAI text-to-speech with the
 * server-only OPENAI_API_KEY and returns { audio: base64 mp3, mime }. The
 * client caches each line, so a prompt is synthesised once per device.
 *
 * Model: OPENAI_TTS_MODEL (default gpt-4o-mini-tts); voice: OPENAI_LIVE_VOICE
 * (default marin, the same voice the talk mode uses).
 *
 * GET returns { configured } so the client can fall back to the browser's
 * own speech synthesis.
 */
import { readApiKey, serverEnv } from './_openai.js';

type VercelRequestLike = { method?: string; body?: unknown };
type VercelResponseLike = { status(code: number): VercelResponseLike; json(body: unknown): void };

const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_SPEAK_CHARS = 160;
const MODEL_RE = /^[\w.:-]{1,64}$/u;
const VOICE_RE = /^[a-z]{2,16}$/u;

export const SPEAK_INSTRUCTIONS = 'Speak like a calm, warm study buddy: gentle, unhurried, friendly. Never shout.';

/** The text-to-speech request body (exported for the offline test). */
export function speakBody(text: string): Record<string, unknown> {
  const env = serverEnv();
  const model = env.OPENAI_TTS_MODEL && MODEL_RE.test(env.OPENAI_TTS_MODEL) ? env.OPENAI_TTS_MODEL : 'gpt-4o-mini-tts';
  const voice = env.OPENAI_LIVE_VOICE && VOICE_RE.test(env.OPENAI_LIVE_VOICE) ? env.OPENAI_LIVE_VOICE : 'marin';
  return { model, voice, input: text, instructions: SPEAK_INSTRUCTIONS, response_format: 'mp3' };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export default async function handler(request: VercelRequestLike, response: VercelResponseLike): Promise<void> {
  if (request.method === 'GET') {
    response.status(200).json({ configured: Boolean(readApiKey()) });
    return;
  }
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'method-not-allowed' });
    return;
  }
  const text = isRecord(request.body) && typeof request.body.text === 'string' ? request.body.text.trim() : '';
  if (text.length === 0) {
    response.status(400).json({ error: 'text-required' });
    return;
  }
  if (text.length > MAX_SPEAK_CHARS) {
    response.status(413).json({ error: 'text-too-long' });
    return;
  }
  const apiKey = readApiKey();
  if (!apiKey) {
    response.status(500).json({ error: 'server-not-configured' });
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(speakBody(text)),
    });
    if (!res.ok) {
      console.error('[speak] OpenAI returned', res.status);
      response.status(502).json({ error: 'speak-failed', status: res.status });
      return;
    }
    const audio = Buffer.from(await res.arrayBuffer()).toString('base64');
    response.status(200).json({ audio, mime: 'audio/mpeg' });
  } catch {
    response.status(controller.signal.aborted ? 504 : 502).json({ error: controller.signal.aborted ? 'timeout' : 'speak-failed' });
  } finally {
    clearTimeout(timeout);
  }
}
