import { createSystem, Matrix4, UIKit, UIKitMLAsset, Vector3, type Entity } from '@iwsdk/core';
import { coachSeen, markCoachSeen } from './card-store.js';
import { onCardEvent } from './quest-card.js';
import { QuestCard } from './quest-component.js';
import { allSurfaceInfo, glowSurfaces } from './surfaces.js';
import { homeForward } from './card-layout.js';

/*
 * Placement coach mark. After the first cards appear (and only until the user
 * pins one for the first time, remembered in localStorage) a short tip floats
 * just above the cards, a ghost pointer sweeps from a card toward the nearest
 * desk, and the snap surfaces glow softly. The first pin swaps it for a
 * one-line "it stays here" confirmation next to the pinned card, then it goes.
 */

const TIP_SCALE = 0.09;
const HAND_SCALE = 0.07;
const GLOW_MS = 7_000;
const SWEEP_MS = 1_900;
const CONFIRM_MS = 6_500;

type Phase = 'off' | 'teach' | 'confirm';

export class CoachSystem extends createSystem({
  cards: { required: [QuestCard] },
}) {
  private phase: Phase = 'off';
  private seen = coachSeen();
  private tip: UIKitMLAsset | undefined;
  private hand: UIKitMLAsset | undefined;
  private loading: Promise<void> | undefined;
  private sweepFrom = new Vector3();
  private sweepTo = new Vector3();
  private sweepCard: Entity | undefined;
  private startedAt = 0;
  private confirmUntil = 0;
  private readonly head = new Vector3();
  private readonly forward = new Vector3();
  private readonly tmp = new Vector3();
  private readonly look = new Matrix4();
  private readonly up = new Vector3(0, 1, 0);

  init(): void {
    const off = onCardEvent((type, entity, detail) => {
      if (type === 'created' && !detail.restored && !this.seen && this.phase === 'off') {
        // Let the whole batch spawn first.
        this.phase = 'teach';
        window.setTimeout(() => void this.startTeach(), 700);
      } else if (type === 'pinned') {
        if (!this.seen) {
          this.seen = true;
          markCoachSeen();
          if (this.phase === 'teach' || this.phase === 'off') void this.startConfirm(entity, detail.target?.label);
        }
      }
    });
    if (import.meta.env.DEV) {
      const w = window as unknown as { __questty?: Record<string, unknown> };
      w.__questty = {
        ...w.__questty,
        coach: () => ({
          phase: this.phase,
          seen: this.seen,
          tipVisible: this.tip?.visible ?? false,
          handVisible: this.hand?.visible ?? false,
          title: this.text('coach-title'),
          body: this.text('coach-body'),
          tipAt: this.tip?.position.toArray(),
        }),
      };
    }
    this.cleanupFuncs.push(off, () => {
      this.tip?.removeFromParent();
      this.hand?.removeFromParent();
    });
  }

  update(): void {
    if (this.phase === 'off') return;
    const now = performance.now();
    if (this.phase === 'confirm') {
      if (now >= this.confirmUntil) this.hide();
      return;
    }
    // Teach: sweep the ghost pointer from the card toward the target surface.
    const hand = this.hand;
    if (hand === undefined || this.sweepCard === undefined) return;
    if (!this.sweepCard.active) {
      this.pickSweep();
      return;
    }
    const t = ((now - this.startedAt) % (SWEEP_MS + 700)) / SWEEP_MS;
    if (t > 1) {
      hand.visible = false;
      return;
    }
    hand.visible = true;
    const k = t < 0.18 ? 0 : (t - 0.18) / 0.82; // a short "pinch" hold, then the drag
    const eased = k * k * (3 - 2 * k);
    hand.position.copy(this.sweepFrom).lerp(this.sweepTo, eased);
    hand.position.y += Math.sin(Math.PI * eased) * 0.06;
    hand.scale.setScalar(HAND_SCALE * (t < 0.18 ? 1 - 0.25 * Math.sin((t / 0.18) * Math.PI) : 1));
    this.faceHead(hand);
  }

  private text(id: string): string | undefined {
    const el = this.tip?.getElementById(id) as unknown as { properties?: { peek?: () => { text?: string } } } | undefined;
    return el?.properties?.peek?.()?.text;
  }

  private async ensureObjects(): Promise<boolean> {
    if (this.tip !== undefined && this.hand !== undefined) return true;
    this.loading ??= (async () => {
      const [tip, hand] = await Promise.all([
        this.world.assets.instantiate<UIKitMLAsset>('coach'),
        this.world.assets.instantiate<UIKitMLAsset>('coach-hand'),
      ]);
      tip.name = 'Coach Mark';
      hand.name = 'Coach Hand';
      tip.scale.setScalar(TIP_SCALE);
      hand.scale.setScalar(HAND_SCALE);
      tip.visible = false;
      hand.visible = false;
      // Overlays: never block a pinch-ray aimed at the cards behind them.
      tip.raycast = () => undefined;
      hand.raycast = () => undefined;
      tip.traverse((o) => (o.raycast = () => undefined));
      hand.traverse((o) => (o.raycast = () => undefined));
      this.world.createTransformEntity(tip);
      this.world.createTransformEntity(hand);
      this.tip = tip;
      this.hand = hand;
    })().catch((error: unknown) => {
      console.warn('[coach] Could not load the coach mark.', error);
      this.loading = undefined;
    });
    await this.loading;
    return this.tip !== undefined && this.hand !== undefined;
  }

  private async startTeach(): Promise<void> {
    if (this.seen || !(await this.ensureObjects()) || this.phase !== 'teach') return;
    const tip = this.tip!;
    this.setText('Put your quests in the room', 'Pinch a card and drag it onto a wall, desk or door.', 'hand');
    // Just above the floating arc, a little below eye level, straight ahead.
    this.readHead();
    tip.position.copy(this.head).addScaledVector(this.forward, 0.62);
    tip.position.y = this.head.y - 0.06;
    this.faceHead(tip);
    tip.visible = true;
    glowSurfaces(GLOW_MS);
    this.pickSweep();
    this.startedAt = performance.now();
  }

  /** Sweep from the floating card nearest the view centre toward the closest desk (else any surface). */
  private pickSweep(): void {
    this.readHead();
    let best: Entity | undefined;
    let bestScore = Infinity;
    for (const card of this.queries.cards.entities) {
      if ((card.getValue(QuestCard, 'zoneId') as string).length > 0) continue;
      const o = card.object3D;
      if (o == null) continue;
      o.getWorldPosition(this.tmp);
      const score = this.tmp.clone().sub(this.head).normalize().dot(this.forward);
      if (-score < bestScore) {
        bestScore = -score;
        best = card;
      }
    }
    this.sweepCard = best;
    if (best === undefined) {
      if (this.hand) this.hand.visible = false;
      return;
    }
    best.object3D!.getWorldPosition(this.sweepFrom);
    this.sweepFrom.addScaledVector(this.tmp.copy(this.head).sub(this.sweepFrom).normalize(), 0.03);
    const surfaces = allSurfaceInfo();
    let target: Vector3 | undefined;
    let targetScore = Infinity;
    for (const s of surfaces) {
      const ahead = this.tmp.copy(s.origin).sub(this.head).setY(0).normalize().dot(this.forward) > 0.2;
      const score = s.origin.distanceTo(this.head) + (s.kind === 'desk' ? 0 : 1.5) + (ahead ? 0 : 10);
      if (score < targetScore) {
        targetScore = score;
        target = s.origin;
      }
    }
    // Head most of the way there, so the motion reads as "drag it over there".
    const goal = target ?? this.sweepFrom.clone().add(new Vector3(0, -0.4, -0.6));
    this.sweepTo.copy(this.sweepFrom).lerp(goal, 0.55);
  }

  private async startConfirm(card: Entity, label: string | undefined): Promise<void> {
    if (!(await this.ensureObjects())) return;
    this.phase = 'confirm';
    this.hand!.visible = false;
    const tip = this.tip!;
    const where = label ? label.toLowerCase() : 'surface';
    this.setText(`Pinned to the ${where}`, 'It stays right here, even after you leave. Pinch Start focus to begin.', 'pin');
    const o = card.object3D;
    if (o != null) {
      o.updateWorldMatrix(true, false);
      o.getWorldPosition(this.tmp);
      this.readHead();
      // Just above the pinned card, nudged toward the user.
      this.readHead();
      tip.position.copy(this.tmp).lerp(this.head, 0.12);
      tip.position.y += 0.06 + 1.6 * o.scale.x;
    }
    this.faceHead(tip);
    tip.visible = true;
    this.confirmUntil = performance.now() + CONFIRM_MS;
  }

  private hide(): void {
    this.phase = 'off';
    if (this.tip) this.tip.visible = false;
    if (this.hand) this.hand.visible = false;
  }

  private setText(title: string, body: string, icon: 'hand' | 'pin'): void {
    const tip = this.tip;
    if (tip === undefined) return;
    tip.getElementById<UIKit.Text>('coach-title')?.setProperties({ text: title });
    tip.getElementById<UIKit.Text>('coach-body')?.setProperties({ text: body });
    tip.getElementById<UIKit.Text>('coach-icon-hand')?.setProperties({ display: icon === 'hand' ? 'flex' : 'none' });
    tip.getElementById<UIKit.Text>('coach-icon-pin')?.setProperties({ display: icon === 'pin' ? 'flex' : 'none' });
  }

  private readHead(): void {
    const head = this.world.player.head;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(this.head);
    head.getWorldDirection(this.forward).negate();
    this.forward.copy(homeForward(this.forward));
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-4) this.forward.set(0, 0, -1);
    this.forward.normalize();
  }

  private faceHead(object: UIKitMLAsset): void {
    this.world.player.head.getWorldPosition(this.head);
    this.look.lookAt(this.head, object.position, this.up);
    object.quaternion.setFromRotationMatrix(this.look);
  }
}
