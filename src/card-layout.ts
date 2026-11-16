import { Matrix4, Quaternion, Vector3 } from '@iwsdk/core';

/** Scale of a floating card (UIKit units -> metres): about 0.23 m x 0.25 m. */
export const FLOAT_CARD_SCALE = 0.09;
/** Card size in UIKit units at scale 1 (matches the card hitbox). */
export const CARD_UNITS_W = 2.6;
export const CARD_UNITS_H = 2.83;
/** Depth of the card's grab hitbox (card units; was 0.5 before PR 5). */
export const CARD_HIT_DEPTH = 0.14;

export type CardPose = { position: Vector3; quaternion: Quaternion };

/**
 * The seated user's "home" facing direction (horizontal), set when the home
 * panel is placed at session start. New cards fan out around it, not around
 * wherever the head happens to look (often down-left at the panel).
 */
const home = new Vector3(0, 0, -1);
let homeSet = false;
export function setHomeForward(forward: Vector3): void {
  home.set(forward.x, 0, forward.z);
  if (home.lengthSq() < 1e-4) home.set(0, 0, -1);
  home.normalize();
  homeSet = true;
}
export function homeForward(fallback: Vector3): Vector3 {
  return homeSet ? home.clone() : fallback.clone();
}

// Seated-reach arc in front of the user. Each layer holds a front row of four
// and a lower row of four, offset half a step so the rows interleave. Slot
// order fills the middle first so three cards sit centre/left/right. The far
// left (about -40 to -70 degrees, low) is kept clear for the home panel
// (panel.ts), so the arc leans right instead of covering it.
const STEP_DEG = 29;
const ROWS: Array<{ drop: number; angles: number[] }> = [
  { drop: 0.3, angles: [0, -STEP_DEG, STEP_DEG, 2 * STEP_DEG] },
  { drop: 0.58, angles: [-STEP_DEG / 2, STEP_DEG / 2, 1.5 * STEP_DEG, 2.5 * STEP_DEG] },
];
const LAYER_RADII = [0.58, 0.72, 0.86];
const SLOT_CLEARANCE = 0.14;

const worldUp = new Vector3(0, 1, 0);
const lookMatrix = new Matrix4();

/**
 * Every spawn slot, nearest first, for a head at `head` looking along the
 * horizontal `forward`. Cards sit 0.58-0.86 m away, 0.30-0.58 m below the
 * eyes, and turn to face the head.
 */
export function spawnSlots(head: Vector3, forward: Vector3): CardPose[] {
  const flat = forward.clone();
  flat.y = 0;
  if (flat.lengthSq() < 1e-4) flat.set(0, 0, -1);
  flat.normalize();
  const slots: CardPose[] = [];
  for (const radius of LAYER_RADII) {
    for (const row of ROWS) {
      for (const angle of row.angles) {
        const a = (angle * Math.PI) / 180;
        // Rotate `flat` about world up by -a (positive angle = to the right).
        const dir = new Vector3(
          flat.x * Math.cos(a) - flat.z * Math.sin(a),
          0,
          flat.x * Math.sin(a) + flat.z * Math.cos(a),
        );
        const position = head.clone().addScaledVector(dir, radius);
        position.y = head.y - row.drop - (radius - LAYER_RADII[0]) * 0.15;
        // Face the head: +Z of the card points at the eyes.
        lookMatrix.lookAt(head, position, worldUp);
        const quaternion = new Quaternion().setFromRotationMatrix(lookMatrix);
        slots.push({ position, quaternion });
      }
    }
  }
  return slots;
}

/**
 * First slot that no existing floating card occupies. `occupied` holds the
 * world positions of cards that are already floating in front of the user.
 */
export function nextFreeSlot(
  head: Vector3,
  forward: Vector3,
  occupied: readonly Vector3[],
): CardPose {
  const slots = spawnSlots(head, forward);
  for (const slot of slots) {
    if (occupied.every((p) => p.distanceTo(slot.position) > SLOT_CLEARANCE)) return slot;
  }
  // Everything is full: stack on the first slot, nudged toward the user.
  return slots[occupied.length % slots.length];
}
