/**
 * PR 10: documents the buddy can open in the focused reading view.
 * Pure (no IWSDK imports): the parser, validator and harness use it directly.
 *
 * Three sources:
 *  - bundled samples under public/docs (the project brief, an essay draft, a
 *    reading list), fetched on open;
 *  - a card's notes (a brain dump keeps the words it came from);
 *  - text the buddy writes (an outline or a draft; mocked offline), kept in
 *    localStorage so it can be opened again.
 *
 * Reading positions (per document) and the open document live in
 * localStorage too, so a reload comes back to the same line.
 */

export type DocSource = 'sample' | 'buddy' | 'card';
export type DocMeta = { id: string; title: string; source: DocSource };
export type SampleDoc = DocMeta & { file: string; aliases: string[] };

export const SAMPLE_DOCS: readonly SampleDoc[] = [
  { id: 'doc-project-brief', title: 'Project brief', source: 'sample', file: 'project-brief.md', aliases: ['project brief', 'brief', 'the brief', 'project'] },
  { id: 'doc-essay', title: 'My essay', source: 'sample', file: 'essay.md', aliases: ['essay', 'my essay', 'essay draft', 'draft'] },
  { id: 'doc-reading-list', title: 'Reading list', source: 'sample', file: 'reading-list.md', aliases: ['reading list', 'books', 'my reading list'] },
];

export const DOCS_KEY = 'questty.docs.v1';
export const NOTES_KEY = 'questty.notes.v1';
export const DOC_VIEW_KEY = 'questty.docview.v1';
export const MAX_BODY = 6000;
export const MAX_DOC_TITLE = 60;
const MAX_GENERATED = 12;
const MAX_NOTES = 80;

export type GeneratedDoc = { id: string; title: string; body: string; at: number };

function read<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage off
  }
}

/** Clean model or user text for a document body: plain text/markdown, no control chars, capped. */
export function cleanBody(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '').replace(/[\u2014\u2013]/gu, '-').trim();
  if (text.length === 0) return null;
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 3)}...` : text;
}

export function cleanDocTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (t.length === 0) return null;
  return t.length > MAX_DOC_TITLE ? t.slice(0, MAX_DOC_TITLE) : t;
}

// ------------------------------------------------------------ buddy-written docs

export function generatedDocs(): GeneratedDoc[] {
  const list = read<unknown>(DOCS_KEY, []);
  if (!Array.isArray(list)) return [];
  return list.filter(
    (d): d is GeneratedDoc =>
      typeof d === 'object' && d !== null && typeof d.id === 'string' && typeof d.title === 'string' && typeof d.body === 'string',
  );
}

/** Save a document the buddy wrote; returns its id. Same title replaces the older one. */
export function saveGeneratedDoc(title: string, body: string, now = Date.now()): GeneratedDoc {
  const list = generatedDocs().filter((d) => d.title.toLowerCase() !== title.toLowerCase());
  const doc: GeneratedDoc = { id: `doc-g-${now.toString(36)}`, title, body, at: now };
  list.unshift(doc);
  write(DOCS_KEY, list.slice(0, MAX_GENERATED));
  return doc;
}

export function removeGeneratedDoc(id: string): void {
  write(DOCS_KEY, generatedDocs().filter((d) => d.id !== id));
}

// ------------------------------------------------------------ card notes

export function allNotes(): Record<string, string> {
  const v = read<unknown>(NOTES_KEY, {});
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, string>) : {};
}
export function cardNote(cardId: string): string | null {
  const n = allNotes()[cardId];
  return typeof n === 'string' && n.length > 0 ? n : null;
}
export function setCardNote(cardId: string, text: string): void {
  const body = cleanBody(text);
  if (body === null) return;
  const notes = allNotes();
  notes[cardId] = body;
  const keys = Object.keys(notes);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_NOTES))) delete notes[k];
  write(NOTES_KEY, notes);
}

/** Every document the buddy can name right now (samples, written docs; card notes are opened by card). */
export function knownDocs(): DocMeta[] {
  return [
    ...SAMPLE_DOCS.map(({ id, title, source }) => ({ id, title, source })),
    ...generatedDocs().map((d) => ({ id: d.id, title: d.title, source: 'buddy' as const })),
  ];
}
export function isKnownDocId(id: unknown): id is string {
  return typeof id === 'string' && knownDocs().some((d) => d.id === id);
}

// ------------------------------------------------------------ matching words to a document

const STOP = new Set(['the', 'my', 'a', 'an', 'up', 'please', 'doc', 'document', 'file', 'for', 'me', 'on', 'of', 'to', 'this', 'that']);
const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s']/gu, ' ')
    .split(/\s+/u)
    .filter((w) => w.length > 0 && !STOP.has(w));

/** The known document the words name best (title or alias), or null. */
export function matchDoc(words: string): DocMeta | null {
  const want = tokens(words);
  if (want.length === 0) return null;
  let best: { doc: DocMeta; score: number } | null = null;
  const consider = (doc: DocMeta, names: string[]) => {
    for (const name of names) {
      const have = tokens(name);
      if (have.length === 0) continue;
      const hit = want.filter((w) => have.some((h) => h === w || (w.length > 3 && h.startsWith(w)) || (h.length > 3 && w.startsWith(h)))).length;
      const score = hit / Math.max(want.length, have.length);
      if (hit > 0 && (best === null || score > best.score)) best = { doc, score };
    }
  };
  for (const s of SAMPLE_DOCS) consider(s, [s.title, ...s.aliases]);
  for (const g of generatedDocs()) consider({ id: g.id, title: g.title, source: 'buddy' }, [g.title]);
  const found = best as { doc: DocMeta; score: number } | null;
  return found !== null && found.score >= 0.5 ? found.doc : null;
}

/** Does this sound like a document at all ("my essay", "the brief", "notes")? Used by the router. */
export function soundsLikeDoc(words: string): boolean {
  return matchDoc(words) !== null || /\b(doc|docs|document|notes?|essay|brief|outline|draft|reading list|article|readme)\b/iu.test(words);
}

// ------------------------------------------------------------ the buddy's offline writer (mock)

/**
 * "Write an outline for my talk": without the AI, the buddy drafts a plain
 * outline from the topic. It never pretends to know facts it doesn't.
 */
export function draftOutline(topic: string): { title: string; body: string } {
  const t = cleanDocTitle(topic.replace(/^(an?|the|my)\s+/iu, '')) ?? 'Notes';
  const title = `Outline: ${t.charAt(0).toUpperCase()}${t.slice(1)}`.slice(0, MAX_DOC_TITLE);
  const body = [
    `# ${title}`,
    '',
    '## 1. Why it matters',
    `- One sentence on what ${t} is for`,
    '- Who it helps, and what changes for them',
    '',
    '## 2. The main points',
    '- Point one, with one example',
    '- Point two, with one example',
    '- Point three, with one example',
    '',
    '## 3. What could go wrong',
    '- The biggest risk, and the plan if it happens',
    '',
    '## 4. Next steps',
    '1. Write the first paragraph',
    '2. Find one source for each point',
    '3. Read it out loud once',
  ].join('\n');
  return { title, body };
}

// ------------------------------------------------------------ markdown -> blocks

export type Block = { kind: 'h1' | 'h2' | 'p' | 'li' | 'oli' | 'gap'; text: string; marker?: string };

/** A small markdown subset: # / ## headings, - * bullets, 1. lists, paragraphs; **bold** and `code` lose their marks. */
export function parseMarkdown(body: string): Block[] {
  const out: Block[] = [];
  const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/gu, '$1').replace(/__(.+?)__/gu, '$1').replace(/`([^`]+)`/gu, '$1').replace(/\[(.+?)\]\((.+?)\)/gu, '$1').trim();
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) out.push({ kind: 'p', text: plain(para.join(' ')) });
    para = [];
  };
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (t.length === 0) {
      flush();
      if (out.length > 0 && out[out.length - 1].kind !== 'gap') out.push({ kind: 'gap', text: '' });
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^#\s+(.+)$/u.exec(t)) !== null) {
      flush();
      out.push({ kind: 'h1', text: plain(m[1]) });
    } else if ((m = /^#{2,6}\s+(.+)$/u.exec(t)) !== null) {
      flush();
      out.push({ kind: 'h2', text: plain(m[1]) });
    } else if ((m = /^[-*+]\s+(.+)$/u.exec(t)) !== null) {
      flush();
      out.push({ kind: 'li', text: plain(m[1]), marker: '\u2022' });
    } else if ((m = /^(\d{1,3})[.)]\s+(.+)$/u.exec(t)) !== null) {
      flush();
      out.push({ kind: 'oli', text: plain(m[2]), marker: `${m[1]}.` });
    } else para.push(t);
  }
  flush();
  while (out.length > 0 && out[out.length - 1].kind === 'gap') out.pop();
  return out;
}

/** Word-wrap one string to `maxWidth` with a measuring function (canvas measureText in the app). */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const words = text.split(/\s+/u).filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line.length === 0 ? word : `${line} ${word}`;
    if (measure(next) <= maxWidth || line.length === 0) {
      // A single word wider than the line is cut hard.
      if (line.length === 0 && measure(word) > maxWidth) {
        let cut = word;
        while (cut.length > 1 && measure(`${cut}-`) > maxWidth) cut = cut.slice(0, -1);
        lines.push(`${cut}-`);
        line = word.slice(cut.length);
        continue;
      }
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/** Rough reading time for the reply ("3 min read"). */
export function readMinutes(body: string): number {
  return Math.max(1, Math.round(body.split(/\s+/u).length / 200));
}

// ------------------------------------------------------------ the view's saved state

export type SavedPose = { p: [number, number, number]; q: [number, number, number, number]; surfaceId?: string; kind?: string };
export type DocViewSaved = {
  open: { id: string; title: string; source: DocSource; cardId?: string } | null;
  /** Reading position per document, in canvas pixels from the top. */
  scroll: Record<string, number>;
  pose: SavedPose | null;
};

export function loadDocView(): DocViewSaved {
  const v = read<Partial<DocViewSaved> | null>(DOC_VIEW_KEY, null);
  const scroll: Record<string, number> = {};
  if (v !== null && typeof v.scroll === 'object' && v.scroll !== null) {
    for (const [k, n] of Object.entries(v.scroll)) if (typeof n === 'number' && Number.isFinite(n) && n >= 0) scroll[k] = n;
  }
  const open = v?.open;
  const pose = v?.pose;
  return {
    open: open && typeof open.id === 'string' && typeof open.title === 'string' ? open : null,
    scroll,
    pose: pose && Array.isArray(pose.p) && pose.p.length === 3 && Array.isArray(pose.q) && pose.q.length === 4 ? pose : null,
  };
}
export function saveDocView(v: DocViewSaved): void {
  write(DOC_VIEW_KEY, v);
}
