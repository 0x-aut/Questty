/**
 * Card frame tiers by level (PR 10). Pure: no IWSDK imports.
 *
 * Level = floor(xp / 100) + 1 (progress.ts). The frame metal steps up with
 * the level: copper -> bronze -> silver -> gold -> diamond.
 */
export type TierId = 'copper' | 'bronze' | 'silver' | 'gold' | 'diamond';

export type TierDef = {
  id: TierId;
  label: string;
  /** First level of this tier. */
  minLevel: number;
  /** Base metal colour, the highlight colour of its sheen, and how strong the sheen is. */
  base: string;
  shine: string;
  sheen: number;
  /** Diamond only: glints. */
  sparkle: boolean;
};

export const TIERS: readonly TierDef[] = [
  { id: 'copper', label: 'Copper', minLevel: 1, base: '#9a5531', shine: '#f0a77a', sheen: 0.45, sparkle: false },
  { id: 'bronze', label: 'Bronze', minLevel: 3, base: '#8c6a2f', shine: '#e6c17a', sheen: 0.5, sparkle: false },
  { id: 'silver', label: 'Silver', minLevel: 6, base: '#8f959e', shine: '#f4f7fb', sheen: 0.6, sparkle: false },
  { id: 'gold', label: 'Gold', minLevel: 10, base: '#b8902c', shine: '#fff0b3', sheen: 0.65, sparkle: false },
  { id: 'diamond', label: 'Diamond', minLevel: 15, base: '#a9d6ec', shine: '#ffffff', sheen: 0.75, sparkle: true },
];

export function tierForLevel(level: number): TierDef {
  const l = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
  let out = TIERS[0];
  for (const t of TIERS) if (l >= t.minLevel) out = t;
  return out;
}

/** The tier a completion moved into, or null when the tier did not change. */
export function tierUp(levelBefore: number, levelAfter: number): TierDef | null {
  const a = tierForLevel(levelBefore);
  const b = tierForLevel(levelAfter);
  return TIERS.indexOf(b) > TIERS.indexOf(a) ? b : null;
}

/** Levels left to the next tier (null at diamond). */
export function levelsToNext(level: number): { next: TierDef; levels: number } | null {
  const i = TIERS.indexOf(tierForLevel(level));
  const next = TIERS[i + 1];
  return next === undefined ? null : { next, levels: next.minLevel - Math.max(1, Math.floor(level)) };
}
