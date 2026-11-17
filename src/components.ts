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
  SnapSurface,
} from './quest-component.js';

export default defineComponents([
  QuestCard,
  QuestCardTween,
  QuestFocusAction,
  SnapSurface,
]);
