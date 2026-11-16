/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Quaternion, Vector3, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { PanelSystem } from './panel.js';
import {
  configureQuestCards,
  createQuestCard,
  QuestCardSystem,
} from './quest-card.js';
import { QuestInputSystem } from './quest-input.js';
import { RobotSystem } from './robot.js';
import { RoomSystem } from './room.js';
import { restoreSavedFocus, SessionSystem } from './session-runtime.js';
import { spawnSlots } from './card-layout.js';
import { SurfaceSystem } from './surfaces.js';
import { QuestCard } from './quest-component.js';

const sceneContainer = document.getElementById('scene-container');
if (!(sceneContainer instanceof HTMLDivElement)) {
  throw new Error('Missing #scene-container');
}

const world = await World.create(sceneContainer, projectOptions);
world.registerSystem(PanelSystem);
world.registerSystem(RobotSystem);
world.registerSystem(RoomSystem);
world.registerSystem(SurfaceSystem);
world.registerSystem(QuestCardSystem);
world.registerSystem(QuestInputSystem);
world.registerSystem(SessionSystem);

configureQuestCards(world);
// A focus timer that was running before a reload resumes on its card.
const restoredTitle = await restoreSavedFocus().catch(() => null);
// Starter cards use the same seated-reach arc as dictated cards. Before XR the
// head pose is unknown, so lay them out for a nominal head and re-arrange them
// around the real head once the session starts (cards the user has not moved).
const starterCards = [
  { title: 'Plan the next milestone', xp: 20 },
  { title: 'Ship one small feature', xp: 35 },
  { title: 'Take a short reset', xp: 10 },
].filter(({ title }) => title !== restoredTitle);
const nominalSlots = spawnSlots(new Vector3(0, 1.6, 0), new Vector3(0, 0, -1));
const starterEntities = await Promise.all(
  starterCards.map(({ title, xp }, index) =>
    createQuestCard({
      title,
      xp,
      position: nominalSlots[index].position,
      quaternion: nominalSlots[index].quaternion,
    }),
  ),
).catch((error: unknown) => {
  console.error('[quest] Failed to create starter cards.', error);
  return [];
});

const head = new Vector3();
const forward = new Vector3();
world.renderer.xr.addEventListener('sessionstart', () => {
  // Wait until the head is tracked (a real pose, not the rig origin).
  const startedAt = performance.now();
  const relayout = () => {
    world.player.head.updateWorldMatrix(true, false);
    world.player.head.getWorldPosition(head);
    if (head.y < 0.5 && performance.now() - startedAt < 5_000) {
      window.setTimeout(relayout, 200);
      return;
    }
    world.player.head.getWorldDirection(forward).negate();
    const slots = spawnSlots(head, forward);
    let slot = 0;
    for (const entity of starterEntities) {
      if (!entity.active || entity.getValue(QuestCard, 'userPlaced')) continue;
      const pose = slots[slot++];
      entity.object3D?.position.copy(pose.position);
      entity.object3D?.quaternion.copy(pose.quaternion as Quaternion);
    }
  };
  window.setTimeout(relayout, 300);
});
