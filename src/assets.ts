/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetType, defineAssets } from '@iwsdk/core';
import { createFocusDome } from './scene-assets/focus-dome.scene-asset.js';
import {
  createGraphiteCube,
  createGraphiteGem,
  createGraphiteKnot,
  createGraphiteRing,
  createPlinth,
  createStage,
  createStudioFloor,
} from './scene-assets/studio.scene-asset.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;
const uikitml = (fileName: string, name: string) => ({
  url: publicAssetUrl(`ui/${fileName}`),
  type: AssetType.UIKitML,
  name,
});

export default defineAssets({
  'focus-dome': createFocusDome(),
  'studio-floor': createStudioFloor(),
  stage: createStage(),
  plinth: createPlinth(),
  'graphite-cube': createGraphiteCube(),
  'graphite-gem': createGraphiteGem(),
  'graphite-knot': createGraphiteKnot(),
  'graphite-ring': createGraphiteRing(),
  'welcome-panel': uikitml('welcome.uikitml', 'Welcome Panel'),
  'quest-card': uikitml('quest-card.uikitml', 'Quest Card'),
  'focus-action': uikitml('focus-action.uikitml', 'Focus Action'),
  'focus-timer': uikitml('focus-timer.uikitml', 'Focus Timer'),
  'category-chip': uikitml('category-chip.uikitml', 'Category Chip'),
  'category-picker': uikitml('category-picker.uikitml', 'Category Picker'),
  'category-toast': uikitml('category-toast.uikitml', 'Category Toast'),
  'buddy-bubble': uikitml('buddy-bubble.uikitml', 'Buddy Bubble'),
  'label-grab': uikitml('label-grab.uikitml', 'Grab Label'),
  'label-select': uikitml('label-select.uikitml', 'Select Label'),
  'label-spin': uikitml('label-spin.uikitml', 'Spin Label'),
  coach: uikitml('coach.uikitml', 'Coach Mark'),
  // PR 10
  'doc-header': uikitml('doc-header.uikitml', 'Document Header'),
  'doc-close': uikitml('doc-close.uikitml', 'Document Close'),
  ritual: uikitml('ritual.uikitml', 'Return Ritual'),
  settings: uikitml('settings.uikitml', 'Settings Panel'),
  // PR 11
  review: uikitml('review.uikitml', 'Evening Review'),
  'coach-hand': uikitml('coach-hand.uikitml', 'Coach Hand'),
});
