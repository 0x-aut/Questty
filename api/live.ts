/**
 * POST /api/live (PR 7): start a GPT-Live talk session for the buddy.
 *
 * The browser creates a WebRTC offer (mic track + an "oai-events" data
 * channel) and posts its SDP here; this exchanges it with OpenAI
 * (POST /v1/live/sessions) using the server-only OPENAI_API_KEY and returns
 * { session: { id }, transport: { type, sdp } } so the browser can set the
 * answer. The key is never sent to or bundled into the client.
 *
 * Delegation is "client": GPT-Live only talks. Whenever the user asks for
 * anything to change in the room, GPT-Live delegates, and the app runs the
 * request through its own validated action set (src/buddy) and sends back a
 * short result to say. GPT-Live never acts on free text itself.
 *
 * GET returns { configured } so the client can fall back to push-to-talk.
 */
import { readApiKey, serverEnv } from './_openai.ts';

type VercelRequestLike = { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> };
type VercelResponseLike = {
  status(code: number): VercelResponseLike;
  json(body: unknown): void;
};

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_SDP = 20_000;
const MODEL_RE = /^[\w.:-]{1,64}$/u;
const VOICE_RE = /^[a-z]{2,16}$/u;

export const LIVE_INSTRUCTIONS = [
  'You are Questty, a calm, warm buddy inside a mixed-reality room full of task cards. You talk; the app acts.',
  'Whenever the user asks to change, move, add, rename, find, focus on, finish, delete, plan or list cards, or to control the focus timer, delegate it to the app right away. Never say you did something until the app tells you the result.',
  'When the app returns a result, say it back in one short sentence (under 10 words), e.g. "Moved it to your desk." If the app asks a question, ask it.',
  'Keep every reply brief and natural. No lists, no markdown. If the user is just chatting, answer in one sentence and gently steer back to their tasks.',
  'Stop talking as soon as the user starts speaking.',
].join('\n');

/** The session config sent to /v1/live/sessions (exported for the offline test). */
export function liveSessionBody(sdp: string): Record<string, unknown> {
  const env = serverEnv();
  const model = env.OPENAI_LIVE_MODEL && MODEL_RE.test(env.OPENAI_LIVE_MODEL) ? env.OPENAI_LIVE_MODEL : 'gpt-live-1';
  const voice = env.OPENAI_LIVE_VOICE && VOICE_RE.test(env.OPENAI_LIVE_VOICE) ? env.OPENAI_LIVE_VOICE : 'marin';
  return {
    session: {
      model,
      instructions: LIVE_INSTRUCTIONS,
      audio: { output: { voice } },
      // Client delegation: the app runs every request through its validated
      // executor. A short delay lets the app suppress the generic spoken
      // acknowledgement and answer with the real result instead.
      delegation: { type: 'client', acknowledgement_delay_ms: 700 },
    },
    transport: { type: 'webrtc', sdp },
  };
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
  const sdp = isRecord(request.body) && typeof request.body.sdp === 'string' ? request.body.sdp : '';
  if (sdp.trim().length === 0 || !sdp.startsWith('v=0')) {
    response.status(400).json({ error: 'sdp-required' });
    return;
  }
  if (sdp.length > MAX_SDP) {
    response.status(413).json({ error: 'sdp-too-large' });
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
    const res = await fetch('https://api.openai.com/v1/live/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(liveSessionBody(sdp)),
    });
    if (!res.ok) {
      let code = '';
      try {
        const err = (await res.json()) as { error?: { code?: unknown; type?: unknown } };
        code = String(err.error?.code ?? err.error?.type ?? '');
      } catch {
        /* not JSON */
      }
      console.error('[live] OpenAI returned', res.status, code);
      response.status(502).json({ error: 'live-session-failed', status: res.status });
      return;
    }
    const payload = (await res.json()) as { session?: { id?: unknown }; transport?: { type?: unknown; sdp?: unknown } };
    const answer = payload.transport?.sdp;
    if (typeof answer !== 'string' || answer.length === 0) {
      response.status(502).json({ error: 'invalid-live-response' });
      return;
    }
    response.status(201).json({
      session: { id: typeof payload.session?.id === 'string' ? payload.session.id : '' },
      transport: { type: 'webrtc', sdp: answer },
    });
  } catch {
    response
      .status(controller.signal.aborted ? 504 : 502)
      .json({ error: controller.signal.aborted ? 'timeout' : 'live-session-failed' });
  } finally {
    clearTimeout(timeout);
  }
}
