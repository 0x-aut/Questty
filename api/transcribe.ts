type VercelRequestLike = {
  method?: string;
  body?: unknown;
};

type VercelResponseLike = {
  status(code: number): VercelResponseLike;
  json(body: unknown): void;
};

// Server-side speech-to-text for the mic button. Every browser (Quest Browser
// has no Web Speech API) records the mic and posts the clip here as base64
// JSON; this forwards it to OpenAI with the server-only OPENAI_API_KEY.
// GET returns { configured } so the client can pick a fallback without a key.
// Kept under Vercel's 4.5 MB body limit: 30 s of Opus is roughly 150-250 KB.
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_AUDIO_BYTES = 3_000_000;
const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';

function readApiKey(): string | undefined {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.OPENAI_API_KEY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

export default async function handler(
  request: VercelRequestLike,
  response: VercelResponseLike,
): Promise<void> {
  if (request.method === 'GET') {
    // Capability probe for the client: is server transcription configured?
    // Never reveals the key itself.
    response.status(200).json({ configured: Boolean(readApiKey()) });
    return;
  }
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  const body = request.body;
  const audio = isRecord(body) && typeof body.audio === 'string' ? body.audio : '';
  const mimeType =
    isRecord(body) && typeof body.mimeType === 'string' && body.mimeType.startsWith('audio/')
      ? body.mimeType.split(';')[0]
      : 'audio/webm';
  if (audio.length === 0) {
    response.status(400).json({ error: 'audio-required' });
    return;
  }

  const bytes = Buffer.from(audio, 'base64');
  if (bytes.length === 0) {
    response.status(400).json({ error: 'audio-invalid' });
    return;
  }
  if (bytes.length > MAX_AUDIO_BYTES) {
    response.status(413).json({ error: 'audio-too-large' });
    return;
  }

  const apiKey = readApiKey();
  if (!apiKey) {
    response.status(500).json({ error: 'server-not-configured' });
    return;
  }

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), `brain-dump.${extensionFor(mimeType)}`);
  form.append('model', TRANSCRIBE_MODEL);
  form.append('response_format', 'json');
  form.append(
    'prompt',
    'A person listing tasks and to-dos for their day, for example: email Sam, finish the deck, go to the gym.',
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const openAIResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!openAIResponse.ok) {
      console.error('[transcribe] OpenAI returned', openAIResponse.status);
      response.status(502).json({ error: 'transcription-failed' });
      return;
    }
    const payload = (await openAIResponse.json()) as { text?: unknown };
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    response.status(200).json({ text: Array.from(text).slice(0, 1_000).join('') });
  } catch {
    response
      .status(504)
      .json({ error: controller.signal.aborted ? 'timeout' : 'transcription-failed' });
  } finally {
    clearTimeout(timeout);
  }
}
