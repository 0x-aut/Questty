/**
 * The thin light arc the buddy draws from the orb to each card it touches
 * (PR 6), so the user sees exactly what it acted on. It draws out along a
 * soft upward arc (~0.4 s) with a bright spark at its tip, holds a beat, then
 * fades. Purely visual (no raycast).
 */
import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  QuadraticBezierCurve3,
  SphereGeometry,
  TubeGeometry,
  Vector3,
} from '@iwsdk/core';

/** Dev-only: ?buddySlow=N stretches the buddy's timings for screenshots on slow software GL. */
export const BUDDY_SLOW = (() => {
  if (!import.meta.env.DEV) return 1;
  const n = Number(new URLSearchParams(window.location.search).get('buddySlow'));
  return Number.isFinite(n) && n >= 1 && n <= 20 ? n : 1;
})();
const DRAW_MS = 420 * BUDDY_SLOW;
const HOLD_MS = 650 * BUDDY_SLOW;
const FADE_MS = 550 * BUDDY_SLOW;
const SEGMENTS = 64;
const RADIAL = 6;

type Live = {
  mesh: Mesh;
  geometry: TubeGeometry;
  material: MeshBasicMaterial;
  spark: Mesh;
  sparkMaterial: MeshBasicMaterial;
  curve: QuadraticBezierCurve3;
  start: number;
  cardId: string;
  onArrive?: () => void;
  arrived: boolean;
  info: LineInfo;
};

export type LineInfo = { cardId: string; start: number[]; end: number[]; progress: number; opacity: number };

let sparkGeometry: SphereGeometry | undefined;

export class LightLines {
  readonly group = new Group();
  private readonly live: Live[] = [];
  private readonly history: LineInfo[] = [];

  constructor() {
    this.group.name = 'Buddy Light Lines';
    this.group.userData.iwsdkPreviewBounds = 'exclude';
  }

  /** Draw a line from `from` to `to` (world); `onArrive` fires when it reaches the card. */
  draw(cardId: string, from: Vector3, to: Vector3, color: string, delayMs = 0, onArrive?: () => void): void {
    const mid = from.clone().lerp(to, 0.5);
    const lift = Math.min(0.16, 0.06 + from.distanceTo(to) * 0.18);
    mid.y += lift;
    const curve = new QuadraticBezierCurve3(from.clone(), mid, to.clone());
    const geometry = new TubeGeometry(curve, SEGMENTS, 0.0011, RADIAL, false);
    geometry.setDrawRange(0, 0);
    const material = new MeshBasicMaterial({
      color: new Color(color),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const mesh = new Mesh(geometry, material);
    mesh.name = `Buddy Line ${cardId}`;
    mesh.renderOrder = 14;
    mesh.raycast = () => undefined;
    sparkGeometry ??= new SphereGeometry(1, 16, 12);
    const sparkMaterial = new MeshBasicMaterial({
      color: new Color('#fffaf0'),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const spark = new Mesh(sparkGeometry, sparkMaterial);
    spark.scale.setScalar(0.0045);
    spark.renderOrder = 15;
    spark.raycast = () => undefined;
    spark.visible = false;
    this.group.add(mesh, spark);
    const info: LineInfo = { cardId, start: from.toArray(), end: to.toArray(), progress: 0, opacity: 0 };
    this.history.push(info);
    if (this.history.length > 40) this.history.shift();
    this.live.push({
      info,
      mesh,
      geometry,
      material,
      spark,
      sparkMaterial,
      curve,
      start: performance.now() + delayMs,
      cardId,
      onArrive,
      arrived: false,
    });
  }

  update(now: number): void {
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      const line = this.live[i];
      const t = now - line.start;
      if (t < 0) continue;
      const draw = Math.min(1, t / DRAW_MS);
      const eased = 1 - (1 - draw) ** 3;
      const count = Math.ceil(eased * SEGMENTS) * RADIAL * 6;
      line.geometry.setDrawRange(0, count);
      const fade = t > DRAW_MS + HOLD_MS ? Math.min(1, (t - DRAW_MS - HOLD_MS) / FADE_MS) : 0;
      line.material.opacity = 0.95 * (1 - fade);
      line.spark.visible = draw < 1 || fade < 0.6;
      line.curve.getPoint(eased, line.spark.position);
      line.sparkMaterial.opacity = 0.95 * (1 - fade);
      line.spark.scale.setScalar(0.0045 * (draw < 1 ? 1 : 1 + 0.8 * (1 - fade)));
      line.info.progress = eased;
      line.info.opacity = line.material.opacity;
      if (draw >= 1 && !line.arrived) {
        line.arrived = true;
        line.onArrive?.();
      }
      if (fade >= 1) {
        line.mesh.removeFromParent();
        line.spark.removeFromParent();
        line.geometry.dispose();
        line.material.dispose();
        line.sparkMaterial.dispose();
        this.live.splice(i, 1);
      }
    }
  }

  /** Dev/test view: lines drawn recently (and how far each got). */
  recent(): LineInfo[] {
    return this.history.map((h) => ({ ...h }));
  }

  get active(): number {
    return this.live.length;
  }
}
