/**
 * PR 10: the accessibility settings panel, card styling for the settings
 * (larger text, high contrast) and the tier-up moment for card frames.
 *
 * The panel opens from the home panel's "Aa" button, beside it and within
 * arm's reach; every row is a single pinch (ray or poke) and is saved at once
 * (settings.ts). One-handed and reduced-motion are read by the systems they
 * affect (physical-finish, flame, surfaces, quest-card, doc-view, ritual).
 */
import {
  createSystem,
  Matrix4,
  PokeInteractable,
  Quaternion,
  RayInteractable,
  UIKit,
  UIKitMLAsset,
  Vector3,
  type Entity,
} from '@iwsdk/core';
import { QuestCard } from './quest-component.js';
import { onCardEvent } from './quest-card.js';
import { getSettings, onSettings, SEATED_REACH_M, SETTING_KEYS, setSetting, toggleSetting, type SettingKey } from './settings.js';
import { getProgress, onAward, saveProgress } from './progress.js';
import { levelsToNext, tierForLevel, tierUp, TIERS } from './tiers.js';
import { flashFrames, frameState } from './card-decor.js';
import { announce, announceLog } from './announce.js';
import { playChime } from './focus-store.js';

const SCALE = 0.1;
const ANGLE_DEG = -28; // to the user's left, between the home panel and the middle
const DISTANCE = 0.62;
const DROP = 0.28;
const ID: Record<SettingKey, string> = {
  seated: 'seated',
  largeText: 'large-text',
  highContrast: 'high-contrast',
  reducedMotion: 'reduced-motion',
  oneHanded: 'one-handed',
  captions: 'captions',
};

/** Card text and colours for the current settings (also re-applied to every card when they change). */
export function styleCard(card: Entity): void {
  const panel = card.object3D;
  if (!(panel instanceof UIKitMLAsset)) return;
  const s = getSettings();
  const hc = s.highContrast;
  panel.getElementById<UIKit.Text>('quest-title')?.setProperties({ fontSize: s.largeText ? 52 : 42, color: hc ? '#ffffff' : '#fbfaf5' } as never);
  panel.getElementById<UIKit.Text>('quest-card-state')?.setProperties({ fontSize: s.largeText ? 18 : 14, color: hc ? '#ffffff' : '#b9bcc2' } as never);
  panel.getElementById<UIKit.Text>('quest-xp')?.setProperties({ fontSize: s.largeText ? 24 : 20, color: hc ? '#000000' : '#33280e' } as never);
  const root = panel.getElementById<UIKit.Text>('quest-card-root');
  if (hc) root?.setProperties({ backgroundColor: '#000000', backgroundOpacity: 1, borderColor: '#ffffff', borderWidth: 3 } as never);
  else root?.setProperties({ backgroundColor: undefined, borderColor: undefined, borderWidth: 0 } as never);
}

export class SettingsSystem extends createSystem({
  cards: { required: [QuestCard] },
}) {
  private panel: UIKitMLAsset | undefined;
  private entity: Entity | undefined;
  private loading: Promise<void> | null = null;
  private open = false;
  private readonly head = new Vector3();
  private readonly fwd = new Vector3();
  private readonly m = new Matrix4();
  private readonly tierLog: Array<{ at: number; from: string; to: string; level: number }> = [];

  init(): void {
    const home = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    const button = home?.getElementById('panel-settings');
    const onButton = () => void this.toggle();
    button?.addEventListener('click', onButton);
    this.cleanupFuncs.push(
      () => button?.removeEventListener('click', onButton),
      onCardEvent((type, card) => {
        if (type === 'created') styleCard(card);
      }),
      onSettings((_s, changed) => {
        if (changed === 'largeText' || changed === 'highContrast') for (const c of this.queries.cards.entities) styleCard(c);
        this.refreshRows();
      }),
      onAward((event) => {
        const up = tierUp(event.levelBefore, event.progress.level);
        if (up === null) return;
        this.tierLog.push({ at: Date.now(), from: tierForLevel(event.levelBefore).id, to: up.id, level: event.progress.level });
        flashFrames();
        // After the completion's own line, so both are seen.
        window.setTimeout(() => {
          playChime();
          const next = levelsToNext(event.progress.level);
          announce(`Level ${event.progress.level}! Your cards are ${up.label} now.${next ? ` ${next.levels} more levels to ${next.next.label}.` : ''}`, {
            tag: 'QUESTTY  ·  LEVEL UP',
            ms: 5000,
          });
        }, 1800);
      }),
    );
    if (import.meta.env.DEV) {
      const w = window as unknown as { __questty?: Record<string, unknown> };
      w.__questty = {
        ...w.__questty,
        settings: {
          get: () => ({ ...getSettings() }),
          set: (key: SettingKey, value: boolean) => setSetting(key, value),
          open: () => this.toggle(true),
          close: () => this.toggle(false),
          isOpen: () => this.open && (this.panel?.visible ?? false),
          panelAt: () => this.panel?.position.toArray() ?? null,
          rows: () => this.rowState(),
        },
        announce: () => announceLog(),
        tiers: {
          state: () => ({ ...frameState(), level: getProgress().level, xp: getProgress().xp, log: [...this.tierLog] }),
          list: () => TIERS.map((t) => ({ id: t.id, minLevel: t.minLevel })),
          setXp: (xp: number) => {
            const p = getProgress();
            saveProgress({ ...p, xp, level: Math.floor(xp / 100) + 1 });
            return frameState();
          },
        },
      };
    }
  }

  private async toggle(want = !this.open): Promise<void> {
    this.open = want;
    if (want) await this.ensurePanel();
    const panel = this.panel;
    if (panel === undefined) return;
    if (want) {
      this.place();
      this.refreshRows();
    }
    panel.visible = want;
    if (!want) panel.position.set(0, -50, 0); // out of every pointer's way while hidden
  }

  private ensurePanel(): Promise<void> {
    this.loading ??= (async () => {
      const panel = await this.world.assets.instantiate<UIKitMLAsset>('settings');
      panel.name = 'Settings Panel';
      panel.scale.setScalar(SCALE);
      panel.visible = false;
      panel.position.set(0, -50, 0);
      this.panel = panel;
      this.entity = this.world.createTransformEntity(panel, { parent: this.world.sceneEntity, persistent: true });
      this.entity.object3D!.name = 'Settings Panel';
      this.entity.addComponent(RayInteractable);
      this.entity.addComponent(PokeInteractable);
      panel.requireElementById('settings-close').addEventListener('click', () => void this.toggle(false));
      for (const key of SETTING_KEYS) {
        panel.requireElementById(`set-${ID[key]}`).addEventListener('click', () => toggleSetting(key));
      }
    })();
    return this.loading;
  }

  private place(): void {
    const panel = this.panel;
    if (panel === undefined) return;
    const h = this.world.player.head;
    h.updateWorldMatrix(true, false);
    h.getWorldPosition(this.head);
    h.getWorldDirection(this.fwd).negate();
    this.fwd.y = 0;
    if (this.fwd.lengthSq() < 1e-4) this.fwd.set(0, 0, -1);
    this.fwd.normalize();
    const a = (ANGLE_DEG * Math.PI) / 180;
    const dir = new Vector3(this.fwd.x * Math.cos(a) - this.fwd.z * Math.sin(a), 0, this.fwd.x * Math.sin(a) + this.fwd.z * Math.cos(a));
    const dist = getSettings().seated ? Math.min(DISTANCE, SEATED_REACH_M - 0.04) : DISTANCE;
    const p = this.head.clone().addScaledVector(dir, dist);
    p.y = this.head.y - DROP;
    this.m.lookAt(this.head, p, new Vector3(0, 1, 0));
    panel.position.copy(p);
    panel.quaternion.copy(new Quaternion().setFromRotationMatrix(this.m));
  }

  private refreshRows(): void {
    const panel = this.panel;
    if (panel === undefined) return;
    const s = getSettings();
    for (const key of SETTING_KEYS) {
      const on = s[key];
      panel.getElementById<UIKit.Text>(`set-${ID[key]}-state`)?.setProperties({ text: on ? 'On' : 'Off', color: on ? '#1d1a08' : '#e6e7ea' } as never);
      panel.getElementById<UIKit.Text>(`set-${ID[key]}-pill`)?.setProperties({ backgroundColor: on ? '#f5d90a' : '#45484f' } as never);
    }
  }

  private rowState(): Record<string, string> {
    const out: Record<string, string> = {};
    const s = getSettings();
    for (const key of SETTING_KEYS) out[key] = s[key] ? 'On' : 'Off';
    return out;
  }
}
