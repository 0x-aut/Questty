/**
 * PR 11: keeps the Web Audio listener on the head and the buddy's panner on
 * the buddy orb, every frame, so the buddy's voice (talk mode) and its cue
 * sound come from where the orb is in the room and follow it as it moves.
 * No allocation per frame.
 */
import { createSystem, Vector3, type Object3D } from '@iwsdk/core';
import { updateSpatial } from './sfx.js';

let source: Object3D | undefined;
/** BuddySystem hands over the orb's group once it exists. */
export function setBuddySoundSource(object: Object3D | undefined): void {
  source = object;
}

export class SpatialAudioSystem extends createSystem({}) {
  private readonly head = new Vector3();
  private readonly fwd = new Vector3();
  private readonly up = new Vector3();
  private readonly orb = new Vector3();
  private readonly last = new Vector3(NaN, NaN, NaN);
  private readonly lastFwd = new Vector3(NaN, NaN, NaN);
  private readonly lastOrb = new Vector3(NaN, NaN, NaN);

  update(): void {
    const head = this.world.player.head;
    if (source === undefined) return;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(this.head);
    // The head looks down its local -Z.
    head.getWorldDirection(this.fwd).negate();
    this.up.set(0, 1, 0).transformDirection(head.matrixWorld);
    source.updateWorldMatrix(true, false);
    source.getWorldPosition(this.orb);
    if (
      this.head.distanceToSquared(this.last) < 1e-8 &&
      this.fwd.distanceToSquared(this.lastFwd) < 1e-8 &&
      this.orb.distanceToSquared(this.lastOrb) < 1e-8
    ) {
      return;
    }
    this.last.copy(this.head);
    this.lastFwd.copy(this.fwd);
    this.lastOrb.copy(this.orb);
    updateSpatial(this.head, this.fwd, this.up, this.orb);
  }
}
