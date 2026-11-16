/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { PanelSystem } from './panel.js';
import { configureQuestCards, QuestCardSystem } from './quest-card.js';
import { QuestInputSystem } from './quest-input.js';
import { RobotSystem } from './robot.js';
import { RoomSystem } from './room.js';
import { restoreSavedFocus, SessionSystem } from './session-runtime.js';
import { SurfaceSystem } from './surfaces.js';
import { CardPersistenceSystem, restoreSavedCards } from './persistence.js';
import { CoachSystem } from './coach.js';
import { CategorySystem } from './categories.js';

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
world.registerSystem(CardPersistenceSystem);
world.registerSystem(CoachSystem);
world.registerSystem(CategorySystem);

configureQuestCards(world);
// The room starts empty for a new user: cards appear only after they speak or
// pick an option. A returning user gets their saved cards back where they left
// them (persistence.ts), and a focus timer that was running resumes on its card.
await restoreSavedCards().catch((error: unknown) => {
  console.error('[persist] Restoring saved cards failed.', error);
  return 0;
});
await restoreSavedFocus().catch(() => null);
