/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { defineComponents } from '@iwsdk/core';
import {
  QuestCard,
  QuestCardTween,
  QuestFocusAction,
  ZoneMarker,
} from './quest-component.js';
import { Robot } from './robot-component.js';

export default defineComponents([
  Robot,
  QuestCard,
  QuestCardTween,
  QuestFocusAction,
  ZoneMarker,
]);
