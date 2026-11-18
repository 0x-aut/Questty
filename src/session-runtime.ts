import {
  BufferGeometry,
  CircleGeometry,
  Color,
  createSystem,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RingGeometry,
  UIKit,
  UIKitMLAsset,
  Vector3,
  type Entity,
} from '@iwsdk/core';
import { QuestCard } from './quest-component.js';
import { createTrashCan, TRASH_CAN_MOUTH } from './trash-can.js';
import {
  allowFloatingFocus,
  canFocusCard,
  findQuestCard,
  notifyCardFocused,
  createQuestCard,
  onCardEvent,
  type CardEventType,
  idleCardHint,
  setQuestCardState,
  showFocusActionFor,
  tweenQuestCardTo,
  crumpleQuestCard,
} from './quest-card.js';
import {
  setCardActionMode,
  setCardCompleter,
  setCardNudger,
  setFocusCommander,
  setBuddyFocusApi,
  setFocusStarter,
  type FocusCommand,
  type FocusSnapshot,
} from './session-events.js';
import {
  advanceBreak,
  completeFocus,
  endFocusEarly,
  extendFocus,
  focusExpired,
  focusRemainingMs,
  formatClock,
  IDLE_SESSION,
  pauseFocus,
  resumeFocus,
  skipBreak,
  startFocus,
  breakPromptById,
  canSkipBreak,
  nextBreakPrompt,
  type SessionState,
} from './session.js';
import { announce } from './announce.js';
import { playBuddyCue } from './sfx.js';
import { getSettings, onSettings } from './settings.js';
import { awardXp, getLastAward, getProgress, onProgress, revokeXp, type ProgressState } from './progress.js';
import { dayKey, viewStreak } from './streak.js';
import {
  BLUR_LEVELS,
  clearFocusTimer,
  focusNow,
  loadBlurLevel,
  loadFocusTimer,
  loadLastBreakPrompt,
  primeChime,
  saveLastBreakPrompt,
  saveBlurLevel,
  saveFocusTimer,
  type BlurLevel,
} from './focus-store.js';
import { createFocusShell, type FocusShell } from './focus-shell.js';
import { CARD_UNITS_H, CARD_UNITS_W } from './card-layout.js';
import { setCardWorldPose } from './surfaces.js';
import { preloadBuddyLine, speakBuddyLine } from './buddy-speech.js';

const FADE_MS = 1_000;
/** Dev-only slow motion for the calm fades (?fadeSlow=3), for the emulator harness: software GL draws few frames. */
const FADE_SLOW = (() => {
  if (!import.meta.env.DEV) return 1;
  const raw = Number(new URLSearchParams(window.location.search).get('fadeSlow'));
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
})();
const PAUSED_FADE_FACTOR = 0.4;
const BLUR_OPACITY: Record<BlurLevel, number> = { off: 0, soft: 0.6, strong: 0.9 };
/** PR 11: the calm scene replaces the room fully at Strong, nearly at Soft. */
const CALM_OPACITY: Record<BlurLevel, number> = { off: 0, soft: 0.9, strong: 1 };
const TIMER_RADIUS = 0.15;
const TIMER_SEGMENTS = 96;
/** Seated comfort: a little under arm's length from the eyes. */
const TIMER_DISTANCE = 0.85;
/** Timer elevation limits (radians): always a little below the eye line. */
const TIMER_MIN_ELEVATION = -0.44;
const TIMER_MAX_ELEVATION = -0.1;
const TIMER_MARGIN = 0.04;
const TIMER_TEXT_SCALE = 0.1;
const NOMINAL_HEAD = new Vector3(0, 1.3, 0);
const RING_RUNNING = new Color(0xf0d787);
const RING_PAUSED = new Color(0x9aa6ad);

type TimerDisk = {
  group: Group;
  ring: RingGeometry;
  ringMaterial: MeshBasicMaterial;
  geometries: BufferGeometry[];
  materials: MeshBasicMaterial[];
};

function createTimerDisk(): TimerDisk {
  const group = new Group();
  group.name = 'Focus Timer';
  const baseGeometry = new CircleGeometry(TIMER_RADIUS, 64);
  const trackGeometry = new RingGeometry(TIMER_RADIUS - 0.011, TIMER_RADIUS, TIMER_SEGMENTS, 1);
  const ring = new RingGeometry(TIMER_RADIUS - 0.011, TIMER_RADIUS, TIMER_SEGMENTS, 1);
  const baseMaterial = new MeshBasicMaterial({
    color: 0x0f1d26,
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
    side: DoubleSide,
  });
  const trackMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: DoubleSide,
  });
  const ringMaterial = new MeshBasicMaterial({
    color: RING_RUNNING.clone(),
    transparent: true,
    opacity: 0.98,
    depthWrite: false,
    side: DoubleSide,
  });
  const base = new Mesh(baseGeometry, baseMaterial);
  const track = new Mesh(trackGeometry, trackMaterial);
  const fill = new Mesh(ring, ringMaterial);
  // Start the progress arc at 12 o'clock; it shrinks as time runs out.
  track.position.z = 0.002;
  fill.position.z = 0.003;
  fill.rotation.z = Math.PI / 2;
  for (const mesh of [base, track, fill]) mesh.renderOrder = 950;
  group.add(base, track, fill);
  group.visible = false;
  group.userData.iwsdkPreviewBounds = 'exclude';
  return {
    group,
    ring,
    ringMaterial,
    geometries: [baseGeometry, trackGeometry, ring],
    materials: [baseMaterial, trackMaterial, ringMaterial],
  };
}

/** " +10 streak" when the last completion earned a streak bonus (PR 9). */
function bonusNote(): string {
  const bonus = getLastAward()?.bonusXp ?? 0;
  return bonus > 0 ? ` +${bonus} streak` : '';
}

export class SessionSystem extends createSystem({}) {
  private state: SessionState = IDLE_SESSION;
  private activeCard: Entity | undefined;
  private sessionStatus?: UIKit.Text;
  private sessionStatusText?: UIKit.Text;
  private skipButton?: UIKit.Text;
  private progressStatus?: UIKit.Text;
  private tickTimer: number | undefined;
  private timerDisk: TimerDisk | undefined;
  private timerEntity: Entity | undefined;
  private timerPanel: UIKitMLAsset | undefined;
  private shell: FocusShell | undefined;
  private shellEntity: Entity | undefined;
  private blurLevel: BlurLevel = loadBlurLevel();
  private readonly headPosition = new Vector3();
  private readonly headForward = new Vector3();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpC = new Vector3();
  private readonly tmpQ = new Quaternion();
  private readonly timerFront = new Vector3(0, 0, 1);
  private lastRingSegments = -1;
  private lastClockSecond = -1;
  private lastClockPaused = false;
  private trashCanEntity: Entity | undefined;
  private pendingNudgeFor: Entity | undefined;
  private nudgeController: AbortController | undefined;
  private progress: ProgressState = getProgress();
  private destroyed = false;
  private fadeFrom = 0;
  private fadeTarget = 0;
  private fadeStartedAt = 0;
  private fadeAnimating = false;
  private shellOpacity = 0;
  private calm = getSettings().calmScene;
  private fadeMs = FADE_MS;
  private readonly breakLog: Array<{ at: number; prompt: string; skippable: boolean }> = [];

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    this.sessionStatus = panel?.getElementById<UIKit.Text>('session-status') ?? undefined;
    this.sessionStatusText = panel?.getElementById<UIKit.Text>('session-status-text') ?? undefined;
    this.skipButton = panel?.getElementById<UIKit.Text>('skip-break') ?? undefined;
    this.progressStatus = panel?.getElementById<UIKit.Text>('progress-status') ?? undefined;
    this.updateProgressStatus();
    // The dev streak hook (PR 9) and other saves keep the panel line current.
    this.cleanupFuncs.push(
      onProgress((progress) => {
        this.progress = progress;
        this.updateProgressStatus();
      }),
    );
    setFocusStarter((entity, minutes) => this.beginFocus(entity, minutes));
    setCardCompleter((entity) => this.finishFocus(entity, 'manual'));
    setCardNudger((entity) => void this.requestNudge(entity));
    setFocusCommander((entity, command) => this.onCommand(entity, command));
    focusRestorer = () => this.restoreSavedFocus();
    setBuddyFocusApi({
      snapshot: () => this.focusSnapshot(),
      start: (entity, minutes) => this.buddyStart(entity, minutes),
      control: (command, minutes) => this.buddyControl(command, minutes),
      restore: (snapshot) => this.buddyRestore(snapshot),
      complete: (entity, visual) => this.buddyComplete(entity, visual),
      shelfPoint: () => {
        this.ensureTrashCan();
        return TRASH_CAN_MOUTH.toArray() as [number, number, number];
      },
      revokeXp: (amount) => {
        this.progress = revokeXp(amount);
        this.updateProgressStatus();
      },
    });
    this.cleanupFuncs.push(onCardEvent((type, entity) => this.onActiveCardEvent(type, entity)));
    this.createShell();
    void this.loadTimer();
    // PR 11: switching frost <-> calm mid-focus changes the look at once (same opacity fade rules).
    this.cleanupFuncs.push(
      onSettings((_s, changed) => {
        if (changed !== 'calmScene') return;
        if (this.state.phase === 'focus') {
          this.fadeTarget = -1; // force a re-target
          this.applyFade();
        }
      }),
    );

    const onSkip = () => this.skipCurrentBreak();
    this.skipButton?.addEventListener('click', onSkip);
    // Deadlines are checked every frame and, as a fallback when no frames are
    // drawn (tab hidden), once a second. Both read the wall clock.
    this.tickTimer = window.setInterval(() => this.tick(), 1_000);
    const xrManager = this.world.renderer.xr;
    const onSessionStart = () => {
      window.setTimeout(() => {
        if (this.state.phase === 'focus') this.placeFocusVisuals();
      }, 900);
    };
    xrManager.addEventListener('sessionstart', onSessionStart);

    if (import.meta.env.DEV) {
      const w = window as unknown as { __questty?: Record<string, unknown> };
      w.__questty = {
        ...w.__questty,
        focusState: () => ({
          ...this.state,
          remainingMs: focusRemainingMs(this.state, focusNow()),
          blur: this.blurLevel,
          shellOpacity: this.shellOpacity,
          scene: this.calm ? 'calm' : 'frost',
          shellTarget: this.fadeTarget,
          shellAt: this.shell?.mesh.position.toArray(),
          shellWindows: this.shell ? [this.shell.material.uniforms.uWin0.value.toArray(), this.shell.material.uniforms.uWin1.value.toArray()] : null,
          timerVisible: this.timerDisk?.group.visible ?? false,
          timerPosition: this.timerDisk?.group.position.toArray(),
          clock: this.timerPanel?.getElementById('timer-clock')?.properties?.peek?.()?.text,
          breakPrompt: this.state.phase === 'break' ? breakPromptById(this.state.promptId).id : null,
          canSkip: canSkipBreak(this.state),
          breakLog: [...this.breakLog],
          sessionText: this.sessionStatusText?.properties?.peek?.()?.text ?? null,
          sessionShown: this.sessionStatus?.properties?.peek?.()?.display ?? null,
        }),
        skipBreak: () => this.skipCurrentBreak(),
      };
    }

    this.cleanupFuncs.push(() => {
      setFocusStarter(undefined);
      setCardCompleter(undefined);
      setCardNudger(undefined);
      setFocusCommander(undefined);
      setBuddyFocusApi(undefined);
      focusRestorer = undefined;
      this.destroyed = true;
      xrManager.removeEventListener('sessionstart', onSessionStart);
      if (this.tickTimer !== undefined) window.clearInterval(this.tickTimer);
      this.tickTimer = undefined;
      this.nudgeController?.abort();
      this.nudgeController = undefined;
      this.skipButton?.removeEventListener('click', onSkip);
      this.shellEntity?.dispose();
      this.shell?.dispose();
      this.shell = undefined;
      this.timerEntity?.dispose();
      this.timerEntity = undefined;
      if (this.timerDisk !== undefined) {
        for (const geometry of this.timerDisk.geometries) geometry.dispose();
        for (const material of this.timerDisk.materials) material.dispose();
        this.timerDisk = undefined;
      }
      this.trashCanEntity?.dispose();
      this.trashCanEntity = undefined;
    });
  }

  update(): void {
    if (this.fadeAnimating) {
      const t = Math.min(1, Math.max(0, (performance.now() - this.fadeStartedAt) / this.fadeMs));
      const eased = t * t * (3 - 2 * t);
      this.shellOpacity = this.fadeFrom + (this.fadeTarget - this.fadeFrom) * eased;
      this.shell?.setOpacity(this.shellOpacity);
      if (t >= 1) this.fadeAnimating = false;
    }
    if (this.calm && this.shellOpacity > 0.002) this.shell?.setTime(performance.now() / 1000);
    if (this.state.phase === 'focus') {
      this.followActiveCard();
      this.refreshTimer(false);
    } else if (this.state.phase === 'break' && focusNow() >= this.state.endsAt) this.tick();
  }

  // ---- Focus lifecycle -------------------------------------------------

  private beginFocus(entity: Entity, minutes: number): boolean {
    // Pinned cards, and the Focus session card even while it floats.
    if (!canFocusCard(entity) || this.state.phase !== 'idle') return false;
    primeChime(); // inside the pinch, so the completion chime may play later
    const cardId = entity.getValue(QuestCard, 'cardId') as string;
    // The running card keeps its panel if it is lifted off a surface mid-focus.
    allowFloatingFocus(cardId);
    this.state = startFocus(this.state, cardId, focusNow(), minutes * 60_000);
    if (this.state.phase !== 'focus') return false;
    this.activeCard = entity;
    setQuestCardState(entity, `Focusing - ${minutes} min`);
    setCardActionMode(cardId, 'done', { paused: false, blur: this.blurLevel });
    this.placeFocusVisuals();
    this.applyFade();
    this.refreshTimer(true);
    this.persist();
    notifyCardFocused(entity);
    return true;
  }

  private onCommand(entity: Entity, command: FocusCommand): void {
    if (this.state.phase !== 'focus' || this.activeCard !== entity) return;
    const now = focusNow();
    const cardId = entity.getValue(QuestCard, 'cardId') as string;
    if (command === 'pause-toggle') {
      const paused = this.state.pausedRemainingMs !== null;
      this.state = paused ? resumeFocus(this.state, now) : pauseFocus(this.state, now);
      setQuestCardState(entity, paused ? 'Focusing' : 'Paused - pinch Resume');
    } else if (command === 'extend') {
      this.state = extendFocus(this.state, now);
    } else if (command === 'end') {
      this.endEarly(entity);
      return;
    } else if (command === 'blur') {
      const next = BLUR_LEVELS[(BLUR_LEVELS.indexOf(this.blurLevel) + 1) % BLUR_LEVELS.length];
      this.blurLevel = next;
      saveBlurLevel(next);
    }
    if (this.state.phase !== 'focus') return;
    setCardActionMode(cardId, 'done', {
      paused: this.state.pausedRemainingMs !== null,
      blur: this.blurLevel,
    });
    this.applyFade();
    this.refreshTimer(true);
    this.persist();
  }

  // ---- AI buddy (PR 6) ---------------------------------------------------

  private focusSnapshot(): FocusSnapshot | null {
    if (this.state.phase !== 'focus') return null;
    return {
      cardId: this.state.questId,
      durationMs: this.state.durationMs,
      endsAt: this.state.endsAt,
      pausedRemainingMs: this.state.pausedRemainingMs,
    };
  }

  /** Any card, floating too (the buddy can start focus on whatever card you name). */
  private buddyStart(entity: Entity, minutes: number): boolean {
    if (this.state.phase === 'focus' || !entity.active) return false;
    // The 20 s look-away break is a suggestion; asking for a new focus ends it.
    if (this.state.phase === 'break') this.state = { phase: 'idle', consecutiveSkips: this.state.consecutiveSkips };
    this.setSessionStatus(undefined);
    allowFloatingFocus(entity.getValue(QuestCard, 'cardId') as string);
    const ok = this.beginFocus(entity, minutes);
    if (ok) showFocusActionFor(entity);
    return ok;
  }

  private buddyControl(command: 'pause' | 'resume' | 'extend' | 'end', minutes?: number): boolean {
    const card = this.activeCard;
    if (this.state.phase !== 'focus' || card === undefined) return false;
    const paused = this.state.pausedRemainingMs !== null;
    if (command === 'pause') {
      if (paused) return false;
      this.onCommand(card, 'pause-toggle');
    } else if (command === 'resume') {
      if (!paused) return false;
      this.onCommand(card, 'pause-toggle');
    } else if (command === 'end') {
      this.endEarly(card);
    } else {
      const before = this.state.durationMs;
      this.state = extendFocus(this.state, focusNow(), Math.max(1, minutes ?? 5) * 60_000);
      if (this.state.phase !== 'focus' || this.state.durationMs === before) return false;
      this.afterFocusChange(card);
    }
    return true;
  }

  private afterFocusChange(card: Entity): void {
    if (this.state.phase !== 'focus') return;
    const paused = this.state.pausedRemainingMs !== null;
    setQuestCardState(card, paused ? 'Paused - pinch Resume' : 'Focusing');
    setCardActionMode(card.getValue(QuestCard, 'cardId') as string, 'done', { paused, blur: this.blurLevel });
    this.applyFade();
    this.refreshTimer(true);
    this.persist();
  }

  /** Undo: put the focus back exactly as it was (or end it when there was none). */
  private buddyRestore(snapshot: FocusSnapshot | null): boolean {
    if (snapshot === null) {
      if (this.state.phase === 'focus' && this.activeCard !== undefined) this.endEarly(this.activeCard);
      return true;
    }
    const entity = findQuestCard(snapshot.cardId);
    if (entity === undefined) return false;
    if (this.state.phase === 'focus' && this.activeCard !== entity && this.activeCard !== undefined) {
      this.endEarly(this.activeCard);
    }
    if (this.state.phase !== 'focus' && !this.buddyStart(entity, Math.max(1, Math.round(snapshot.durationMs / 60_000)))) {
      return false;
    }
    if (this.state.phase !== 'focus') return false;
    this.state = {
      ...this.state,
      durationMs: snapshot.durationMs,
      endsAt: snapshot.endsAt,
      pausedRemainingMs: snapshot.pausedRemainingMs,
    };
    this.afterFocusChange(entity);
    return true;
  }

  /** "Mark laundry done": the same completion as the Complete button (chime, XP, shelf). */
  private buddyComplete(entity: Entity, visual: 'shelf' | 'crumple' = 'shelf'): number {
    if (!entity.active) return 0;
    const xp = entity.getValue(QuestCard, 'xp') as number;
    if (this.state.phase === 'focus' && this.activeCard === entity) {
      this.finishFocus(entity, 'manual', visual);
      return xp;
    }
    this.ensureTrashCan();
    this.progress = awardXp(xp);
    this.updateProgressStatus();
    // The award's sound (chime, or the level-up fanfare instead) plays from XpBarSystem's onAward.
    setQuestCardState(entity, `Completed - +${xp} XP${bonusNote()}`);
    setCardActionMode(entity.getValue(QuestCard, 'cardId') as string, 'hidden');
    if (visual === 'crumple') crumpleQuestCard(entity);
    else tweenQuestCardTo(entity, TRASH_CAN_MOUTH, 900);
    return xp;
  }

  private endEarly(entity: Entity): void {
    this.state = endFocusEarly(this.state);
    clearFocusTimer();
    const cardId = entity.getValue(QuestCard, 'cardId') as string;
    setQuestCardState(entity, idleCardHint(entity));
    setCardActionMode(cardId, 'focus');
    this.activeCard = undefined;
    this.setSessionStatus(undefined);
    this.hideTimer();
    this.applyFade();
  }

  /** Complete (button) or the timer ran out: chime, mark done, award XP. */
  private finishFocus(entity: Entity, reason: 'manual' | 'timer' | 'away', visual: 'shelf' | 'crumple' = 'shelf'): void {
    if (this.state.phase !== 'focus' || this.activeCard !== entity) return;
    this.ensureTrashCan();
    const xp = entity.getValue(QuestCard, 'xp') as number;
    const progress = awardXp(xp);
    this.progress = progress;
    this.updateProgressStatus();
    // The award's sound (chime, or the level-up fanfare instead) plays from XpBarSystem's onAward.
    clearFocusTimer();
    const cardId = entity.getValue(QuestCard, 'cardId') as string;
    const prefix = reason === 'away' ? 'Finished while you were away' : 'Completed';
    setQuestCardState(entity, `${prefix} - +${xp} XP${bonusNote()}`);
    setCardActionMode(cardId, 'hidden');
    if (visual === 'crumple') crumpleQuestCard(entity);
    else tweenQuestCardTo(entity, TRASH_CAN_MOUTH, 900);
    this.activeCard = undefined;
    // PR 11: each break asks for something different (far point, shoulders, water), in turn.
    const prompt = nextBreakPrompt(loadLastBreakPrompt());
    saveLastBreakPrompt(prompt.id);
    this.state = completeFocus(this.state, focusNow(), prompt.id);
    this.hideTimer();
    this.applyFade();
    this.updateBreakStatus();
    this.guideBreak();
  }

  /** The buddy speaks the break prompt (caption bubble + its cue sound from the orb). */
  private guideBreak(): void {
    if (this.state.phase !== 'break') return;
    const prompt = breakPromptById(this.state.promptId);
    const skippable = canSkipBreak(this.state);
    this.breakLog.push({ at: Date.now(), prompt: prompt.id, skippable });
    if (this.breakLog.length > 20) this.breakLog.shift();
    // After the completion line, so both are seen.
    window.setTimeout(() => {
      if (this.state.phase !== 'break') return;
      playBuddyCue(`break:${prompt.id}`);
      // The buddy says it out loud too (from the orb), unless the break ended meanwhile.
      const questId = this.state.questId;
      window.setTimeout(() => {
        void speakBuddyLine(prompt.buddy, () => this.state.phase === 'break' && this.state.questId === questId);
      }, 450);
      announce(prompt.buddy, {
        tag: 'QUESTTY  -  BREAK',
        ms: Math.max(4000, this.state.endsAt - focusNow()),
        chips: skippable ? [{ label: 'Skip break', kind: 'plain', run: () => this.skipCurrentBreak() }] : [],
      });
    }, 1200);
  }

  /** Wall-clock deadline checks (frame loop + 1 s fallback). */
  private tick(): void {
    const now = focusNow();
    if (this.state.phase === 'focus') {
      // Fetch the coming break's spoken line while the user works, so it plays on time.
      preloadBuddyLine(nextBreakPrompt(loadLastBreakPrompt()).buddy);
      if (focusExpired(this.state, now) && this.activeCard !== undefined) {
        this.finishFocus(this.activeCard, 'timer');
        return;
      }
      this.refreshTimer(false);
    } else if (this.state.phase === 'break') {
      const next = advanceBreak(this.state, now);
      if (next !== this.state) {
        this.state = next;
        this.setSessionStatus(undefined);
      } else {
        this.updateBreakStatus();
      }
    }
  }

  private skipCurrentBreak(): boolean {
    const next = skipBreak(this.state);
    if (next === this.state) return false;
    this.breakLog.push({ at: Date.now(), prompt: 'skip', skippable: false });
    this.state = next;
    this.setSessionStatus(undefined);
    return true;
  }

  // ---- Timer display ---------------------------------------------------

  /** Ring every frame (only when a segment changes), text once per second. */
  private refreshTimer(force: boolean): void {
    if (this.state.phase !== 'focus' || this.timerDisk === undefined) return;
    const now = focusNow();
    if (!force && focusExpired(this.state, now)) {
      this.tick();
      return;
    }
    const remaining = focusRemainingMs(this.state, now);
    const fraction = Math.max(0, Math.min(1, remaining / this.state.durationMs));
    const segments = Math.ceil(fraction * TIMER_SEGMENTS);
    if (segments !== this.lastRingSegments || force) {
      this.timerDisk.ring.setDrawRange(0, segments * 6);
      this.lastRingSegments = segments;
    }
    const second = Math.ceil(remaining / 1_000);
    const paused = this.state.pausedRemainingMs !== null;
    if (second === this.lastClockSecond && paused === this.lastClockPaused && !force) return;
    this.lastClockSecond = second;
    const pausedChanged = paused !== this.lastClockPaused || force;
    this.lastClockPaused = paused;
    const clock = formatClock(remaining);
    this.timerPanel?.getElementById<UIKit.Text>('timer-clock')?.setProperties({ text: clock });
    if (pausedChanged) {
      this.timerPanel
        ?.getElementById<UIKit.Text>('timer-label')
        ?.setProperties({ text: paused ? 'PAUSED' : 'FOCUS' });
      this.timerDisk.ringMaterial.color.copy(paused ? RING_PAUSED : RING_RUNNING);
    }
    const title = this.activeCard?.getValue(QuestCard, 'title') as string | undefined;
    this.setSessionStatus(`Focus: ${title ?? 'quest'} | ${clock}${paused ? ' (paused)' : ''}`);
  }

  private setSessionStatus(text: string | undefined, canSkip = false): void {
    this.sessionStatus?.setProperties({ display: text === undefined ? 'none' : 'flex' });
    if (text !== undefined) this.sessionStatusText?.setProperties({ text });
    this.skipButton?.setProperties({
      display: text !== undefined && canSkip ? 'flex' : 'none',
    });
  }

  private updateBreakStatus(): void {
    if (this.state.phase !== 'break') return;
    const remaining = Math.max(0, this.state.endsAt - focusNow());
    const prompt = breakPromptById(this.state.promptId);
    this.setSessionStatus(`${prompt.status} (${formatClock(remaining)})`, canSkipBreak(this.state));
  }

  private headPose(): void {
    const head = this.world.player.head;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(this.headPosition);
    if (this.headPosition.y < 0.5) this.headPosition.copy(NOMINAL_HEAD);
    head.getWorldDirection(this.headForward).negate();
    this.headForward.y = 0;
    if (this.headForward.lengthSq() < 1e-4) this.headForward.set(0, 0, -1);
    this.headForward.normalize();
  }

  private readonly lastCardPos = new Vector3(NaN, NaN, NaN);
  private readonly lastCardQuat = new Quaternion();

  /**
   * The focus card can be dragged (floating -> desk, wall -> air) mid-focus:
   * the timer and the frost shell's clear window follow it every frame it moves.
   */
  private followActiveCard(): void {
    const card = this.activeCard?.object3D;
    if (card == null) return;
    card.updateWorldMatrix(true, false);
    card.getWorldPosition(this.tmpC);
    card.getWorldQuaternion(this.tmpQ);
    if (this.tmpC.distanceToSquared(this.lastCardPos) < 1e-6 && Math.abs(this.tmpQ.dot(this.lastCardQuat)) > 0.99999) return;
    this.lastCardPos.copy(this.tmpC);
    this.lastCardQuat.copy(this.tmpQ);
    this.placeFocusVisuals();
  }

  /** The running card was pinned or let go mid-focus: keep its label and controls on focus. */
  private onActiveCardEvent(type: CardEventType, entity: Entity): void {
    if (this.state.phase !== 'focus' || entity !== this.activeCard) return;
    if (type !== 'pinned' && type !== 'floated') return;
    const paused = this.state.pausedRemainingMs !== null;
    setQuestCardState(entity, paused ? 'Paused - pinch Resume' : 'Focusing');
    setCardActionMode(entity.getValue(QuestCard, 'cardId') as string, 'done', { paused, blur: this.blurLevel });
    this.placeFocusVisuals();
    this.persist();
  }

  /** Place the timer and centre the frost shell on the seated head. */
  private placeFocusVisuals(): void {
    this.headPose();
    const card = this.activeCard?.object3D;
    const timer = this.timerDisk;
    // Aim at the card, then lift the timer just above it in view, clamped a
    // little below the eye line; if that would still cover the card (a card
    // at eye level), slide the timer to the card's left (its panel is right).
    let yaw = Math.atan2(this.headForward.x, -this.headForward.z);
    let elevation = -0.2;
    if (card != null) {
      card.updateWorldMatrix(true, false);
      card.getWorldPosition(this.tmpA).sub(this.headPosition);
      const distance = this.tmpA.length();
      if (distance > 0.05) {
        const cardYaw = Math.atan2(this.tmpA.x, -this.tmpA.z);
        const cardElevation = Math.asin(Math.max(-1, Math.min(1, this.tmpA.y / distance)));
        const cardHalf = Math.atan(((CARD_UNITS_H / 2) * card.scale.x) / distance);
        const needed = cardHalf + Math.atan(TIMER_RADIUS / TIMER_DISTANCE) + TIMER_MARGIN;
        yaw = cardYaw;
        elevation = Math.max(
          TIMER_MIN_ELEVATION,
          Math.min(TIMER_MAX_ELEVATION, cardElevation + needed),
        );
        if (Math.abs(elevation - cardElevation) < needed) yaw = cardYaw - needed * 1.15;
      }
    }
    const title = this.activeCard?.getValue(QuestCard, 'title') as string | undefined;
    this.timerPanel
      ?.getElementById<UIKit.Text>('timer-title')
      ?.setProperties({ text: title === undefined ? '' : title.length > 30 ? `${title.slice(0, 29)}...` : title });
    if (timer !== undefined) {
      const flat = Math.cos(elevation) * TIMER_DISTANCE;
      timer.group.position.set(
        this.headPosition.x + Math.sin(yaw) * flat,
        this.headPosition.y + Math.sin(elevation) * TIMER_DISTANCE,
        this.headPosition.z - Math.cos(yaw) * flat,
      );
      // Face the eyes.
      this.tmpB.copy(this.headPosition).sub(timer.group.position).normalize();
      this.tmpQ.setFromUnitVectors(this.timerFront, this.tmpB);
      timer.group.quaternion.copy(this.tmpQ);
      timer.group.visible = true;
      this.lastRingSegments = -1;
      this.lastClockSecond = -1;
    }
    const shell = this.shell;
    if (shell !== undefined) {
      shell.mesh.position.copy(this.headPosition);
      if (timer !== undefined) {
        this.tmpB.copy(timer.group.position).sub(this.headPosition);
        const d = this.tmpB.length();
        shell.setWindow(1, this.tmpB.normalize(), Math.atan((TIMER_RADIUS + 0.03) / d));
      }
      if (card != null && this.activeCard !== undefined) {
        // One window over the card and its focus panel (just to its right).
        const s = card.scale.x;
        card.getWorldQuaternion(this.tmpQ);
        this.tmpC.set(1, 0, 0).applyQuaternion(this.tmpQ);
        const cardHalfW = (CARD_UNITS_W / 2) * s;
        const panelRight = cardHalfW + 2 * s + 0.015;
        card.getWorldPosition(this.tmpA).addScaledVector(this.tmpC, (panelRight - cardHalfW) / 2);
        const halfW = (cardHalfW + panelRight) / 2;
        const halfH = Math.max((CARD_UNITS_H / 2) * s, 1.4 * s);
        this.tmpA.sub(this.headPosition);
        const d = Math.max(0.3, this.tmpA.length());
        shell.setWindow(0, this.tmpA.normalize(), Math.atan(Math.hypot(halfW, halfH) / d) + 0.05);
      } else {
        shell.setWindow(0, null, 0);
      }
    }
  }

  private hideTimer(): void {
    if (this.timerDisk !== undefined) this.timerDisk.group.visible = false;
    this.lastRingSegments = -1;
    this.lastClockSecond = -1;
  }

  // ---- Frost shell -----------------------------------------------------

  /** Fade toward the level the state wants: full in focus, partial when paused, off otherwise. */
  private applyFade(): void {
    let target = 0;
    if (this.state.phase === 'focus') {
      // The look is chosen when a fade starts (a fade back keeps the look it came in with).
      this.calm = getSettings().calmScene;
      this.shell?.setCalm(this.calm ? 1 : 0);
      target = (this.calm ? CALM_OPACITY : BLUR_OPACITY)[this.blurLevel];
      if (this.state.pausedRemainingMs !== null) target *= PAUSED_FADE_FACTOR;
    }
    if (target === this.fadeTarget && (this.fadeAnimating || this.shellOpacity === target)) return;
    this.fadeFrom = this.shellOpacity;
    this.fadeTarget = target;
    // The calm scene fades in slowly (2.5 s) and back out a little faster (1.5 s).
    this.fadeMs = this.calm ? (target > this.fadeFrom ? 2_500 : 1_500) * FADE_SLOW : FADE_MS;
    this.fadeStartedAt = performance.now();
    this.fadeAnimating = this.fadeFrom !== target;
  }

  private createShell(): void {
    this.shell = createFocusShell();
    this.shellEntity = this.world.createTransformEntity(this.shell.mesh, {
      parent: this.world.sceneEntity,
      persistent: true,
    });
  }

  private async loadTimer(): Promise<void> {
    this.timerDisk = createTimerDisk();
    this.timerEntity = this.world.createTransformEntity(this.timerDisk.group, {
      parent: this.world.sceneEntity,
      persistent: true,
    });
    try {
      const panel = await this.world.assets.instantiate<UIKitMLAsset>('focus-timer');
      if (this.destroyed || this.timerEntity === undefined) {
        panel.dispose();
        return;
      }
      panel.name = 'Focus Timer Text';
      panel.scale.setScalar(TIMER_TEXT_SCALE);
      panel.position.set(0, 0, 0.006);
      // Draw the digits after the frost shell (renderOrder 900) so they stay crisp.
      panel.getElementById<UIKit.Text>('timer-root')?.setProperties({ renderOrder: 960 } as never);
      this.world.createTransformEntity(panel, { parent: this.timerEntity });
      this.timerPanel = panel;
      this.lastClockSecond = -1;
      if (this.state.phase === 'focus') {
        this.placeFocusVisuals();
        this.refreshTimer(true);
      }
    } catch (error) {
      console.warn('[session] Focus timer text could not be loaded.', error);
    }
  }

  // ---- Persistence -----------------------------------------------------

  private persist(): void {
    const card = this.activeCard;
    const object = card?.object3D;
    if (this.state.phase !== 'focus' || card === undefined || object == null) return;
    object.updateWorldMatrix(true, false);
    object.getWorldPosition(this.tmpA);
    object.getWorldQuaternion(this.tmpQ);
    saveFocusTimer({
      version: 1,
      cardId: card.getValue(QuestCard, 'cardId') as string,
      title: card.getValue(QuestCard, 'title') as string,
      xp: card.getValue(QuestCard, 'xp') as number,
      zoneId: card.getValue(QuestCard, 'zoneId') as string,
      surfaceId: card.getValue(QuestCard, 'surfaceId') as string,
      position: [this.tmpA.x, this.tmpA.y, this.tmpA.z],
      quaternion: [this.tmpQ.x, this.tmpQ.y, this.tmpQ.z, this.tmpQ.w],
      scale: object.scale.x,
      durationMs: this.state.durationMs,
      endsAt: this.state.endsAt,
      pausedRemainingMs: this.state.pausedRemainingMs,
      consecutiveSkips: this.state.consecutiveSkips,
    });
  }

  /** After a reload: re-create the pinned card and resume its timer. */
  private async restoreSavedFocus(): Promise<string | null> {
    const saved = loadFocusTimer();
    if (saved === null || this.state.phase !== 'idle') return null;
    // PR 4: the card itself is restored by persistence.ts (same stable id);
    // only a timer saved without a known card re-creates one here.
    let entity = saved.cardId !== undefined ? findQuestCard(saved.cardId) : undefined;
    if (entity === undefined) {
      try {
        entity = await createQuestCard({
          id: saved.cardId,
          title: saved.title,
          xp: saved.xp,
          position: saved.position,
          restored: true,
        });
      } catch (error) {
        console.warn('[session] Could not restore the focus card.', error);
        return null;
      }
      if (this.destroyed || this.state.phase !== 'idle') return null;
      this.tmpA.fromArray(saved.position);
      this.tmpQ.fromArray(saved.quaternion);
      setCardWorldPose(entity, this.tmpA, this.tmpQ, saved.scale);
      entity.setValue(QuestCard, 'zoneId', saved.zoneId);
      entity.setValue(QuestCard, 'surfaceId', saved.zoneId ? saved.surfaceId || 'restored' : '');
      entity.setValue(QuestCard, 'userPlaced', true);
    }
    if (this.destroyed || this.state.phase !== 'idle') return null;
    const cardId = entity.getValue(QuestCard, 'cardId') as string;
    allowFloatingFocus(cardId);
    this.state = {
      phase: 'focus',
      questId: cardId,
      durationMs: saved.durationMs,
      endsAt: saved.endsAt,
      pausedRemainingMs: saved.pausedRemainingMs,
      consecutiveSkips: saved.consecutiveSkips,
    };
    this.activeCard = entity;
    console.info('[session] Resumed a focus timer after reload.');
    if (focusExpired(this.state, focusNow())) {
      this.finishFocus(entity, 'away');
      return saved.title;
    }
    const paused = this.state.pausedRemainingMs !== null;
    setQuestCardState(entity, paused ? 'Paused - pinch Resume' : 'Focusing (resumed)');
    setCardActionMode(cardId, 'done', { paused, blur: this.blurLevel });
    showFocusActionFor(entity);
    this.placeFocusVisuals();
    this.applyFade();
    this.refreshTimer(true);
    this.persist();
    return saved.title;
  }

  // ---- Unchanged helpers -----------------------------------------------

  private async requestNudge(entity: Entity): Promise<void> {
    if (
      this.state.phase !== 'focus' ||
      this.activeCard !== entity ||
      this.pendingNudgeFor === entity
    ) {
      return;
    }
    const cardId = entity.getValue(QuestCard, 'cardId') as string;
    const title = entity.getValue(QuestCard, 'title') as string;
    this.pendingNudgeFor = entity;
    const controller = new AbortController();
    this.nudgeController = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    setQuestCardState(entity, 'Thinking of one small next step...');
    try {
      const response = await fetch('/api/quests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'nudge', title }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Nudge API returned ${response.status}`);
      const payload = (await response.json()) as { nudge?: unknown };
      if (
        typeof payload.nudge !== 'string' ||
        payload.nudge.trim().length === 0 ||
        payload.nudge.length > 140
      ) {
        throw new Error('Nudge API returned invalid text');
      }
      if (
        this.state.phase === 'focus' &&
        this.activeCard === entity &&
        entity.getValue(QuestCard, 'cardId') === cardId
      ) {
        setQuestCardState(entity, payload.nudge.trim());
      }
    } catch {
      if (this.state.phase === 'focus' && this.activeCard === entity) {
        setQuestCardState(entity, 'AI nudge unavailable. Check the server key.');
      }
    } finally {
      window.clearTimeout(timeout);
      if (this.pendingNudgeFor === entity) this.pendingNudgeFor = undefined;
      if (this.nudgeController === controller) this.nudgeController = undefined;
    }
  }

  private updateProgressStatus(): void {
    const streak = viewStreak(this.progress, dayKey(Date.now())).streak;
    this.progressStatus?.setProperties({
      text:
        streak > 1
          ? `Level ${this.progress.level} | ${this.progress.xp} XP | ${streak} day streak`
          : `Level ${this.progress.level} | ${this.progress.xp} XP`,
    });
  }

  /** PR 12: the trash can finished cards fly into (replaces the trophy plinth). */
  private ensureTrashCan(): void {
    if (this.trashCanEntity !== undefined || this.destroyed) return;
    this.trashCanEntity = this.world.createTransformEntity(createTrashCan());
  }
}

let focusRestorer: (() => Promise<string | null>) | undefined;

/**
 * Resume a focus timer saved before a reload (call once cards can be created).
 * Resolves to the restored card's title, or null when there was none.
 */
export function restoreSavedFocus(): Promise<string | null> {
  return focusRestorer?.() ?? Promise.resolve(null);
}
