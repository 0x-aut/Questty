/**
 * PR 11: the XP progress bar and the award sounds.
 *
 * The home panel (and its collapsed pill) carry a bar toward the next level.
 * Every XP award animates it (across level boundaries: fill to the end, start
 * the new level from empty) and plays exactly one sound: the chime, or the
 * level-up fanfare instead of it when the award crossed a level. An Undo or
 * any other saved change slides the bar straight to the new value. The bar is
 * drawn from the saved progress at start, so it is right after a reload.
 */
import { createSystem, UIKit, UIKitMLAsset } from '@iwsdk/core';
import { getProgress, onAward, onProgress, type AwardEvent } from './progress.js';
import { barLabel, barSegments, easeOut, segmentMs, xpBarView, type BarSegment } from './xp-bar.js';
import { chooseAwardSound } from './sfx-logic.js';
import { buddySpeechLog } from './buddy-speech.js';
import { playSound, recordBuddyOutput, renderSoundWav, soundLog, spatialState, type SoundKind } from './sfx.js';
import { getSettings } from './settings.js';

const FILL = '#f5b80a';
const FILL_FLASH = '#fff4c2';
const LEVEL_UP_LABEL_MS = 2200;
/** A full bar is held this long before it empties into the new level. */
const FULL_HOLD_MS = 350;
/**
 * Dev-only slow motion for the emulator harness and video (?xpSlow=4 makes the fill 4x slower; software GL
 * draws only a few frames a second).
 */
const SLOW = (() => {
  if (!import.meta.env.DEV) return 1;
  const raw = Number(new URLSearchParams(window.location.search).get('xpSlow'));
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
})();

type Anim = { segment: BarSegment; startedAt: number; ms: number; reset: boolean };

export class XpBarSystem extends createSystem({}) {
  private fills: UIKit.Text[] = [];
  private labels: UIKit.Text[] = [];
  private queue: BarSegment[] = [];
  private anim: Anim | null = null;
  private shown = 0;
  private shownLevel = 1;
  private lastWritten = -1;
  private targetXp = 0;
  private flashUntil = 0;
  private flashing = false;
  private labelHoldUntil = 0;
  /** Dev: the widths actually written while animating (frame by frame). */
  private readonly frames: Array<{ t: number; w: number; level: number }> = [];
  private readonly history: Array<{ at: number; from: number; to: number; segments: BarSegment[]; sound: string | null; levelUp: boolean }> = [];

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    for (const id of ['xp-fill', 'pill-xp-fill']) {
      const el = panel?.getElementById<UIKit.Text>(id);
      if (el != null) this.fills.push(el);
    }
    for (const id of ['xp-label', 'pill-xp-label']) {
      const el = panel?.getElementById<UIKit.Text>(id);
      if (el != null) this.labels.push(el);
    }
    const start = getProgress();
    this.targetXp = start.xp;
    const view = xpBarView(start.xp);
    this.shown = view.fraction;
    this.shownLevel = view.level;
    this.write(true);
    this.writeLabel(barLabel(view));

    this.cleanupFuncs.push(
      onAward((event) => this.onAwardEvent(event)),
      onProgress((p) => {
        // An award saves first, then fires onAward in the same call: let it claim the change.
        queueMicrotask(() => {
          if (p.xp !== this.targetXp) this.slideTo(p.xp);
        });
      }),
    );

    if (import.meta.env.DEV) {
      const w = window as unknown as { __questty?: Record<string, unknown> };
      w.__questty = {
        ...w.__questty,
        xpBar: {
          state: () => ({
            shown: this.shown,
            shownLevel: this.shownLevel,
            targetXp: this.targetXp,
            target: xpBarView(this.targetXp),
            animating: this.anim !== null || this.queue.length > 0,
            width: this.lastWritten,
            label: this.labels[0]?.properties?.peek?.()?.text ?? null,
            pillLabel: this.labels[1]?.properties?.peek?.()?.text ?? null,
            history: this.history.map((h) => ({ ...h, segments: h.segments.map((s) => ({ ...s })) })),
            frames: this.frames.map((f) => ({ ...f })),
          }),
          clearFrames: () => {
            this.frames.length = 0;
          },
        },
        sfx: {
          log: () => soundLog(),
          spatial: () => spatialState(),
          render: (kind: SoundKind) => renderSoundWav(kind),
          recordBuddy: (ms: number) => recordBuddyOutput(ms),
          play: (kind: 'chime' | 'levelup') => playSound(kind, 'dev'),
          speech: () => buddySpeechLog(),
        },
      };
    }
  }

  private onAwardEvent(event: AwardEvent): void {
    const to = event.progress.xp;
    const from = Math.max(0, to - event.base - event.bonusXp);
    const sound = chooseAwardSound(event.levelBefore, event.progress.level);
    playSound(sound, sound === 'levelup' ? `level ${event.progress.level}` : 'award');
    const segments = barSegments(from, to);
    this.history.push({ at: Date.now(), from, to, segments, sound, levelUp: sound === 'levelup' });
    if (this.history.length > 30) this.history.shift();
    this.targetXp = to;
    if (sound === 'levelup') this.labelHoldUntil = 0;
    this.enqueue(segments);
  }

  private slideTo(xp: number): void {
    const from = this.targetXp;
    this.targetXp = xp;
    const segments = barSegments(from, xp);
    this.history.push({ at: Date.now(), from, to: xp, segments, sound: null, levelUp: false });
    if (this.history.length > 30) this.history.shift();
    this.enqueue(segments);
  }

  private enqueue(segments: BarSegment[]): void {
    if (getSettings().reducedMotion) {
      // No sliding: jump to the result.
      this.queue = [];
      this.anim = null;
      const view = xpBarView(this.targetXp);
      const last = segments[segments.length - 1];
      if (last !== undefined && last.level > this.shownLevel) this.levelUpMoment(last.level);
      this.shown = view.fraction;
      this.shownLevel = view.level;
      this.write(true);
      if (performance.now() >= this.labelHoldUntil) this.writeLabel(barLabel(view));
      return;
    }
    // A new award while one plays: finish the queue from where the bar is now.
    this.queue.push(...segments);
    if (this.anim === null) this.next();
  }

  private next(): void {
    const segment = this.queue.shift();
    if (segment === undefined) {
      this.anim = null;
      if (performance.now() >= this.labelHoldUntil) this.writeLabel(barLabel(xpBarView(this.targetXp)));
      return;
    }
    const now = performance.now();
    if (segment.level > this.shownLevel) {
      // Crossed into a new level: the full bar flashes for a moment, then empties and fills the new level.
      this.levelUpMoment(segment.level);
      this.anim = { segment: { ...segment, from: 0 }, startedAt: now + FULL_HOLD_MS * SLOW, ms: segmentMs({ ...segment, from: 0 }) * SLOW, reset: true };
      return;
    }
    this.shownLevel = segment.level;
    const from = this.shown;
    this.anim = { segment: { ...segment, from }, startedAt: now, ms: segmentMs({ ...segment, from }) * SLOW, reset: false };
  }

  private levelUpMoment(level: number): void {
    this.flashUntil = performance.now() + 900 * SLOW;
    this.labelHoldUntil = performance.now() + LEVEL_UP_LABEL_MS * SLOW;
    this.writeLabel(`LEVEL UP!  Level ${level}`);
  }

  update(): void {
    const now = performance.now();
    if (this.flashing !== now < this.flashUntil) {
      this.flashing = now < this.flashUntil;
      for (const f of this.fills) f.setProperties({ backgroundColor: this.flashing ? FILL_FLASH : FILL } as never);
    }
    if (this.labelHoldUntil > 0 && now >= this.labelHoldUntil) {
      this.labelHoldUntil = 0;
      if (this.anim === null) this.writeLabel(barLabel(xpBarView(this.targetXp)));
    }
    const a = this.anim;
    if (a === null || now < a.startedAt) return;
    if (a.reset) {
      a.reset = false;
      this.shownLevel = a.segment.level;
      this.shown = 0;
      this.write(true);
    }
    const t = Math.min(1, (now - a.startedAt) / a.ms);
    this.shown = a.segment.from + (a.segment.to - a.segment.from) * easeOut(t);
    this.write(false);
    if (t >= 1) {
      this.shown = a.segment.to;
      this.write(true);
      this.next();
    }
  }

  /** Width in 0.1 % steps; only written when it changes. */
  private write(force: boolean): void {
    const pct = Math.round(Math.max(0, Math.min(1, this.shown)) * 1000) / 10;
    if (!force && pct === this.lastWritten) return;
    this.lastWritten = pct;
    for (const f of this.fills) f.setProperties({ width: `${pct}%` } as never);
    if (import.meta.env.DEV) {
      this.frames.push({ t: Math.round(performance.now()), w: pct, level: this.shownLevel });
      if (this.frames.length > 400) this.frames.shift();
    }
  }

  private writeLabel(text: string): void {
    for (const l of this.labels) l.setProperties({ text } as never);
  }
}
