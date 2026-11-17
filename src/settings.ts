/**
 * Accessibility settings (PR 10), saved in localStorage. Pure module: no
 * IWSDK imports, so the harness unit-tests it and every system can read it.
 *
 *  - seated:       everything new opens within arm's reach (cards, documents,
 *                  panels); the stand-up reminder keeps its own threshold.
 *  - largeText:    bigger card titles, document text and buddy captions.
 *  - highContrast: black cards with white text and a bright edge.
 *  - reducedMotion: no flame bounce, no sparkle, card moves become fades.
 *  - oneHanded:    no two-hand-only gestures (the two-hand squeeze is off);
 *                  every action already works with one pinch.
 *  - captions:     buddy speech captions always on (they stay up longer and
 *                  also show while the home panel is open).
 *  - calmScene:    (PR 11) during focus the room fades into a calm desk scene
 *                  (on, the default) or only frosts over (off).
 *  - muteSounds:   (PR 11) no chime, level-up or buddy cue sounds; the buddy's
 *                  talk-mode voice still plays.
 */

export type Settings = {
  seated: boolean;
  largeText: boolean;
  highContrast: boolean;
  reducedMotion: boolean;
  oneHanded: boolean;
  captions: boolean;
  calmScene: boolean;
  muteSounds: boolean;
};

export type SettingKey = keyof Settings;
export const SETTING_KEYS: readonly SettingKey[] = ['seated', 'largeText', 'highContrast', 'reducedMotion', 'oneHanded', 'captions', 'calmScene', 'muteSounds'];
export const SETTING_LABELS: Record<SettingKey, string> = {
  seated: 'Seated mode',
  largeText: 'Larger text',
  highContrast: 'High-contrast cards',
  reducedMotion: 'Reduced motion',
  oneHanded: 'One-handed mode',
  captions: 'Captions always on',
  calmScene: 'Calm scene in focus',
  muteSounds: 'Mute sound effects',
};

export const SETTINGS_KEY = 'questty.settings.v1';
export const DEFAULT_SETTINGS: Settings = {
  seated: false,
  largeText: false,
  highContrast: false,
  reducedMotion: false,
  oneHanded: false,
  captions: false,
  calmScene: true,
  muteSounds: false,
};

/** Parse a saved value; unknown keys are dropped, missing ones take the default. */
export function parseSettings(raw: string | null): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (raw === null) return out;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value !== 'object' || value === null) return out;
    for (const key of SETTING_KEYS) {
      if (typeof value[key] === 'boolean') out[key] = value[key] as boolean;
    }
  } catch {
    // corrupt: defaults
  }
  return out;
}

function load(): Settings {
  try {
    return typeof localStorage === 'undefined' ? { ...DEFAULT_SETTINGS } : parseSettings(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let current: Settings = load();
const listeners = new Set<(s: Settings, changed: SettingKey | null) => void>();

export function getSettings(): Readonly<Settings> {
  return current;
}

export function setSetting(key: SettingKey, value: boolean): Settings {
  if (current[key] === value) return current;
  current = { ...current, [key]: value };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(current));
  } catch {
    // storage off: in memory only
  }
  for (const l of listeners) {
    try {
      l(current, key);
    } catch (error) {
      console.warn('[settings] listener failed', error);
    }
  }
  return current;
}

export function toggleSetting(key: SettingKey): Settings {
  return setSetting(key, !current[key]);
}

/** Listen for changes (returns the unsubscribe). */
export function onSettings(listener: (s: Settings, changed: SettingKey | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Seated mode: the farthest new UI may open from the eyes (metres). */
export const SEATED_REACH_M = 0.6;
/** Card arc radii (card-layout.ts): normal and within arm's reach when seated. */
export const ARC_RADII = [0.58, 0.72, 0.86] as const;
export const SEATED_ARC_RADII = [0.48, 0.55, 0.62] as const;
export function arcRadii(s: Readonly<Settings> = current): readonly number[] {
  return s.seated ? SEATED_ARC_RADII : ARC_RADII;
}
