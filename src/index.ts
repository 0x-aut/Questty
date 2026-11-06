/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Vector3, World } from '@iwsdk/core';
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
import { SessionSystem } from './session-runtime.js';
import { ZoneSystem } from './zones.js';

const sceneContainer = document.getElementById('scene-container');
if (!(sceneContainer instanceof HTMLDivElement)) {
  throw new Error('Missing #scene-container');
}

const world = await World.create(sceneContainer, projectOptions);
world.registerSystem(PanelSystem);
world.registerSystem(RobotSystem);
world.registerSystem(RoomSystem);
world.registerSystem(ZoneSystem);
world.registerSystem(QuestCardSystem);
world.registerSystem(QuestInputSystem);
world.registerSystem(SessionSystem);

configureQuestCards(world);
const cardRadius = 0.6;
const starterCards = [
  { title: 'Plan the next milestone', xp: 20, angle: -55 },
  { title: 'Ship one small feature', xp: 35, angle: 0 },
  { title: 'Take a short reset', xp: 10, angle: 55 },
];
void Promise.all(
  starterCards.map(({ title, xp, angle }) => {
    const radians = (angle * Math.PI) / 180;
    return createQuestCard({
      title,
      xp,
      position: new Vector3(
        Math.sin(radians) * cardRadius,
        1.35,
        -Math.cos(radians) * cardRadius,
      ),
    });
  }),
).catch((error: unknown) => {
  console.error('[quest] Failed to create starter cards.', error);
});
