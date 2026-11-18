/**
 * Server-only web helpers for the buddy's tools (web_search, read_page).
 * The leading underscore keeps Vercel from deploying this file as a route.
 *
 * Providers (keys are server env vars, never VITE_):
 *  - Search: Context.dev POST https://api.context.dev/v1/web/search
 *      body { query, numResults } -> { results: [{ url, title, description }] }
 *    fallback Firecrawl POST https://api.firecrawl.dev/v2/search
 *      body { query, limit } -> { success, data: { web: [{ url, title, description }] } }
 *  - Read: Firecrawl POST https://api.firecrawl.dev/v2/scrape
 *      body { url, formats: ['markdown'], onlyMainContent: true, timeout }
 *      -> { success, data: { markdown, metadata: { title, url } } }
 *    fallback Context.dev POST https://api.context.dev/v1/web/scrape
 *      body { url, formats: { markdown: true } }
 *      -> { url, markdown: { success, data }, metadata: { title, finalUrl } }
 *
 * Every call has its own timeout and never throws: failures come back as a
 * friendly { ok: false, error } the model can read.
 */
import { serverEnv } from './_openai.js';

export const PROVIDER_TIMEOUT_MS = 12_000;
/** What the model gets to read from one page (the full page stays server-side). */
export const MODEL_PAGE_CHARS = 20_000;
/** What we keep of a page server-side (for slicing a chapter out of a long book). */
export const MAX_PAGE_CHARS = 1_500_000;

export type SearchHit = { url: string; title: string; description: string };
export type SearchResult = { ok: true; provider: string; results: SearchHit[] } | { ok: false; error: string };
export type PageResult = { ok: true; provider: string; url: string; title: string; markdown: string } | { ok: false; error: string };

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);
/** Tests: swap the network out. */
export function setWebFetch(f: FetchLike | null): void {
  fetchImpl = f ?? ((...args) => fetch(...args));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, n: number): string => (typeof v === 'string' ? v.slice(0, n) : '');

/** Only public http(s) URLs; no credentials, no local/private hosts. */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/u.test(h) || /^172\.(1[6-9]|2\d|3[01])\./u.test(h) || h.includes(':')) return null;
  if (!h.includes('.')) return null;
  return u.toString();
}

async function postJson(url: string, key: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: controller.signal.aborted ? 408 : 0, json: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function hits(list: unknown): SearchHit[] {
  if (!Array.isArray(list)) return [];
  const out: SearchHit[] = [];
  for (const r of list) {
    if (!isRecord(r)) continue;
    const url = safeUrl(r.url);
    if (url === null) continue;
    out.push({ url, title: str(r.title, 200), description: str(r.description ?? r.snippet, 400) });
    if (out.length >= 6) break;
  }
  return out;
}

export async function webSearch(query: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SearchResult> {
  const q = query.replace(/\s+/gu, ' ').trim().slice(0, 400);
  if (q.length === 0) return { ok: false, error: 'empty query' };
  const env = serverEnv();
  const timeoutMs = Math.min(opts.timeoutMs ?? PROVIDER_TIMEOUT_MS, PROVIDER_TIMEOUT_MS);
  const ctxKey = env.CONTEXT_DEV_API_KEY;
  const fcKey = env.FIRECRAWL_API_KEY;
  if (!ctxKey && !fcKey) return { ok: false, error: 'Web search is not set up on the server (no CONTEXT_DEV_API_KEY or FIRECRAWL_API_KEY).' };
  if (ctxKey) {
    const r = await postJson('https://api.context.dev/v1/web/search', ctxKey, { query: q, numResults: 6 }, timeoutMs, opts.signal);
    const results = r.ok && isRecord(r.json) ? hits(r.json.results) : [];
    if (results.length > 0) return { ok: true, provider: 'context.dev', results };
    if (r.status > 0) console.warn('[web] context.dev search', r.status);
  }
  if (fcKey) {
    const r = await postJson('https://api.firecrawl.dev/v2/search', fcKey, { query: q, limit: 6, timeout: timeoutMs }, timeoutMs, opts.signal);
    const data = r.ok && isRecord(r.json) && isRecord(r.json.data) ? r.json.data : null;
    const results = data !== null ? hits(data.web) : [];
    if (results.length > 0) return { ok: true, provider: 'firecrawl', results };
    if (r.status > 0) console.warn('[web] firecrawl search', r.status);
  }
  return { ok: false, error: 'The search found nothing or the search service did not answer.' };
}

export async function readPage(url: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PageResult> {
  const safe = safeUrl(url);
  if (safe === null) return { ok: false, error: 'That is not a public web address.' };
  const env = serverEnv();
  const timeoutMs = Math.min(opts.timeoutMs ?? PROVIDER_TIMEOUT_MS, PROVIDER_TIMEOUT_MS);
  const ctxKey = env.CONTEXT_DEV_API_KEY;
  const fcKey = env.FIRECRAWL_API_KEY;
  if (!ctxKey && !fcKey) return { ok: false, error: 'Reading web pages is not set up on the server (no FIRECRAWL_API_KEY or CONTEXT_DEV_API_KEY).' };
  if (fcKey) {
    const r = await postJson(
      'https://api.firecrawl.dev/v2/scrape',
      fcKey,
      { url: safe, formats: ['markdown'], onlyMainContent: true, timeout: Math.max(1000, timeoutMs - 500) },
      timeoutMs,
      opts.signal,
    );
    const data = r.ok && isRecord(r.json) && isRecord(r.json.data) ? r.json.data : null;
    const md = data !== null ? str(data.markdown, MAX_PAGE_CHARS) : '';
    if (md.trim().length > 0) {
      const meta = data !== null && isRecord(data.metadata) ? data.metadata : {};
      return { ok: true, provider: 'firecrawl', url: safeUrl(meta.url) ?? safe, title: str(meta.title, 200), markdown: md };
    }
    if (r.status > 0) console.warn('[web] firecrawl scrape', r.status);
  }
  if (ctxKey) {
    const r = await postJson('https://api.context.dev/v1/web/scrape', ctxKey, { url: safe, formats: { markdown: true } }, timeoutMs, opts.signal);
    const j = r.ok && isRecord(r.json) ? r.json : null;
    const mdObj = j !== null && isRecord(j.markdown) ? j.markdown : null;
    const md = mdObj !== null && mdObj.success !== false ? str(mdObj.data, MAX_PAGE_CHARS) : '';
    if (md.trim().length > 0) {
      const meta = j !== null && isRecord(j.metadata) ? j.metadata : {};
      return { ok: true, provider: 'context.dev', url: safeUrl(j?.url) ?? safeUrl(meta.finalUrl) ?? safe, title: str(meta.title, 200), markdown: md };
    }
    if (r.status > 0) console.warn('[web] context.dev scrape', r.status);
  }
  return { ok: false, error: 'I could not read that page.' };
}

/**
 * The part of a page the model reads: up to MODEL_PAGE_CHARS, starting at the
 * first match of `find` (case-insensitive) when given, so the model can jump
 * to "CHAPTER III" in a whole-book page.
 */
export function pageWindow(markdown: string, find?: string | null, size = MODEL_PAGE_CHARS): { text: string; offset: number; total: number } {
  let start = 0;
  if (typeof find === 'string' && find.trim().length > 0) {
    const i = markdown.toLowerCase().indexOf(find.trim().toLowerCase());
    if (i >= 0) start = Math.max(0, i - 200);
  }
  return { text: markdown.slice(start, start + size), offset: start, total: markdown.length };
}

/**
 * Cut a chapter out of a page: from the first match of `from` to the first
 * match of `to` after it (both case-insensitive, both optional), capped.
 */
export function sliceBetween(markdown: string, from: string | null | undefined, to: string | null | undefined, cap: number): string {
  const lower = markdown.toLowerCase();
  let start = 0;
  if (typeof from === 'string' && from.trim().length > 0) {
    const i = lower.indexOf(from.trim().toLowerCase());
    if (i >= 0) start = i;
  }
  let end = markdown.length;
  if (typeof to === 'string' && to.trim().length > 0) {
    const fromLen = typeof from === 'string' ? from.trim().length : 0;
    const j = lower.indexOf(to.trim().toLowerCase(), start + Math.max(1, fromLen));
    if (j > start) end = j;
  }
  return markdown.slice(start, Math.min(end, start + cap));
}
