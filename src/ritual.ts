/**
 * PR 10: the return ritual (rules in ritual-logic.ts).
 *
 * Opening the app on a new day or after 4+ hours away: once you are in the
 * room, a small welcome card appears low and a little to the left (never in the way,
 * no frost, nothing blocked) and the buddy says what's waiting. The cards due
 * today glow one after another. Cards from an earlier day that are not in
 * Today get one pinch to roll into Today (or leave them). It is gone in under
 * 10 seconds by itself; Skip ends it at once.
 */
import { createSystem, Matrix4, PokeInteractable, Quaternion, RayInteractable, UIKit, UIKitMLAsset, Vector3, type Entity } from '@iwsdk/core';
import { QuestCard, QuestCardTween } from './quest-component.js';
import { categoryCounts, pulseCards, setCardCategory } from './categories.js';
import { getProgress } from './progress.js';
import { dayKey, viewStreak } from './streak.js';
import { announce, pushBuddyUndo } from './announce.js';
import { getSettings, SEATED_REACH_M } from './settings.js';
import { promoteDueCards } from './review.js';
import { scheduledIds, setRitualRunning } from './review-store.js';
import {
  GLOW_STEP_MS,
  LAST_SEEN_KEY,
  MAX_GLOW,
  RITUAL_MS,
  RITUAL_ROLL_MS,
  rolloverCandidates,
  countsLine,
  streakPhrase,
  welcomeLine,
  welcomeReason,
  type RitualCard,
  type WelcomeReason,
} from './ritual-logic.js';

const SCALE = 0.065;
// Nearer than the card arc (0.58-0.86 m), so floating cards never cover it.
const DISTANCE = 0.46;
// Below the card arc's lower edge: it never covers a card, and a pinch-ray from a resting hand up to the cards passes over it.
const DROP = 0.4;
const SIDE_DEG = 16;
/**
 * Dev-only slow clock for the emulator harness (?ritualSlow=8 makes the moment
 * last 8x longer in wall time; software rendering screenshots take seconds).
 */
const SLOW = (() => {
  if (!import.meta.env.DEV) return 1;
  const raw = Number(new URLSearchParams(window.location.search).get('ritualSlow'));
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
})();
const clock = (): number => performance.now() / SLOW;
const FADE_MS = 300;
const SAVE_EVERY_MS = 30_000;

function readLastSeen(): number | null {
  try {
    const raw = localStorage.getItem(LAST_SEEN_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
function writeLastSeen(now = Date.now()): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, String(now));
  } catch {
    // storage off
  }
}

/** Read before anything overwrites it: the "last seen" of the previous visit. */
const previousSeen = readLastSeen();

type Run = {
  reason: WelcomeReason;
  startedAt: number;
  endsAt: number;
  glow: string[];
  glowed: number;
  rollover: RitualCard[];
  answered: 'roll' | 'leave' | 'skip' | 'timeout' | null;
};

export class RitualSystem extends createSystem({
  cards: { required: [QuestCard] },
}) {
  private panel: UIKitMLAsset | undefined;
  private entity: Entity | undefined;
  private loading: Promise<void> | null = null;
  private run: Run | null = null;
  private opacity = 0;
  private lastOpacity = -1;
  private pending: WelcomeReason | null = welcomeReason(previousSeen, Date.now());
  private lastSaved = 0;
  private hiddenAt: number | null = null;
  private readonly history: Array<{ at: number; event: string; detail?: string }> = [];
  private readonly head = new Vector3();
  private readonly fwd = new Vector3();
  private readonly m = new Matrix4();

  init(): void {
    this.lastSaved = Date.now();
    writeLastSeen();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        this.hiddenAt = Date.now();
        writeLastSeen();
      } else {
        // Back after 4+ hours (or a new day) without a reload: greet then too.
        const last = this.hiddenAt ?? readLastSeen();
        const reason = welcomeReason(last, Date.now());
        if (reason !== null && this.run === null) this.pending = reason;
        this.hiddenAt = null;
        writeLastSeen();
      }
    };
    const onHide = () => writeLastSeen();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    const xr = this.world.renderer.xr;
    const onStart = () => {
      // Give saved cards a moment to come back and settle first.
      if (this.pending !== null) window.setTimeout(() => this.maybeStart(), 2500);
    };
    xr.addEventListener('sessionstart', onStart);
    this.cleanupFuncs.push(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      xr.removeEventListener('sessionstart', onStart);
      this.entity?.dispose();
    });
    if (import.meta.env.DEV) {
      const w = window as unknown as { __questty?: Record<string, unknown> };
      w.__questty = {
        ...w.__questty,
        ritual: {
          state: () => this.state(),
          start: (reason: WelcomeReason = 'new-day') => this.start(reason),
          skip: () => this.finish('skip'),
          roll: () => this.roll(),
          leave: () => this.leave(),
          previousSeen: () => previousSeen,
          lastSeen: () => readLastSeen(),
        },
      };
    }
  }

  private maybeStart(): void {
    if (this.pending === null || this.run !== null) return;
    const xrOn = this.world.renderer.xr.isPresenting;
    if (!xrOn) return; // waits for the next session start
    const reason = this.pending;
    this.pending = null;
    void this.start(reason);
  }

  private cards(): RitualCard[] {
    const out: RitualCard[] = [];
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

  async start(reason: WelcomeReason): Promise<boolean> {
    if (this.run !== null) return false;
    const now = Date.now();
    const cards = this.cards();
    const progress = getProgress();
    const view = viewStreak(progress, dayKey(now));
    if (cards.length === 0 && view.streak <= 0) {
      this.log('nothing-to-say');
      return false; // a first-ever or empty room: no ceremony
    }
    // PR 11: cards the evening review rolled to today move into Today first, so they count as today's
    // and are never offered as "from before".
    const promoted = new Set(promoteDueCards(now));
    for (const c of cards) if (promoted.has(c.id)) c.category = 'today';
    const counts = categoryCounts();
    const rollover = rolloverCandidates(cards, now, scheduledIds());
    const glow = cards.filter((c) => c.category === 'today').map((c) => c.id).slice(0, MAX_GLOW);
    this.run = {
      reason,
      startedAt: clock(),
      endsAt: clock() + (rollover.length > 0 ? RITUAL_ROLL_MS : RITUAL_MS),
      glow,
      glowed: 0,
      rollover,
      answered: null,
    };
    setRitualRunning(true);
    this.log('start', `${reason} glow=${glow.length} roll=${rollover.length} promoted=${promoted.size}`);
    await this.ensurePanel();
    const panel = this.panel;
    if (panel === undefined || this.run === null) {
      setRitualRunning(false);
      return false;
    }
    panel.getElementById<UIKit.Text>('ritual-line')?.setProperties({ text: countsLine(counts) });
    panel.getElementById<UIKit.Text>('ritual-streak')?.setProperties({ text: streakPhrase(view.streak, view.status) });
    panel.getElementById<UIKit.Text>('ritual-roll-row')?.setProperties({ display: rollover.length > 0 ? 'flex' : 'none' });
    if (rollover.length > 0) {
      const names = rollover.slice(0, 2).map((c) => `"${c.title.length > 18 ? `${c.title.slice(0, 17)}...` : c.title}"`).join(', ');
      const more = rollover.length > 2 ? ` +${rollover.length - 2}` : '';
      panel
        .getElementById<UIKit.Text>('ritual-roll-text')
        ?.setProperties({ text: `${rollover.length} unfinished from before: ${names}${more}` });
      panel.getElementById<UIKit.Text>('ritual-roll-label')?.setProperties({ text: rollover.length === 1 ? 'Roll into Today' : `Roll ${rollover.length} into Today` });
    }
    this.place();
    this.opacity = 0;
    this.lastOpacity = -1;
    panel.visible = true;
    announce(welcomeLine(reason, counts, view.streak, rollover.length, promoted.size), { tag: 'QUESTTY  -  WELCOME BACK', ms: (this.run.endsAt - this.run.startedAt) * 0.9 });
    // Reduced motion: the Today cards light up together (no sequence).
    if (getSettings().reducedMotion && glow.length > 0) {
      pulseCards(glow, 3200 * SLOW);
      this.run.glowed = glow.length;
    }
    return true;
  }

  private ensurePanel(): Promise<void> {
    this.loading ??= (async () => {
      const panel = await this.world.assets.instantiate<UIKitMLAsset>('ritual');
      panel.name = 'Return Ritual';
      panel.scale.setScalar(SCALE);
      panel.visible = false;
      panel.position.set(0, -50, 0);
      this.panel = panel;
      this.entity = this.world.createTransformEntity(panel, { parent: this.world.sceneEntity, persistent: true });
      this.entity.object3D!.name = 'Return Ritual';
      this.entity.addComponent(RayInteractable);
      this.entity.addComponent(PokeInteractable);
      panel.requireElementById('ritual-skip').addEventListener('click', () => this.finish('skip'));
      panel.requireElementById('ritual-roll').addEventListener('click', () => this.roll());
      panel.requireElementById('ritual-leave').addEventListener('click', () => this.leave());
    })();
    return this.loading;
  }

  /** Low and a little to the left of the eyes, facing them; within reach when seated. */
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
    // Rotate the forward vector toward the user's LEFT (-x when facing -z): out of the line a right hand's
    // pinch-ray takes to the cards, and well inside the home panel (55 deg left), so the two never overlap.
    const a = (-SIDE_DEG * Math.PI) / 180;
    const dir = new Vector3(this.fwd.x * Math.cos(a) - this.fwd.z * Math.sin(a), 0, this.fwd.x * Math.sin(a) + this.fwd.z * Math.cos(a));
    const dist = getSettings().seated ? Math.min(DISTANCE, SEATED_REACH_M - 0.04) : DISTANCE;
    const p = this.head.clone().addScaledVector(dir, dist);
    p.y = this.head.y - DROP;
    this.m.lookAt(this.head, p, new Vector3(0, 1, 0));
    panel.position.copy(p);
    panel.quaternion.copy(new Quaternion().setFromRotationMatrix(this.m));
  }

  private roll(): boolean {
    const run = this.run;
    if (run === null || run.answered !== null || run.rollover.length === 0) return false;
    const before = run.rollover.map((c) => ({ id: c.id, category: c.category }));
    let moved = 0;
    for (const c of run.rollover) if (setCardCategory(c.id, 'today', 'user')) moved += 1;
    pulseCards(run.rollover.map((c) => c.id), 2600);
    pushBuddyUndo('Undo', async () => {
      for (const b of before) setCardCategory(b.id, b.category, 'api');
      return before.map((b) => b.id);
    });
    announce(`Rolled ${moved} into Today.`, { ms: 4000 });
    this.log('roll', String(moved));
    this.finish('roll');
    return true;
  }

  private leave(): boolean {
    const run = this.run;
    if (run === null || run.answered !== null) return false;
    announce('Left them where they are.', { ms: 2500 });
    this.log('leave');
    this.finish('leave');
    return true;
  }

  private finish(how: NonNullable<Run['answered']>): boolean {
    const run = this.run;
    if (run === null) return false;
    if (run.answered === null) run.answered = how;
    run.endsAt = Math.min(run.endsAt, clock());
    if (how === 'skip') this.log('skip');
    return true;
  }

  update(): void {
    const run = this.run;
    const panel = this.panel;
    if (run === null || panel === undefined) return;
    const now = clock();
    // The cards due today glow one after another (reduced motion lit them all at once).
    if (run.answered === null && run.glowed < run.glow.length) {
      const due = Math.floor((now - run.startedAt - 500) / GLOW_STEP_MS);
      while (run.glowed <= due && run.glowed < run.glow.length) {
        pulseCards([run.glow[run.glowed]], 1500 * SLOW);
        run.glowed += 1;
      }
    }
    const want = now < run.endsAt ? 1 : 0;
    const step = 1000 / FADE_MS / 60;
    this.opacity = want > this.opacity ? Math.min(1, this.opacity + step * 2) : Math.max(0, this.opacity - step * 2);
    if (Math.abs(this.opacity - this.lastOpacity) > 0.04 || (this.opacity === 0 && this.lastOpacity !== 0) || (this.opacity === 1 && this.lastOpacity !== 1)) {
      this.lastOpacity = this.opacity;
      panel.getElementById('ritual-root')?.setProperties({ opacity: this.opacity } as never);
    }
    if (want === 0 && this.opacity <= 0) {
      panel.visible = false;
      panel.position.set(0, -50, 0); // out of every pointer's way while hidden
      if (run.answered === null) run.answered = 'timeout';
      this.log('end', run.answered);
      this.run = null;
      setRitualRunning(false);
    }
    if (Date.now() - this.lastSaved > SAVE_EVERY_MS) {
      this.lastSaved = Date.now();
      writeLastSeen();
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
      pending: this.pending,
      reason: run?.reason ?? null,
      msLeft: run === null ? 0 : Math.max(0, Math.round(run.endsAt - clock())),
      totalMs: run === null ? 0 : Math.round(run.endsAt - run.startedAt),
      glow: run?.glow ?? [],
      glowed: run?.glowed ?? 0,
      rollover: run?.rollover.map((c) => c.id) ?? [],
      answered: run?.answered ?? null,
      visible: this.panel?.visible ?? false,
      opacity: this.opacity,
      position: this.panel?.position.toArray() ?? null,
      history: [...this.history],
      lastSeen: readLastSeen(),
      previousSeen,
    };
  }
}
