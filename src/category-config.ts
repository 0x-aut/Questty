/**
 * Time categories: WHEN the user wants to do a card. This has nothing to do
 * with where the card is stuck (any card can go on any wall, desk or door).
 *
 * The one list of categories lives here so later features (the AI buddy) can
 * add their own with `registerCategory`. Accents are muted, paper-like tints
 * that sit well on the matte card face (no neon).
 */

export type CategoryId = string;

export type CategoryDef = {
  id: CategoryId;
  /** Shown on the chip and in the picker. */
  label: string;
  /** Short label for the pill counts. */
  short: string;
  /** Accent (hex) for the chip dot and the card's edge strip. */
  accent: string;
  builtin: boolean;
};

export const UNSORTED: CategoryId = 'unsorted';
export const TODAY: CategoryId = 'today';
export const LATER: CategoryId = 'later';
export const BEFORE_LEAVE: CategoryId = 'before-leave';

const BUILTIN: CategoryDef[] = [
  { id: TODAY, label: 'Today', short: 'Today', accent: '#c7784f', builtin: true },
  { id: LATER, label: 'Later', short: 'Later', accent: '#6f8fb3', builtin: true },
  { id: BEFORE_LEAVE, label: 'Before I leave', short: 'Before I leave', accent: '#7f9a62', builtin: true },
  { id: UNSORTED, label: 'Unsorted', short: 'Unsorted', accent: '#9a9488', builtin: true },
];

/** At most this many user/AI-named categories (the picker has one slot for now). */
export const MAX_CUSTOM = 1;
const CUSTOM_ACCENTS = ['#9a7fae', '#b08a5a'];
const CUSTOM_KEY = 'questty.categories.v1';

const custom: CategoryDef[] = loadCustom();

function loadCustom(): CategoryDef[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (c): c is { id: string; label: string } =>
          typeof c === 'object' &&
          c !== null &&
          typeof (c as { id?: unknown }).id === 'string' &&
          typeof (c as { label?: unknown }).label === 'string',
      )
      .slice(0, MAX_CUSTOM)
      .map((c, i) => customDef(c.id, c.label, i));
  } catch {
    return [];
  }
}

function customDef(id: string, label: string, index: number): CategoryDef {
  const clean = label.trim().slice(0, 24);
  return { id, label: clean, short: clean, accent: CUSTOM_ACCENTS[index % CUSTOM_ACCENTS.length], builtin: false };
}

/** Every category, built-ins first (Today, Later, Before I leave, Unsorted), then custom ones. */
export function listCategories(): CategoryDef[] {
  return [...BUILTIN, ...custom];
}

/** The three timing categories shown as counts on the panel pill. */
export function countedCategories(): CategoryDef[] {
  return listCategories().filter((c) => c.id !== UNSORTED);
}

export function getCategory(id: CategoryId): CategoryDef | undefined {
  return listCategories().find((c) => c.id === id);
}

export function isCategoryId(value: unknown): value is CategoryId {
  return typeof value === 'string' && getCategory(value) !== undefined;
}

/** A saved/unknown value as a category id (unknown or missing -> Unsorted). */
export function normalizeCategory(value: unknown): CategoryId {
  return isCategoryId(value) ? value : UNSORTED;
}

/**
 * Add a user-named category (one for now). Returns its id, or null when the
 * name is empty or the custom slot is taken by another name. Saved locally.
 */
export function registerCategory(label: string): CategoryId | null {
  const clean = label.trim().slice(0, 24);
  if (clean.length === 0) return null;
  const existing = listCategories().find((c) => c.label.toLowerCase() === clean.toLowerCase());
  if (existing !== undefined) return existing.id;
  if (custom.length >= MAX_CUSTOM) return null;
  const slug = clean.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'custom';
  const def = customDef(`custom-${slug}`, clean, custom.length);
  custom.push(def);
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom.map((c) => ({ id: c.id, label: c.label }))));
  } catch {
    // ignore
  }
  return def.id;
}

// ------------------------------------------------------------ phrase matching

const BEFORE_LEAVE_RE =
  /\b(before (i|we) (leave|go|head out|step out)|before leaving|before heading out|on (my|the) way out|when (i|we) (leave|head out))\b/iu;
const TODAY_RE = /\b(today|tonight|this (morning|afternoon|evening)|asap|right now|right away)\b/iu;
const LATER_RE =
  /\b(later( on| today)?|tomorrow|next (week|month)|this weekend|on the weekend|at some point|someday|some day|eventually)\b/iu;

/**
 * The timing a phrase implies, by simple phrase matching (no AI):
 * "before I leave" / "on my way out" -> Before I leave; "today", "tonight",
 * "this morning" -> Today; "later", "tomorrow", "next week" -> Later.
 * Returns null when the phrase says nothing about timing.
 */
export function inferCategory(text: string): CategoryId | null {
  if (BEFORE_LEAVE_RE.test(text)) return BEFORE_LEAVE;
  // "later today" is still later.
  if (/\blater today\b/iu.test(text)) return LATER;
  if (TODAY_RE.test(text)) return TODAY;
  if (LATER_RE.test(text)) return LATER;
  return null;
}

/** The phrase with its timing words taken out ("Buy milk before I leave" -> "Buy milk"). */
export function stripTiming(text: string): string {
  return text
    .replace(new RegExp(BEFORE_LEAVE_RE.source, 'giu'), ' ')
    .replace(/\blater today\b/giu, ' ')
    .replace(new RegExp(TODAY_RE.source, 'giu'), ' ')
    .replace(new RegExp(LATER_RE.source, 'giu'), ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[\s,.;:-]+|[\s,.;:-]+$/gu, '')
    .trim();
}

/** True when the phrase STARTS with a timing phrase (it then carries to the next items). */
export function startsWithTiming(text: string): boolean {
  const t = text.trim().replace(/^(ok(ay)?|so|and|then|also|um+|uh+)[\s,]+/iu, '');
  const m = [BEFORE_LEAVE_RE, /\blater today\b/iu, TODAY_RE, LATER_RE]
    .map((re) => re.exec(t))
    .filter((x): x is RegExpExecArray => x !== null);
  return m.some((x) => x.index === 0);
}
