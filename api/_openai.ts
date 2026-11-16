/**
 * Shared server-only helper for the api/ functions: one call to OpenAI's
 * Responses API that must answer in a strict JSON schema (or plain text).
 *
 * The leading underscore keeps Vercel from deploying this file as a route.
 *
 * Models: every text call uses gpt-6-luna by default (override per route with
 * OPENAI_BUDDY_MODEL / OPENAI_QUESTS_MODEL, or OPENAI_TEXT_MODEL for all).
 * Luna is a reasoning model, so per OpenAI's GPT-6 migration notes we send
 * `reasoning.effort` and never `temperature` / `top_p` (those 400 unless the
 * effort is "none"). The effort defaults to "low" and can be overridden with
 * OPENAI_REASONING_EFFORT (none | low | medium | high). Structured output goes
 * through `text.format` (the Responses shape of `response_format`).
 */
export const DEFAULT_TEXT_MODEL = 'gpt-6-luna';
const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

type Env = Record<string, string | undefined>;

export function serverEnv(): Env {
  const runtime = globalThis as typeof globalThis & { process?: { env?: Env } };
  return runtime.process?.env ?? {};
}

export function readApiKey(): string | undefined {
  return serverEnv().OPENAI_API_KEY;
}

const MODEL_RE = /^[\w.:-]{1,64}$/u;

/** The text model for a route: its own override, then the shared one, then Luna. */
export function readTextModel(routeVar: string): string {
  const env = serverEnv();
  for (const candidate of [env[routeVar], env.OPENAI_TEXT_MODEL]) {
    if (typeof candidate === 'string' && MODEL_RE.test(candidate)) return candidate;
  }
  return DEFAULT_TEXT_MODEL;
}

export function readEffort(fallback = 'low'): string {
  const effort = serverEnv().OPENAI_REASONING_EFFORT;
  return typeof effort === 'string' && EFFORTS.has(effort) ? effort : fallback;
}

export type JsonSchemaFormat = {
  name: string;
  strict: true;
  schema: Record<string, unknown>;
};

export type ResponsesCall = {
  apiKey: string;
  model: string;
  effort?: string;
  instructions: string;
  /** Extra developer messages (data the model reads, never instructions). */
  context?: string[];
  input: string;
  schema?: JsonSchemaFormat;
  maxOutputTokens: number;
  signal: AbortSignal;
};

export type ResponsesResult =
  { ok: true; text: string; usage?: unknown } | { ok: false; status: number; error: string };

/** The request body, exported so unit tests can check its shape offline. */
export function responsesBody(call: Omit<ResponsesCall, 'apiKey' | 'signal'>): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [{ role: 'developer', content: call.instructions }];
  for (const line of call.context ?? []) input.push({ role: 'developer', content: line });
  input.push({ role: 'user', content: call.input });
  const body: Record<string, unknown> = {
    model: call.model,
    reasoning: { effort: call.effort ?? readEffort() },
    input,
    max_output_tokens: call.maxOutputTokens,
    store: false,
  };
  if (call.schema) body.text = { format: { type: 'json_schema', ...call.schema } };
  return body;
}

/** Concatenate the output_text parts of a Responses payload (null on refusal). */
export function outputText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as { output_text?: unknown; output?: unknown };
  if (typeof record.output_text === 'string') return record.output_text;
  if (!Array.isArray(record.output)) return null;
  let text = '';
  for (const item of record.output) {
    if (typeof item !== 'object' || item === null) continue;
    const message = item as { type?: unknown; content?: unknown };
    if (message.type !== 'message' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (typeof part !== 'object' || part === null) continue;
      const p = part as { type?: unknown; text?: unknown };
      if (p.type === 'refusal') return null;
      if (p.type === 'output_text' && typeof p.text === 'string') text += p.text;
    }
  }
  return text.length > 0 ? text : null;
}

export async function callResponses(call: ResponsesCall): Promise<ResponsesResult> {
  const { apiKey, signal, ...rest } = call;
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal,
    body: JSON.stringify(responsesBody(rest)),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const err = (await res.json()) as {
        error?: { code?: unknown; type?: unknown };
      };
      detail = String(err.error?.code ?? err.error?.type ?? '');
    } catch {
      /* not JSON */
    }
    console.error('[api] OpenAI responses returned', res.status, detail);
    return { ok: false, status: res.status, error: 'generation-failed' };
  }
  const payload = (await res.json()) as { status?: unknown; usage?: unknown };
  const text = outputText(payload);
  if (text === null) return { ok: false, status: 502, error: 'invalid-model-response' };
  return { ok: true, text, usage: payload.usage };
}
