/**
 * PR 10: finishing a quest with your hand (pure detection, no IWSDK imports).
 *
 *  - Crumple: hold the card (pinch), then close the hand into a fist and keep
 *    it closed a moment. With a controller: hold the card and squeeze both
 *    the trigger and the grip.
 *  - Two-hand squeeze: hold the card with one hand and bring the other hand
 *    onto it, then press the hands together (off in one-handed mode).
 *  - Flick: let go of the card while the hand is moving fast and away from
 *    you, after a real throw (enough distance, still fast at the release).
 *
 * Ordinary moves must never complete a card, so the thresholds are tuned
 * against a placing hand: a hand drop over a surface always pins instead,
 * a pinch-ray drag is mostly wrist rotation (the hand barely translates),
 * and a careful carry is far below the flick speed.
 */

/** Average curl ratio (tip-to-wrist over knuckle-to-wrist, middle/ring/pinky) under this is a fist. */
export const FIST_RATIO = 1.32;
/** ...and over this the hand is open again (hysteresis). */
export const OPEN_RATIO = 1.5;
/** The fist must be held this long while holding the card. */
export const FIST_HOLD_MS = 220;

export type Vec = readonly [number, number, number];
const sub = (a: Vec, b: Vec): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec): number => Math.hypot(a[0], a[1], a[2]);
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * How curled the three outer fingers are: mean of |tip - wrist| / |proximal
 * knuckle - wrist| for middle, ring and pinky. ~1.9-2.1 open, ~1.0-1.25 fist.
 * Scale-free, so it works for any hand size.
 */
export function curlRatio(wrist: Vec, knuckles: readonly Vec[], tips: readonly Vec[]): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < Math.min(knuckles.length, tips.length); i += 1) {
    const k = len(sub(knuckles[i], wrist));
    if (k < 1e-4) continue;
    sum += len(sub(tips[i], wrist)) / k;
    n += 1;
  }
  return n === 0 ? Number.POSITIVE_INFINITY : sum / n;
}

/** Fist state with hysteresis. */
export function isFist(ratio: number, wasFist: boolean): boolean {
  return wasFist ? ratio < OPEN_RATIO : ratio < FIST_RATIO;
}

// ------------------------------------------------------------------ flick

export type Sample = { t: number; p: Vec };

export const FLICK = {
  /** Hand speed over the last segment before the release (m/s). */
  releaseSpeed: 1.25,
  /** Peak speed within the window (m/s). */
  peakSpeed: 1.5,
  /** The release segment must still be this fraction of the peak (no stop-then-release). */
  keepFraction: 0.55,
  /** Hand travel within the window (m). */
  minTravel: 0.16,
  /** Window before the release (ms). */
  windowMs: 320,
  /** Held at least this long (ms): a grab-and-throw, not a slip. */
  minHoldMs: 250,
  /** Velocity must not point back at the head: cos(angle to "away from head") above this. */
  minAwayCos: -0.2,
} as const;

export type FlickRule = { [K in keyof typeof FLICK]: number };

/**
 * PR 13: a ray / trigger drag (the emulator's left click) is judged on the CARD's own motion, not the hand's,
 * and must be a deliberate flick: a short, fast swing still going at full speed when you let go. An ordinary
 * drag-and-release (well under 1.5 m/s at the card) just moves the card. Any direction counts: a flicked
 * card always arcs into the trash can.
 */
export const RAY_FLICK: FlickRule = {
  releaseSpeed: 2.5,
  peakSpeed: 3.0,
  keepFraction: 0.6,
  minTravel: 0.25,
  windowMs: 200,
  minHoldMs: 250,
  minAwayCos: -1.01,
};

export type FlickVerdict = {
  flick: boolean;
  reason: string;
  releaseSpeed: number;
  peakSpeed: number;
  travel: number;
  awayCos: number;
};

/**
 * Decide whether a release was a flick. `samples` are the holding hand's
 * positions (oldest first, timestamps in ms); `head` is the eye position at
 * release; `heldMs` how long the card was held; `overSurface` true when the
 * release would pin the card to a surface (pinning always wins).
 */
export function flickVerdict(samples: readonly Sample[], head: Vec, heldMs: number, overSurface: boolean, rule: FlickRule = FLICK): FlickVerdict {
  const out: FlickVerdict = { flick: false, reason: '', releaseSpeed: 0, peakSpeed: 0, travel: 0, awayCos: 0 };
  if (samples.length < 2) return { ...out, reason: 'few-samples' };
  const end = samples[samples.length - 1];
  const win = samples.filter((s) => end.t - s.t <= rule.windowMs);
  if (win.length < 2) {
    // A slow frame: keep the last two samples so a single long segment still counts.
    win.splice(0, win.length, samples[samples.length - 2], end);
  }
  let peak = 0;
  let travel = 0;
  for (let i = 1; i < win.length; i += 1) {
    const dt = (win[i].t - win[i - 1].t) / 1000;
    const d = len(sub(win[i].p, win[i - 1].p));
    travel += d;
    if (dt > 1e-4) peak = Math.max(peak, d / dt);
  }
  const a = win[win.length - 2];
  const dtLast = Math.max(1e-4, (end.t - a.t) / 1000);
  const vLast = sub(end.p, a.p);
  const releaseSpeed = len(vLast) / dtLast;
  const away = sub(end.p, head);
  away[1] = 0;
  const awayLen = len(away);
  const awayCos = awayLen > 1e-4 && len(vLast) > 1e-6 ? dot(vLast, away) / (awayLen * len(vLast)) : 1;
  Object.assign(out, { releaseSpeed, peakSpeed: peak, travel, awayCos });
  if (overSurface) return { ...out, reason: 'over-surface' };
  if (heldMs < rule.minHoldMs) return { ...out, reason: 'short-hold' };
  if (peak < rule.peakSpeed) return { ...out, reason: 'slow' };
  if (releaseSpeed < rule.releaseSpeed || releaseSpeed < peak * rule.keepFraction) return { ...out, reason: 'stopped' };
  if (travel < rule.minTravel) return { ...out, reason: 'short' };
  if (awayCos < rule.minAwayCos) return { ...out, reason: 'toward-you' };
  return { ...out, flick: true, reason: 'flick' };
}

// ------------------------------------------------------------------ two hands

/** Two-hand squeeze: both hands on the card and their distance shrank by this fraction quickly. */
export const SQUEEZE = { onCardM: 0.14, shrink: 0.4, windowMs: 600, closeM: 0.09 } as const;

/**
 * `gaps` = distance between the two hands over time (oldest first), while
 * both are within `SQUEEZE.onCardM` of the card. A squeeze is a quick close
 * to under `closeM` that shrank at least `shrink` of the starting gap.
 */
export function isTwoHandSqueeze(gaps: readonly { t: number; d: number }[]): boolean {
  if (gaps.length < 2) return false;
  const end = gaps[gaps.length - 1];
  if (end.d > SQUEEZE.closeM) return false;
  let start = end.d;
  for (const g of gaps) if (end.t - g.t <= SQUEEZE.windowMs) start = Math.max(start, g.d);
  return start > 1e-4 && (start - end.d) / start >= SQUEEZE.shrink;
}

// ------------------------------------------------------------------ the paper ball's arc

/** A point on the paper ball's arc from `a` to `b` at t (0..1): a parabola peaking `lift` metres above the higher end. */
export function arcPoint(a: Vec, b: Vec, t: number, lift = 0.35): [number, number, number] {
  const k = Math.max(0, Math.min(1, t));
  const top = Math.max(a[1], b[1]) + lift;
  // Quadratic Bezier through a control point above the middle.
  const c: Vec = [(a[0] + b[0]) / 2, 2 * top - (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const u = 1 - k;
  return [
    u * u * a[0] + 2 * u * k * c[0] + k * k * b[0],
    u * u * a[1] + 2 * u * k * c[1] + k * k * b[1],
    u * u * a[2] + 2 * u * k * c[2] + k * k * b[2],
  ];
}
