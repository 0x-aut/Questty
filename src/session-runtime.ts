import {
  AudioUtils,
  BufferGeometry,
  CircleGeometry,
  createSystem,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  TorusGeometry,
  UIKit,
  UIKitMLAsset,
  Vector3,
  type Entity,
} from '@iwsdk/core';
import { QuestCard } from './quest-component.js';
import { setQuestCardState, tweenQuestCardTo } from './quest-card.js';
import {
  setCardActionMode,
  setCardCompleter,
  setFocusStarter,
} from './session-events.js';
import {
  advanceSession,
  completeFocus,
  FOCUS_MS,
  IDLE_SESSION,
  skipBreak,
  startFocus,
  type SessionState,
} from './session.js';
import { awardXp, getProgress, type ProgressState } from './progress.js';

const FOCUS_FADE_MS = 3_000;
const BREAK_FADE_MS = 2_000;
const TROPHY_SHELF_ORIGIN = new Vector3(0.65, 0, -1.2);
const TROPHY_SHELF_CARD_POSITION = new Vector3(0.65, 1.12, -1.2);
const TIMER_RADIUS = 0.25;
const TIMER_SEGMENTS = 96;
const TIMER_DISTANCE = 1.2;
const TIMER_FRONT = new Vector3(0, 0, 1);

type TimerDisk = {
  group: Group;
  pie: CircleGeometry;
  geometries: BufferGeometry[];
  materials: MeshBasicMaterial[];
};

function createTimerDisk(): TimerDisk {
  const group = new Group();
  const baseGeometry = new CircleGeometry(TIMER_RADIUS, TIMER_SEGMENTS);
  const pie = new CircleGeometry(TIMER_RADIUS - 0.006, TIMER_SEGMENTS);
  const ringGeometry = new TorusGeometry(TIMER_RADIUS, 0.006, 8, TIMER_SEGMENTS);
  pie.setDrawRange(0, TIMER_SEGMENTS * 3);

  const baseMaterial = new MeshBasicMaterial({
    color: 0x10212b,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    side: DoubleSide,
  });
  const pieMaterial = new MeshBasicMaterial({
    color: 0xe8d798,
    transparent: true,
    opacity: 0.96,
    depthWrite: false,
    side: DoubleSide,
  });
  const ringMaterial = new MeshBasicMaterial({
    color: 0xfff5cf,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: DoubleSide,
  });
  const base = new Mesh(baseGeometry, baseMaterial);
  const fill = new Mesh(pie, pieMaterial);
  const ring = new Mesh(ringGeometry, ringMaterial);
  fill.position.z = 0.002;
  ring.position.z = 0.004;
  group.add(base, fill, ring);
  group.visible = false;
  group.userData.iwsdkPreviewBounds = 'exclude';
  return {
    group,
    pie,
    geometries: [baseGeometry, pie, ringGeometry],
    materials: [baseMaterial, pieMaterial, ringMaterial],
  };
}

export class SessionSystem extends createSystem({}) {
  private state: SessionState = IDLE_SESSION;
  private activeCard: Entity | undefined;
  private sessionStatus?: UIKit.Text;
  private sessionStatusText?: UIKit.Text;
  private skipButton?: UIKit.Text;
  private progressStatus?: UIKit.Text;
  private transitionTimer: number | undefined;
  private countdownTimer: number | undefined;
  private domeMaterial: MeshBasicMaterial | undefined;
  private domeEntity: Entity | undefined;
  private timerDisk: TimerDisk | undefined;
  private timerEntity: Entity | undefined;
  private readonly timerHeadPosition = new Vector3();
  private readonly timerPosition = new Vector3();
  private readonly timerDirection = new Vector3();
  private readonly timerNormal = new Vector3();
  private readonly timerRotation = new Quaternion();
  private lastPieSegment = -1;
  private trophyShelfEntity: Entity | undefined;
  private progress: ProgressState = getProgress();
  private domeDestroyed = false;
  private fadeFrom = 0;
  private fadeTarget = 0;
  private fadeStartedAt = 0;
  private fadeDuration = 0;
  private fadeAnimating = false;

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    this.sessionStatus = panel?.getElementById<UIKit.Text>('session-status') ?? undefined;
    this.sessionStatusText = panel?.getElementById<UIKit.Text>('session-status-text') ?? undefined;
    this.skipButton = panel?.getElementById<UIKit.Text>('skip-break') ?? undefined;
    this.progressStatus = panel?.getElementById<UIKit.Text>('progress-status') ?? undefined;
    this.updateProgressStatus();
    setFocusStarter((entity) => this.beginFocus(entity));
    setCardCompleter((entity) => this.completeActiveCard(entity));
    void this.loadDome();
    this.loadTimerDisk();
    void this.loadTrophyShelf();

    const onSkip = () => this.skipCurrentBreak();
    this.skipButton?.addEventListener('click', onSkip);

    this.cleanupFuncs.push(() => {
      setFocusStarter(undefined);
      setCardCompleter(undefined);
      this.domeDestroyed = true;
      if (this.transitionTimer !== undefined) window.clearTimeout(this.transitionTimer);
      if (this.countdownTimer !== undefined) window.clearTimeout(this.countdownTimer);
      this.skipButton?.removeEventListener('click', onSkip);
      this.transitionTimer = undefined;
      this.countdownTimer = undefined;
      this.domeEntity?.dispose();
      this.domeEntity = undefined;
      this.domeMaterial?.dispose();
      this.domeMaterial = undefined;
      this.timerEntity?.dispose();
      this.timerEntity = undefined;
      if (this.timerDisk !== undefined) {
        for (const geometry of this.timerDisk.geometries) geometry.dispose();
        for (const material of this.timerDisk.materials) material.dispose();
        this.timerDisk = undefined;
      }
      this.trophyShelfEntity?.dispose();
      this.trophyShelfEntity = undefined;
    });
  }

  update(): void {
    if (this.fadeAnimating && this.domeMaterial !== undefined) {
      const progress = Math.min(
        1,
        Math.max(0, (performance.now() - this.fadeStartedAt) / this.fadeDuration),
      );
      this.domeMaterial.opacity = this.fadeFrom + (this.fadeTarget - this.fadeFrom) * progress;
      if (progress >= 1) this.fadeAnimating = false;
    }
    if (this.state.phase === 'focus' && this.timerDisk !== undefined) {
      const remaining = Math.max(
        0,
        Math.min(1, (this.state.endsAt - Date.now()) / FOCUS_MS),
      );
      const segments = Math.floor(remaining * TIMER_SEGMENTS);
      if (segments !== this.lastPieSegment) {
        this.timerDisk.pie.setDrawRange(0, segments * 3);
        this.lastPieSegment = segments;
      }
    }
    if (this.state.phase === 'focus' && this.timerDisk !== undefined) {
      const remaining = Math.max(
        0,
        Math.min(1, (this.state.endsAt - Date.now()) / FOCUS_MS),
      );
      const segments = Math.floor(remaining * TIMER_SEGMENTS);
      if (segments !== this.lastPieSegment) {
        this.timerDisk.pie.setDrawRange(0, segments * 3);
        this.lastPieSegment = segments;
      }
    }
  }

  private beginFocus(entity: Entity): void {
    const zoneId = entity.getValue(QuestCard, 'zoneId') as string;
    if (zoneId.length === 0 || this.state.phase !== 'idle') return;

    const cardId = entity.getValue(QuestCard, 'cardId') as string;
    const title = entity.getValue(QuestCard, 'title') as string;
    this.state = startFocus(this.state, cardId, Date.now());
    if (this.state.phase !== 'focus') return;
    this.activeCard = entity;
    setQuestCardState(entity, 'Focus started');
    setCardActionMode(cardId, 'done');
    this.placeTimerDisk();
    this.fadeTo(1, FOCUS_FADE_MS);
    this.updateFocusCountdown(title);
    this.scheduleTransition();
  }

  private scheduleTransition(): void {
    if (this.transitionTimer !== undefined) window.clearTimeout(this.transitionTimer);
    if (this.state.phase === 'idle') {
      this.transitionTimer = undefined;
      return;
    }
    this.transitionTimer = window.setTimeout(
      () => this.advance(),
      Math.max(0, this.state.endsAt - Date.now()),
    );
  }

  private advance(): void {
    this.transitionTimer = undefined;
    const previous = this.state;
    const next = advanceSession(previous, Date.now());
    if (next === previous) {
      this.scheduleTransition();
      return;
    }
    this.state = next;
    if (next.phase === 'break') {
      this.enterBreak();
    } else {
      if (this.countdownTimer !== undefined) window.clearTimeout(this.countdownTimer);
      this.countdownTimer = undefined;
      if (this.activeCard !== undefined) {
        const zoneId = this.activeCard.getValue(QuestCard, 'zoneId') as string;
        const cardId = this.activeCard.getValue(QuestCard, 'cardId') as string;
        setQuestCardState(
          this.activeCard,
          zoneId.length > 0 ? `Pinned to ${zoneId} - poke to focus` : 'Grab and pin to a zone',
        );
        if (zoneId.length > 0) setCardActionMode(cardId, 'focus');
      }
      this.activeCard = undefined;
      this.setSessionStatus(undefined);
      this.hideTimerDisk();
      this.fadeTo(0, BREAK_FADE_MS);
    }
    this.scheduleTransition();
  }

  private setSessionStatus(text: string | undefined, canSkip = false): void {
    this.sessionStatus?.setProperties({ display: text === undefined ? 'none' : 'flex' });
    if (text !== undefined) this.sessionStatusText?.setProperties({ text });
    this.skipButton?.setProperties({
      display: text !== undefined && canSkip ? 'flex' : 'none',
    });
  }

  private enterBreak(): void {
    if (this.countdownTimer !== undefined) window.clearTimeout(this.countdownTimer);
    this.countdownTimer = undefined;
    if (this.activeCard !== undefined) {
      const cardId = this.activeCard.getValue(QuestCard, 'cardId') as string;
      setQuestCardState(this.activeCard, 'Break time');
      setCardActionMode(cardId, 'disabled');
    }
    this.hideTimerDisk();
    this.fadeTo(0, BREAK_FADE_MS);
    this.updateBreakCountdown();
  }

  private updateFocusCountdown(title: string): void {
    if (this.state.phase !== 'focus') return;
    const seconds = Math.max(0, Math.ceil((this.state.endsAt - Date.now()) / 1_000));
    const minutesText = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    this.setSessionStatus(`Focus: ${title} | ${minutesText}`);
    if (seconds > 0) {
      this.countdownTimer = window.setTimeout(() => {
        this.countdownTimer = undefined;
        this.updateFocusCountdown(title);
      }, 1_000);
    }
  }

  private updateBreakCountdown(): void {
    if (this.state.phase !== 'break') return;
    const seconds = Math.max(0, Math.ceil((this.state.endsAt - Date.now()) / 1_000));
    const skipAllowed = this.state.consecutiveSkips === 0;
    const minutesText = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    this.setSessionStatus(
      `Look at the farthest point for 20 seconds (${minutesText})`,
      skipAllowed,
    );
    if (seconds > 0) {
      this.countdownTimer = window.setTimeout(() => {
        this.countdownTimer = undefined;
        this.updateBreakCountdown();
      }, 1_000);
    }
  }

  private skipCurrentBreak(): void {
    const next = skipBreak(this.state);
    if (next === this.state) return;
    if (this.transitionTimer !== undefined) window.clearTimeout(this.transitionTimer);
    if (this.countdownTimer !== undefined) window.clearTimeout(this.countdownTimer);
    this.transitionTimer = undefined;
    this.countdownTimer = undefined;
    this.state = next;
    if (this.activeCard !== undefined) {
      const zoneId = this.activeCard.getValue(QuestCard, 'zoneId') as string;
      const cardId = this.activeCard.getValue(QuestCard, 'cardId') as string;
      setQuestCardState(
        this.activeCard,
        zoneId.length > 0 ? `Pinned to ${zoneId} - poke to focus` : 'Grab and pin to a zone',
      );
      if (zoneId.length > 0) setCardActionMode(cardId, 'focus');
    }
    this.activeCard = undefined;
    this.setSessionStatus(undefined);
    this.hideTimerDisk();
    this.fadeTo(0, BREAK_FADE_MS);
  }

  private completeActiveCard(entity: Entity): void {
    if (this.state.phase !== 'focus' || this.activeCard !== entity) return;
    const xp = entity.getValue(QuestCard, 'xp') as number;
    const progress = awardXp(xp);
    this.progress = progress;
    this.updateProgressStatus();
    try {
      AudioUtils.play(entity);
    } catch {
      // A missing or blocked sound must not prevent quest completion.
    }
    const cardId = entity.getValue(QuestCard, 'cardId') as string;
    setQuestCardState(entity, `Completed - +${xp} XP`);
    setCardActionMode(cardId, 'hidden');
    tweenQuestCardTo(entity, TROPHY_SHELF_CARD_POSITION, 900);
    if (this.transitionTimer !== undefined) window.clearTimeout(this.transitionTimer);
    this.transitionTimer = undefined;
    this.activeCard = undefined;
    this.state = completeFocus(this.state, Date.now());
    this.enterBreak();
    this.scheduleTransition();
  }

  private updateProgressStatus(): void {
    this.progressStatus?.setProperties({
      text: `Level ${this.progress.level} | ${this.progress.xp} XP | ${this.progress.streak} day streak`,
    });
  }

  private fadeTo(opacity: number, durationMs: number): void {
    const now = performance.now();
    this.fadeFrom = this.currentDomeOpacity(now);
    this.fadeTarget = opacity;
    this.fadeStartedAt = now;
    this.fadeDuration = Math.max(1, durationMs);
    this.fadeAnimating = durationMs > 0 && this.fadeFrom !== opacity;
    if (!this.fadeAnimating && this.domeMaterial !== undefined) {
      this.domeMaterial.opacity = opacity;
    }
  }

  private currentDomeOpacity(now: number): number {
    if (!this.fadeAnimating) return this.domeMaterial?.opacity ?? this.fadeTarget;
    const progress = Math.min(1, Math.max(0, (now - this.fadeStartedAt) / this.fadeDuration));
    return this.fadeFrom + (this.fadeTarget - this.fadeFrom) * progress;
  }

  private async loadDome(): Promise<void> {
    try {
      const dome = await this.world.assets.instantiate<Mesh>('focus-dome');
      if (this.domeDestroyed) return;
      this.domeMaterial = (dome.material as MeshBasicMaterial).clone();
      dome.material = this.domeMaterial;
      this.domeMaterial.opacity = this.currentDomeOpacity(performance.now());
      this.domeEntity = this.world.createTransformEntity(dome, {
        parent: this.world.sceneEntity,
        persistent: true,
      });
    } catch (error) {
      console.warn('[session] Focus dome could not be loaded.', error);
    }
  }

  private loadTimerDisk(): void {
    this.timerDisk = createTimerDisk();
    this.timerEntity = this.world.createTransformEntity(this.timerDisk.group, {
      parent: this.world.sceneEntity,
      persistent: true,
    });
  }

  private placeTimerDisk(): void {
    if (this.timerDisk === undefined) return;
    const head = this.world.player.head;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(this.timerHeadPosition);
    head.getWorldDirection(this.timerDirection).normalize();
    this.timerPosition
      .copy(this.timerHeadPosition)
      .addScaledVector(this.timerDirection, TIMER_DISTANCE);
    this.timerNormal.copy(this.timerDirection).negate();
    this.timerRotation.setFromUnitVectors(TIMER_FRONT, this.timerNormal);
    this.timerDisk.group.position.copy(this.timerPosition);
    this.timerDisk.group.quaternion.copy(this.timerRotation);
    this.timerDisk.group.visible = true;
    this.timerDisk.pie.setDrawRange(0, TIMER_SEGMENTS * 3);
    this.lastPieSegment = TIMER_SEGMENTS;
  }

  private hideTimerDisk(): void {
    if (this.timerDisk !== undefined) this.timerDisk.group.visible = false;
    this.lastPieSegment = -1;
  }

  private async loadTrophyShelf(): Promise<void> {
    try {
      const shelf = await this.world.assets.instantiate<Group>('plinth');
      if (this.domeDestroyed) return;
      shelf.name = 'Trophy Shelf';
      shelf.position.copy(TROPHY_SHELF_ORIGIN);
      this.trophyShelfEntity = this.world.createTransformEntity(shelf);
    } catch (error) {
      console.warn('[session] Trophy shelf could not be loaded.', error);
    }
  }
}
