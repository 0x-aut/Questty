/**
 * PR 11: sound choices and spatial maths (pure: no IWSDK, no Web Audio).
 */

export type AwardSound = 'chime' | 'levelup';

/**
 * Every XP award plays exactly one sound: the chime, or (when the award
 * crossed into a new level) the level-up fanfare INSTEAD of the chime, so a
 * level-up never double-plays.
 */
export function chooseAwardSound(levelBefore: number, levelAfter: number): AwardSound {
  return Number.isFinite(levelAfter) && Number.isFinite(levelBefore) && levelAfter > levelBefore ? 'levelup' : 'chime';
}

export type V3 = { x: number; y: number; z: number };

/**
 * Where a source sits relative to the listener: azimuth in degrees (0 = straight
 * ahead, negative = to the left, positive = right), elevation in degrees and
 * distance. `forward` is the head's look direction (need not be level).
 */
export function relativeDirection(listener: V3, forward: V3, source: V3): { azimuthDeg: number; elevationDeg: number; distance: number } {
  const dx = source.x - listener.x;
  const dy = source.y - listener.y;
  const dz = source.z - listener.z;
  const distance = Math.hypot(dx, dy, dz);
  let fx = forward.x;
  let fz = forward.z;
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl;
  fz /= fl;
  // Right vector of a level head: forward x up.
  const rx = -fz;
  const rz = fx;
  const ahead = dx * fx + dz * fz;
  const right = dx * rx + dz * rz;
  const azimuthDeg = (Math.atan2(right, ahead) * 180) / Math.PI;
  const elevationDeg = distance > 1e-6 ? (Math.asin(Math.max(-1, Math.min(1, dy / distance))) * 180) / Math.PI : 0;
  return { azimuthDeg, elevationDeg, distance };
}

/**
 * Equal-power stereo gains for an azimuth, as a plain stereo stand-in for HRTF
 * (used by the video mix and as a sanity check of the panner's side).
 */
export function stereoGains(azimuthDeg: number): { left: number; right: number } {
  const clamped = Math.max(-90, Math.min(90, azimuthDeg));
  const p = (clamped + 90) / 180; // 0 = hard left, 1 = hard right
  return { left: Math.cos((p * Math.PI) / 2), right: Math.sin((p * Math.PI) / 2) };
}
