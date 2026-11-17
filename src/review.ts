/**
 * PR 11: the evening review (rules in review-logic.ts, saved state in
 * review-store.ts).
 *
 * Once a day, at or after the review hour (default 6 pm, Settings cycles it),
 * or whenever the user asks ("review my day"), a small card appears low and to
 * the left, the open cards glow one by one, and the buddy says what is left.
 * Finished cards are flicked (or crumpled) away with the physical-finish
 * gestures, which complete them with the usual chime and XP. "Roll N to
 * tomorrow" moves everything still open in Today / Unsorted / Before I leave
 * to Later with tomorrow's date; on that day those cards are promoted into
 * Today before the return ritual counts the room (the ritual never asks about
 * them). "Not now" closes it for the day. With the return ritual on screen the
 * review waits until the ritual is gone; it never starts during a focus.
 */
import { createSystem, Matrix4, PokeInteractable, Quaternion, RayInteractable, UIKit, UIKitMLAsset, Vector3, type Entity } from '@iwsdk/core';
import { QuestCard, QuestCardTween } from './quest-component.js';
import { findQuestCard, onCardEvent, setQuestCardState, idleCardHint } from './quest-card.js';
import { pulseCards, setCardCategory } from './categories.js';
import { announce, pushBuddyUndo } from './announce.js';
import { getSettings, SEATED_REACH_M } from './settings.js';
import { loadFocusTimer } from './focus-store.js';
import { dayKey } from './streak.js';
import { playBuddyCue } from './sfx.js';
import { promoteDue, reviewDue, reviewLine, rollPlan, withRolled, ROLLING, type ReviewCard, type RollStep } from './review-logic.js';
import { getReviewStore, isRitualRunning, reloadReviewStore, saveReviewStore } from './review-store.js';

const SCALE = 0.065;
const DISTANCE = 0.46;
const DROP = 0.4;
const SIDE_DEG = 16;
const CHECK_MS = 15_000;
const GLOW_STEP_MS = 700;
/** It stays until answered, but not forever: after this it closes for the day. */
const MAX_OPEN_MS = 180_000;

type Run = {
  source: 'auto' | 'ask';
  startedAt: number;
  open: string[];
  done: string[];
  glowed: number;
  answered: 'roll' | 'later' | 'timeout' | null;
  rolled: RollStep[];
};

let starter: ((source: 'auto' | 'ask') => boolean) | undefined;
/** Start the evening review now (the buddy's "review my day"). False when it cannot. */
export function startEveningReview(): boolean {
  return starter?.('ask') ?? false;
}

/**
 * Cards rolled to a day that has come: into Today. Called by the return ritual
 * before it counts the room, and by the review on each session start.
 */
export function promoteDueCards(now = Date.now()): string[] {
  const { promote, store } = promoteDue(getReviewStore(), now, (id) => findQuestCard(id) !== undefined);
  const moved: string[] = [];
  for (const id of promote) if (setCardCategory(id, 'today', 'api')) moved.push(id);
  saveReviewStore(store);
  for (const id of moved) {
    const e = findQuestCard(id);
    if (e !== undefined) setQuestCardState(e, idleCardHint(e));
  }
  return moved;
}

export class ReviewSystem extends createSystem({
  cards: { required: [QuestCard] },
}) {
  private panel: UIKitMLAsset | undefined;
  private entity: Entity | undefined;
  private loading: Promise<void> | null = null;
  private run: Run | null = null;
  private timer = 0;
  private opacity = 0;
  private lastOpacity = -1;
  private closing = false;
  private readonly history: Array<{ at: number; event: string; detail?: string }> = [];
  private readonly head = new Vector3();
  private readonly fwd = new Vector3();
  private readonly m = new Matrix4();

  init(): void {
    starter = (source) => this.start(source);
    this.timer = window.setInterval(() => this.check(), CHECK_MS);
    const xr = this.world.renderer.xr;
    const onStart = () => {
      // The return ritual (2.5 s after the session starts) promotes due cards itself and says so; this
      // catches the rest (no ritual: same day, or an empty room) once it would have started.
      window.setTimeout(() => {
        if (isRitualRunning()) return;
        const moved = promoteDueCards();
        if (moved.length > 0) this.log('promoted', moved.join(','));
      }, 6000);
      window.setTimeout(() => this.check(), 6500);
    };
    xr.addEventListener('sessionstart', onStart);
    this.cleanupFuncs.push(
      () => {
        starter = undefined;
        window.clearInterval(this.timer);
        xr.removeEventListener('sessionstart', onStart);
        this.entity?.dispose();
      },
      onCardEvent((type, entity) => {
        const run = this.run;
        if (run === null || run.answered !== null) return;
        if (type !== 'completed' && type !== 'removed') return;
        const id = entity.getValue(QuestCard, 'cardId') as string;
        if (!run.open.includes(id) || run.done.includes(id)) return;
        run.done.push(id);
        this.log(type === 'completed' ? 'done' : 'removed', id);
        this.refresh();
      }),
    );
    if (import.meta.env.DEV) {
      const w = window as unknown as { __questty?: Record<string, unknown> };
      w.__questty = {
        ...w.__questty,
        review: {
          state: () => this.state(),
          start: () => this.start('ask'),
          check: () => this.check(),
          roll: () => this.roll(),
          later: () => this.later(),
          store: () => JSON.parse(JSON.stringify(getReviewStore())),
          reload: () => reloadReviewStore(),
          promote: (now?: number) => promoteDueCards(now ?? Date.now()),
        },
      };
    }
  }

  private openCards(): ReviewCard[] {
    const out: ReviewCard[] = [];
    for (const e of this.queries.cards.entities) {
      if (!e.active || e.hasComponent(QuestCardTween)) continue;
      out.push({
        id: e.getValue(QuestCard, 'cardId') as string,
        title: e.getValue(QuestCard, 'title') as string,
        category: e.getValue(QuestCard, 'category') as string,
      });
    }
    return out;
  }

  /** Auto offer: XR on, no ritual on screen, no focus running, once a day after the hour. */
  private check(): boolean {
    if (this.run !== null || !this.world.renderer.xr.isPresenting || isRitualRunning()) return false;
    if (loadFocusTimer() !== null) return false;
    const open = this.openCards().filter((c) => ROLLING.has(c.category) && getReviewStore().due[c.id] === undefined);
    if (!reviewDue(Date.now(), getReviewStore(), open.length)) return false;
    return this.start('auto');
  }

  private start(source: 'auto' | 'ask'): boolean {
    if (this.run !== null) return false;
    if (isRitualRunning()) {
      // Never on top of the welcome-back card: try again once it is gone.
      window.setTimeout(() => this.start(source), 3000);
      return true;
    }
    const due = getReviewStore().due;
    const open = this.openCards().filter((c) => ROLLING.has(c.category) && due[c.id] === undefined);
    this.run = { source, startedAt: performance.now(), open: open.map((c) => c.id), done: [], glowed: 0, answered: null, rolled: [] };
    this.closing = false;
    this.log('start', `${source} open=${open.length}`);
    void this.ensurePanel().then(() => {
      if (this.run === null || this.panel === undefined) return;
      this.place();
      this.refresh();
      this.opacity = 0;
      this.lastOpacity = -1;
      this.panel.visible = true;
    });
    playBuddyCue('review');
    announce(open.length > 0 ? `Evening review. ${reviewLine(open.length)}` : reviewLine(0), { tag: 'QUESTTY  -  EVENING REVIEW', ms: 6000 });
    if (getSettings().reducedMotion && open.length > 0) {
      pulseCards(this.run.open, 3200);
      this.run.glowed = this.run.open.length;
    }
    return true;
  }

  private remaining(): string[] {
    const run = this.run;
    if (run === null) return [];
    return run.open.filter((id) => !run.done.includes(id) && findQuestCard(id) !== undefined);
  }

  private refresh(): void {
    const panel = this.panel;
    const run = this.run;
    if (panel === undefined || run === null) return;
    const left = this.remaining().length;
    panel.getElementById<UIKit.Text>('review-line')?.setProperties({ text: left > 0 ? `${left} still open.` : 'All clear. Nice work today.' });
    panel
      .getElementById<UIKit.Text>('review-count')
      ?.setProperties({ text: run.done.length > 0 ? `Cleared ${run.done.length} tonight. Flick away anything else you finished.` : 'Flick a finished card away to clear it.' });
    panel.getElementById<UIKit.Text>('review-roll-label')?.setProperties({ text: left === 0 ? 'Done' : left === 1 ? 'Roll 1 to tomorrow' : `Roll ${left} to tomorrow` });
  }

  private ensurePanel(): Promise<void> {
    this.loading ??= (async () => {
      const panel = await this.world.assets.instantiate<UIKitMLAsset>('review');
      panel.name = 'Evening Review';
      panel.scale.setScalar(SCALE);
      panel.visible = false;
      panel.position.set(0, -50, 0);
      this.panel = panel;
      this.entity = this.world.createTransformEntity(panel, { parent: this.world.sceneEntity, persistent: true });
      this.entity.object3D!.name = 'Evening Review';
      this.entity.addComponent(RayInteractable);
      this.entity.addComponent(PokeInteractable);
      panel.requireElementById('review-roll').addEventListener('click', () => this.roll());
      panel.requireElementById('review-later').addEventListener('click', () => this.later());
    })();
    return this.loading;
  }

  /** Same spot as the welcome-back card: low, a little left, out of the card arc. */
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
    const a = (-SIDE_DEG * Math.PI) / 180;
    const dir = new Vector3(this.fwd.x * Math.cos(a) - this.fwd.z * Math.sin(a), 0, this.fwd.x * Math.sin(a) + this.fwd.z * Math.cos(a));
    const dist = getSettings().seated ? Math.min(DISTANCE, SEATED_REACH_M - 0.04) : DISTANCE;
    const p = this.head.clone().addScaledVector(dir, dist);
    p.y = this.head.y - DROP;
    this.m.lookAt(this.head, p, new Vector3(0, 1, 0));
    panel.position.copy(p);
    panel.quaternion.copy(new Quaternion().setFromRotationMatrix(this.m));
  }

  /** Everything still open (Today / Unsorted / Before I leave) -> Later, due tomorrow. */
  roll(): boolean {
    const run = this.run;
    if (run === null || run.answered !== null) return false;
    const now = Date.now();
    const left = new Set(this.remaining());
    const plan = rollPlan(this.openCards().filter((c) => left.has(c.id)), now, getReviewStore().due);
    const moved: RollStep[] = [];
    for (const step of plan) {
      if (!setCardCategory(step.id, step.to, 'user')) continue;
      moved.push(step);
      const e = findQuestCard(step.id);
      if (e !== undefined) setQuestCardState(e, 'Rolled to tomorrow');
    }
    const before = getReviewStore();
    saveReviewStore(withRolled(before, moved, now));
    run.rolled = moved;
    if (moved.length > 0) {
      pulseCards(moved.map((m) => m.id), 2400, '#f3c27a');
      pushBuddyUndo('Undo', async () => {
        for (const m of moved) setCardCategory(m.id, m.from, 'api');
        const store = getReviewStore();
        const due = { ...store.due };
        for (const m of moved) delete due[m.id];
        saveReviewStore({ ...store, due });
        return moved.map((m) => m.id);
      });
    }
    announce(moved.length > 0 ? `Rolled ${moved.length} to tomorrow. They'll be in Today when you're back.` : 'Nothing left to roll. Good night.', { ms: 4500 });
    this.log('roll', moved.map((m) => m.id).join(','));
    this.finish('roll');
    return true;
  }

  later(): boolean {
    const run = this.run;
    if (run === null || run.answered !== null) return false;
    saveReviewStore({ ...getReviewStore(), lastDay: dayKey(Date.now()) });
    announce('Okay. I will leave them be tonight.', { ms: 2500 });
    this.log('later');
    this.finish('later');
    return true;
  }

  private finish(how: NonNullable<Run['answered']>): void {
    const run = this.run;
    if (run === null) return;
    if (run.answered === null) run.answered = how;
    if (how !== 'roll' && how !== 'later') saveReviewStore({ ...getReviewStore(), lastDay: dayKey(Date.now()) });
    this.closing = true;
  }

  update(): void {
    const run = this.run;
    const panel = this.panel;
    if (run === null || panel === undefined) return;
    const now = performance.now();
    if (run.answered === null && now - run.startedAt > MAX_OPEN_MS) this.finish('timeout');
    // Open cards glow one after another so the user sees what is left.
    if (run.answered === null && run.glowed < run.open.length) {
      const due = Math.floor((now - run.startedAt - 600) / GLOW_STEP_MS);
      while (run.glowed <= due && run.glowed < run.open.length) {
        pulseCards([run.open[run.glowed]], 1600, '#f3c27a');
        run.glowed += 1;
      }
    }
    const want = this.closing ? 0 : 1;
    const step = 0.08;
    this.opacity = want > this.opacity ? Math.min(1, this.opacity + step) : Math.max(0, this.opacity - step);
    if (Math.abs(this.opacity - this.lastOpacity) > 0.04 || (this.opacity === 0 && this.lastOpacity !== 0) || (this.opacity === 1 && this.lastOpacity !== 1)) {
      this.lastOpacity = this.opacity;
      panel.getElementById('review-root')?.setProperties({ opacity: this.opacity } as never);
    }
    if (this.closing && this.opacity <= 0) {
      panel.visible = false;
      panel.position.set(0, -50, 0);
      this.log('end', run.answered ?? '');
      this.run = null;
      this.closing = false;
    }
  }

  private log(event: string, detail?: string): void {
    this.history.push({ at: Date.now(), event, ...(detail !== undefined ? { detail } : {}) });
    if (this.history.length > 40) this.history.shift();
  }

  private state() {
    const run = this.run;
    return {
      active: run !== null,
      source: run?.source ?? null,
      open: run?.open ?? [],
      done: run?.done ?? [],
      remaining: this.remaining(),
      glowed: run?.glowed ?? 0,
      answered: run?.answered ?? null,
      rolled: run?.rolled.map((r) => ({ ...r })) ?? [],
      visible: this.panel?.visible ?? false,
      opacity: this.opacity,
      position: this.panel?.position.toArray() ?? null,
      history: [...this.history],
      store: JSON.parse(JSON.stringify(getReviewStore())),
    };
  }
}
