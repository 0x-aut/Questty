/**
 * PR 10: finish a quest physically (see finish-gesture.ts for the rules).
 *
 * Crumple the card in your hand (hold it, close your hand into a fist), press
 * it between two hands, or flick it away with a quick throw: it crumples into
 * a paper ball that arcs onto the trophy shelf, with the same chime, XP,
 * streak and flame flare as the Complete button. An Undo chip (and "undo" by
 * voice) puts the card back exactly where it was.
 *
 * Cost: one shared ball geometry + material (flat-shaded with baked vertex
 * colours, no lights), at most a few balls alive; hand sampling is a couple
 * of world-position reads per frame while a card is held.
 */
import {
  BufferAttribute,
  createSystem,
  Grabbed,
  GrabSystem,
  IcosahedronGeometry,
  InputComponent,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type Entity,
} from '@iwsdk/core';
import { QuestCard, QuestCardTween } from './quest-component.js';
import { setReleaseInterceptor } from './quest-card.js';
import { holdLanding, landingTarget } from './surfaces.js';
import { getBuddyFocusApi } from './session-events.js';
import { announce, pushBuddyUndo } from './announce.js';
import { getSettings } from './settings.js';
import {
  arcPoint,
  curlRatio,
  FIST_HOLD_MS,
  flickVerdict,
  isFist,
  isTwoHandSqueeze,
  SQUEEZE,
  type FlickVerdict,
  type Sample,
  type Vec,
} from './finish-gesture.js';
import { restoreCard, snapCard, type CardSnap } from './buddy/executor.js';

type Hand = 'left' | 'right';
type HeldState = {
  since: number;
  hand: Hand | null;
  fistSince: number | null;
  fist: boolean;
  padSince: number | null;
  gaps: Array<{ t: number; d: number }>;
};
type Ball = { mesh: Mesh; from: Vector3; to: Vector3; startedAt: number; growMs: number; flyMs: number; spin: Vector3; done: boolean };

const SAMPLE_KEEP_MS = 600;
const PAD_HOLD_MS = 300;
const BALL_RADIUS = 0.032;
const MAX_BALLS = 3;
const FINGERS = ['middle-finger', 'ring-finger', 'pinky-finger'] as const;

let ballGeometry: IcosahedronGeometry | undefined;
let ballMaterial: MeshBasicMaterial | undefined;

/** A crumpled paper ball: a jittered icosahedron with baked flat shading. */
function paperBall(): { geometry: IcosahedronGeometry; material: MeshBasicMaterial } {
  if (ballGeometry !== undefined && ballMaterial !== undefined) return { geometry: ballGeometry, material: ballMaterial };
  const g = new IcosahedronGeometry(BALL_RADIUS, 1).toNonIndexed() as IcosahedronGeometry;
  const pos = g.getAttribute('position');
  // Deterministic dents keyed by the vertex position (shared corners move together).
  const dent = (x: number, y: number, z: number): number => {
    const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return 0.78 + (h - Math.floor(h)) * 0.34;
  };
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = dent(+x.toFixed(4), +y.toFixed(4), +z.toFixed(4));
    pos.setXYZ(i, x * k, y * k * 0.92, z * k);
  }
  g.computeVertexNormals();
  const colors = new Float32Array(pos.count * 3);
  const light = new Vector3(0.4, 0.85, 0.35).normalize();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    const n = b.sub(a).cross(c.sub(a)).normalize();
    const shade = 0.62 + 0.38 * Math.max(0, n.dot(light));
    for (let j = 0; j < 3; j += 1) {
      colors[(i + j) * 3] = 0.97 * shade;
      colors[(i + j) * 3 + 1] = 0.95 * shade;
      colors[(i + j) * 3 + 2] = 0.9 * shade;
    }
  }
  g.setAttribute('color', new BufferAttribute(colors, 3));
  ballGeometry = g;
  ballMaterial = new MeshBasicMaterial({ vertexColors: true, name: 'Paper Ball' });
  return { geometry: g, material: ballMaterial };
}

export type FinishLog = { at: number; how: 'crumple' | 'squeeze' | 'flick' | 'pad'; title: string; xp: number };

export class PhysicalFinishSystem extends createSystem({
  held: { required: [QuestCard, Grabbed] },
}) {
  private readonly heldState = new Map<Entity, HeldState>();
  private readonly samples: Record<Hand, Sample[]> = { left: [], right: [] };
  private readonly balls: Ball[] = [];
  private readonly finishes: FinishLog[] = [];
  private readonly verdicts: Array<FlickVerdict & { title: string; at: number }> = [];
  private readonly ratios: Record<Hand, number> = { left: Infinity, right: Infinity };
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpQ = new Quaternion();
  private lastSampleAt = 0;
  private grab: GrabSystem | undefined;
  /**
   * Dev only: a stepped gesture clock (ms per rendered frame). Software GL in
   * the emulator draws a frame every second or so, which makes every hand
   * speed look tiny; the harness steps this clock at a real headset's frame
   * time instead. Null: the wall clock (always, in production).
   */
  private stepMs: number | null = null;
  private virtualNow = 0;
  private clock(): number {
    return this.stepMs === null ? performance.now() : this.virtualNow;
  }

  init(): void {
    this.queries.held.subscribe('qualify', (e) => {
      this.heldState.set(e, { since: this.clock(), hand: null, fistSince: null, fist: false, padSince: null, gaps: [] });
    });
    setReleaseInterceptor((e) => this.onRelease(e));
    this.cleanupFuncs.push(() => {
      setReleaseInterceptor(undefined);
      for (const b of this.balls) b.mesh.removeFromParent();
    });
    if (import.meta.env.DEV) {
      const w = window as unknown as { __questty?: Record<string, unknown> };
      w.__questty = {
        ...w.__questty,
        finish: {
          state: () => ({
            held: [...this.heldState.entries()].map(([e, s]) => ({
              title: e.active ? (e.getValue(QuestCard, 'title') as string) : '',
              hand: s.hand,
              fist: s.fist,
              fistSince: s.fistSince,
              heldMs: Math.round(this.clock() - s.since),
            })),
            ratios: { ...this.ratios },
            finishes: [...this.finishes],
            verdicts: [...this.verdicts],
            balls: this.balls.map((b) => ({ at: b.mesh.position.toArray(), done: b.done, visible: b.mesh.visible })),
            samples: { left: this.samples.left.length, right: this.samples.right.length },
          }),
          verdict: (samples: Sample[], head: Vec, heldMs: number, over: boolean) => flickVerdict(samples, head, heldMs, over),
          setClock: (stepMs: number | null) => {
            this.virtualNow = performance.now();
            this.stepMs = stepMs;
            this.samples.left.length = 0;
            this.samples.right.length = 0;
          },
          recentSamples: () => ({ left: [...this.samples.left], right: [...this.samples.right] }),
        },
      };
    }
  }

  private grabSystem(): GrabSystem | undefined {
    this.grab ??= this.world.getSystem(GrabSystem) as GrabSystem | undefined;
    return this.grab;
  }

  update(): void {
    if (this.stepMs !== null) this.virtualNow += this.stepMs;
    const now = this.clock();
    if (this.queries.held.entities.size > 0 || now - this.lastSampleAt < SAMPLE_KEEP_MS) {
      if (this.queries.held.entities.size > 0) this.lastSampleAt = now;
      this.sampleHands(now);
    } else if (this.samples.left.length + this.samples.right.length > 0) {
      this.samples.left.length = 0;
      this.samples.right.length = 0;
    }
    for (const e of [...this.heldState.keys()]) {
      if (!e.active || !e.hasComponent(Grabbed)) this.heldState.delete(e);
    }
    for (const e of this.queries.held.entities) {
      const s = this.heldState.get(e);
      if (s === undefined || e.hasComponent(QuestCardTween)) continue;
      const hand = this.grabSystem()?.getHolderHand(e) ?? null;
      if (hand !== null) s.hand = hand;
      if (s.hand === null) continue;
      // 1. A fist while holding the card: crumple it.
      const ratio = this.ratios[s.hand];
      const fist = Number.isFinite(ratio) && isFist(ratio, s.fist);
      if (fist && !s.fist) s.fistSince = now;
      if (!fist) s.fistSince = null;
      s.fist = fist;
      if (fist && s.fistSince !== null && now - s.fistSince >= FIST_HOLD_MS && now - s.since > 150) {
        this.finish(e, 'crumple', null);
        continue;
      }
      // 2. Controller: holding the card, squeeze both trigger and grip on that controller.
      const pad = this.input.xr.gamepads[s.hand];
      if (pad !== undefined && pad !== null) {
        const both = pad.getButtonPressed(InputComponent.Trigger) && pad.getButtonPressed(InputComponent.Squeeze);
        if (both) s.padSince ??= now;
        else s.padSince = null;
        if (s.padSince !== null && now - s.padSince >= PAD_HOLD_MS && now - s.since > 400) {
          this.finish(e, 'pad', null);
          continue;
        }
      }
      // 3. Two hands pressing it together (never in one-handed mode).
      if (!getSettings().oneHanded && this.twoHandSqueeze(e, s, now)) {
        this.finish(e, 'squeeze', null);
      }
    }
    this.updateBalls(performance.now());
  }

  // ------------------------------------------------------------ hands

  private sampleHands(now: number): void {
    const player = this.world.player;
    for (const hand of ['left', 'right'] as const) {
      const space = player.gripSpaces[hand];
      space.getWorldPosition(this.tmpA);
      const list = this.samples[hand];
      const last = list[list.length - 1];
      if (last === undefined || now - last.t > 1) list.push({ t: now, p: [this.tmpA.x, this.tmpA.y, this.tmpA.z] });
      while (list.length > 0 && now - list[0].t > SAMPLE_KEEP_MS) list.shift();
    }
    this.readCurl();
  }

  /** Finger curl from the XR hand joints (hand tracking only; controllers stay at Infinity). */
  private readCurl(): void {
    this.ratios.left = Infinity;
    this.ratios.right = Infinity;
    const xr = this.world.renderer.xr;
    const frame = xr.getFrame?.();
    const session = xr.getSession?.();
    const ref = xr.getReferenceSpace?.();
    if (frame == null || session == null || ref == null || typeof frame.getJointPose !== 'function') return;
    for (const source of session.inputSources) {
      const hand = source.hand;
      if (hand == null || (source.handedness !== 'left' && source.handedness !== 'right')) continue;
      const wristSpace = hand.get('wrist');
      if (wristSpace === undefined) continue;
      const wrist = frame.getJointPose(wristSpace, ref);
      if (wrist == null) continue;
      const w: Vec = [wrist.transform.position.x, wrist.transform.position.y, wrist.transform.position.z];
      const knuckles: Vec[] = [];
      const tips: Vec[] = [];
      for (const f of FINGERS) {
        const k = hand.get(`${f}-phalanx-proximal` as XRHandJoint);
        const t = hand.get(`${f}-tip` as XRHandJoint);
        if (k === undefined || t === undefined) continue;
        const kp = frame.getJointPose(k, ref);
        const tp = frame.getJointPose(t, ref);
        if (kp == null || tp == null) continue;
        knuckles.push([kp.transform.position.x, kp.transform.position.y, kp.transform.position.z]);
        tips.push([tp.transform.position.x, tp.transform.position.y, tp.transform.position.z]);
      }
      this.ratios[source.handedness] = curlRatio(w, knuckles, tips);
    }
  }

  private twoHandSqueeze(e: Entity, s: HeldState, now: number): boolean {
    const object = e.object3D;
    if (object == null || s.hand === null) return false;
    object.getWorldPosition(this.tmpA);
    const other: Hand = s.hand === 'left' ? 'right' : 'left';
    const player = this.world.player;
    player.gripSpaces[s.hand].getWorldPosition(this.tmpB);
    const holdD = this.tmpB.distanceTo(this.tmpA);
    const holdP = this.tmpB.clone();
    player.gripSpaces[other].getWorldPosition(this.tmpB);
    const otherD = this.tmpB.distanceTo(this.tmpA);
    // The holding hand can sit at the card's edge; the free hand must be on the card too.
    if (otherD > SQUEEZE.onCardM || holdD > SQUEEZE.onCardM * 1.6) {
      s.gaps.length = 0;
      return false;
    }
    s.gaps.push({ t: now, d: holdP.distanceTo(this.tmpB) });
    while (s.gaps.length > 0 && now - s.gaps[0].t > SQUEEZE.windowMs * 1.5) s.gaps.shift();
    return isTwoHandSqueeze(s.gaps);
  }

  /** A release: a flick finishes the card instead of pinning/floating it. */
  private onRelease(e: Entity): boolean {
    const s = this.heldState.get(e);
    this.heldState.delete(e);
    if (s === undefined || s.hand === null || !e.active || e.hasComponent(QuestCardTween)) return false;
    const cardId = e.getValue(QuestCard, 'cardId') as string;
    // Copy the head position out now: sampleHands() below reuses tmpA for the hand, and a head read
    // through the shared vector would be the hand itself (away-from-you then always passes).
    const h = this.world.player.head.getWorldPosition(this.tmpA);
    const head: Vec = [h.x, h.y, h.z];
    // Fresh sample at the release itself (this frame's time: a stepped dev clock only advances in update()).
    const now = this.stepMs === null ? performance.now() : this.virtualNow + this.stepMs;
    this.sampleHands(now);
    // Pinning always wins: a release over a surface (or a fast drop onto one) is never a flick,
    // and the release then pins it there.
    const landing = landingTarget(e, this.world.player.gripSpaces[s.hand].getWorldPosition(new Vector3()));
    const verdict = flickVerdict(this.samples[s.hand], head, now - s.since, landing !== null);
    if (landing !== null) holdLanding(cardId, landing);
    this.verdicts.push({ ...verdict, title: e.getValue(QuestCard, 'title') as string, at: Date.now() });
    if (this.verdicts.length > 40) this.verdicts.shift();
    if (!verdict.flick) return false;
    const list = this.samples[s.hand];
    const a = list[list.length - 2];
    const b = list[list.length - 1];
    const v = a && b ? new Vector3(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]).multiplyScalar(1000 / Math.max(1, b.t - a.t)) : null;
    return this.finish(e, 'flick', v);
  }

  // ------------------------------------------------------------ finish + undo

  private finish(e: Entity, how: FinishLog['how'], velocity: Vector3 | null): boolean {
    const api = getBuddyFocusApi();
    if (api === undefined || !e.active || e.hasComponent(QuestCardTween)) return false;
    const snap: CardSnap | null = snapCard(e);
    const object = e.object3D;
    const from = object != null ? object.getWorldPosition(new Vector3()) : null;
    const focusBefore = api.snapshot();
    const wasFocus = snap !== null && focusBefore?.cardId === snap.id ? focusBefore : null;
    const xp = api.complete(e, 'crumple');
    // Let go of it (the crumple tween is already on, so the release neither pins nor floats it).
    if (e.hasComponent(Grabbed)) this.grabSystem()?.forceRelease(e);
    if (snap === null) return true;
    this.finishes.push({ at: Date.now(), how, title: snap.title, xp });
    if (from !== null && !getSettings().reducedMotion) this.throwBall(from, velocity);
    let undone = false;
    const undo = async (): Promise<string[]> => {
      if (undone) return [];
      undone = true;
      api.revokeXp(xp);
      const back = await restoreCard(snap);
      const id = back.getValue(QuestCard, 'cardId') as string;
      if (wasFocus !== null) api.restore({ ...wasFocus, cardId: id });
      announce(`Put "${short(snap.title)}" back.`, { ms: 2500 });
      return [id];
    };
    pushBuddyUndo('Undo', undo);
    const verb = how === 'flick' ? 'Tossed' : 'Crumpled';
    announce(`${verb} "${short(snap.title)}". Done, +${xp} XP.`, { ms: 6500, chips: [{ label: 'Undo', kind: 'plain', run: () => void undo() }] });
    return true;
  }

  // ------------------------------------------------------------ paper ball

  private throwBall(from: Vector3, velocity: Vector3 | null): void {
    const api = getBuddyFocusApi();
    const shelf = api?.shelfPoint?.() ?? [0.65, 1.12, -1.2];
    let ball = this.balls.find((b) => b.done);
    if (ball === undefined && this.balls.length < MAX_BALLS) {
      const { geometry, material } = paperBall();
      const mesh = new Mesh(geometry, material);
      mesh.name = 'Paper Ball';
      mesh.raycast = () => undefined;
      this.world.scene.add(mesh);
      ball = { mesh, from: new Vector3(), to: new Vector3(), startedAt: 0, growMs: 260, flyMs: 760, spin: new Vector3(), done: true };
      this.balls.push(ball);
    }
    ball ??= this.balls[0];
    ball.from.copy(from);
    // A flick carries the ball a little along the throw before it turns for the shelf.
    if (velocity !== null) ball.from.addScaledVector(velocity, 0.05);
    ball.to.set(shelf[0], shelf[1] + 0.02, shelf[2]);
    ball.startedAt = performance.now();
    ball.spin.set(4 + Math.random() * 3, 3 + Math.random() * 3, 2);
    ball.done = false;
    ball.mesh.visible = true;
    ball.mesh.position.copy(from);
    ball.mesh.scale.setScalar(0.01);
  }

  private updateBalls(now: number): void {
    for (const b of this.balls) {
      if (b.done) continue;
      const t = now - b.startedAt;
      if (t < b.growMs) {
        // 1. Crumpling: the ball grows where the card shrinks.
        const k = t / b.growMs;
        b.mesh.scale.setScalar(Math.max(0.01, k * k * (3 - 2 * k)));
        b.mesh.rotation.y += 0.25;
        continue;
      }
      const ft = (t - b.growMs) / b.flyMs;
      if (ft < 1) {
        // 2. The arc onto the shelf.
        b.mesh.scale.setScalar(1);
        const p = arcPoint(b.from.toArray() as Vec, b.to.toArray() as Vec, ft, 0.3);
        b.mesh.position.set(p[0], p[1], p[2]);
        b.mesh.rotation.x += b.spin.x * 0.016;
        b.mesh.rotation.z += b.spin.y * 0.016;
        continue;
      }
      // 3. Landed: a small bounce, then it shrinks away (the shelf keeps the room tidy).
      const lt = (t - b.growMs - b.flyMs) / 900;
      b.mesh.position.copy(b.to);
      b.mesh.position.y += Math.abs(Math.sin(Math.min(1, lt * 2) * Math.PI)) * 0.03 * (1 - lt);
      if (lt > 0.6) b.mesh.scale.setScalar(Math.max(0.01, 1 - (lt - 0.6) / 0.4));
      if (lt >= 1) {
        b.done = true;
        b.mesh.visible = false;
      }
    }
  }
}

function short(t: string): string {
  return t.length > 28 ? `${t.slice(0, 27)}...` : t;
}
