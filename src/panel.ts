/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Matrix4, Quaternion, UIKitMLAsset, Vector3, VisibilityState } from '@iwsdk/core';
import { setPlaneDebugVisible } from './room.js';
import { setHomeForward } from './card-layout.js';

/** Where the home panel sits for a seated user: low, to the left, facing the eyes. */
const PANEL_ANGLE_DEG = -55; // negative = to the user's left
const PANEL_DISTANCE = 0.7;
const PANEL_DROP = 0.4;
const PANEL_SCALE = 0.1;

let collapseHandler: ((collapsed: boolean) => void) | undefined;
let collapsedNow = false;

/** Is the home panel shrunk to its pill (where the buddy orb and its bubbles live)? */
export function isWelcomeCollapsed(): boolean {
  return collapsedNow;
}
let pillOpenBlockedUntil = 0;

/**
 * A count chip inside the pill was pinched: that pinch highlights cards and
 * must not also open the panel (the pill's own click sees the same pinch).
 */
export function suppressPillOpen(ms = 400): void {
  pillOpenBlockedUntil = performance.now() + ms;
}

/** Collapse the home panel to its small pill (true) or open it again (false). */
export function setWelcomeCollapsed(collapsed: boolean): void {
  collapseHandler?.(collapsed);
}

/** Debug-only controls (room planes) show with ?debug=1, and never in production. */
const DEBUG_UI = import.meta.env.DEV && new URLSearchParams(window.location.search).has('debug');

export class PanelSystem extends createSystem({}) {
  private collapsed = false;
  private readonly head = new Vector3();
  private readonly forward = new Vector3();
  private readonly lookMatrix = new Matrix4();

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    if (panel == null) return;
    const xrButton = panel.getElementById('xr-button');
    const debugButton = panel.getElementById('room-debug-toggle');
    const debugLabel = panel.getElementById('room-debug-toggle-label');
    const full = panel.getElementById('panel-full');
    const pill = panel.getElementById('panel-pill');
    const collapse = panel.getElementById('panel-collapse');

    const apply = (collapsed: boolean) => {
      this.collapsed = collapsed;
      collapsedNow = collapsed;
      full?.setProperties({ display: collapsed ? 'none' : 'flex' });
      pill?.setProperties({ display: collapsed ? 'flex' : 'none' });
    };
    collapseHandler = apply;
    const onCollapse = () => apply(true);
    const onPill = () => {
      if (performance.now() < pillOpenBlockedUntil) return;
      apply(false);
    };
    collapse?.addEventListener('click', onCollapse);
    pill?.addEventListener('click', onPill);
    this.cleanupFuncs.push(
      () => collapse?.removeEventListener('click', onCollapse),
      () => pill?.removeEventListener('click', onPill),
      () => {
        if (collapseHandler === apply) collapseHandler = undefined;
      },
    );

    if (DEBUG_UI && debugButton != null) {
      debugButton.setProperties({ display: 'flex' });
      let showRoomPlanes = false;
      const toggleRoomPlanes = () => {
        showRoomPlanes = !showRoomPlanes;
        setPlaneDebugVisible(showRoomPlanes);
        debugLabel?.setProperties({ text: showRoomPlanes ? 'Hide room planes' : 'Show room planes' });
      };
      debugButton.addEventListener('click', toggleRoomPlanes);
      this.cleanupFuncs.push(() => debugButton.removeEventListener('click', toggleRoomPlanes));
    }

    if (xrButton == null) return;
    if (!this.world.xrEnabled) {
      xrButton.setProperties({ display: 'none' });
      return;
    }
    const launchXR = () => this.world.launchXR();
    xrButton.addEventListener('click', launchXR);
    // Leaving XR is the headset's own menu (Quest system bar), so the panel has
    // no Exit button; Enter XR only shows on the flat page.
    this.cleanupFuncs.push(
      () => xrButton.removeEventListener('click', launchXR),
      this.world.visibilityState.subscribe((visibilityState) => {
        xrButton.setProperties({ display: visibilityState === VisibilityState.NonImmersive ? 'flex' : 'none' });
      }),
    );

    const xrManager = this.world.renderer.xr;
    const onSessionStart = () => {
      const startedAt = performance.now();
      const place = () => {
        const head = this.world.player.head;
        head.updateWorldMatrix(true, false);
        head.getWorldPosition(this.head);
        if (this.head.y < 0.5 && performance.now() - startedAt < 5_000) {
          window.setTimeout(place, 200);
          return;
        }
        this.placeBeside(panel);
      };
      window.setTimeout(place, 300);
    };
    xrManager.addEventListener('sessionstart', onSessionStart);
    this.cleanupFuncs.push(() => xrManager.removeEventListener('sessionstart', onSessionStart));
  }

  /** Low and to the left of the head, turned to face the eyes, out of the main view. */
  private placeBeside(panel: UIKitMLAsset): void {
    this.world.player.head.getWorldDirection(this.forward).negate();
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-4) this.forward.set(0, 0, -1);
    this.forward.normalize();
    setHomeForward(this.forward);
    const a = (PANEL_ANGLE_DEG * Math.PI) / 180;
    const dir = new Vector3(
      this.forward.x * Math.cos(a) - this.forward.z * Math.sin(a),
      0,
      this.forward.x * Math.sin(a) + this.forward.z * Math.cos(a),
    );
    const position = this.head.clone().addScaledVector(dir, PANEL_DISTANCE);
    position.y = this.head.y - PANEL_DROP;
    // +Z of the panel points at the eyes (panels are single-sided, facing +Z).
    this.lookMatrix.lookAt(this.head, position, new Vector3(0, 1, 0));
    const quaternion = new Quaternion().setFromRotationMatrix(this.lookMatrix);
    const parent = panel.parent;
    if (parent !== null) {
      parent.updateWorldMatrix(true, false);
      parent.worldToLocal(position);
    }
    panel.position.copy(position);
    panel.quaternion.copy(quaternion);
    panel.scale.setScalar(PANEL_SCALE);
  }
}
