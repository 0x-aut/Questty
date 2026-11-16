import { createComponent, Types } from '@iwsdk/core';

export const QuestCard = createComponent('QuestCard', {
  cardId: { type: Types.String, default: '' },
  title: { type: Types.String, default: '' },
  xp: { type: Types.Int16, default: 0 },
  /** Kind of surface the card is pinned to ('wall' | 'desk' | 'door'), or '' when floating. */
  zoneId: { type: Types.String, default: '' },
  /** Stable id of the SnapSurface the card is pinned to, or '' when floating. */
  surfaceId: { type: Types.String, default: '' },
  /** True once the user has moved the card; the spawn layout never moves it again. */
  userPlaced: { type: Types.Boolean, default: false },
  /** Time category (category-config.ts): 'today' | 'later' | 'before-leave' | 'unsorted' | custom id. */
  category: { type: Types.String, default: 'unsorted' },
});

/**
 * A surface quest cards can be pinned to: a wall, a desk/table top, or a door.
 *
 * Frame convention (same as WebXR / IWSDK `XRPlane`): the surface normal is the
 * entity's local +Y and its extent is `width` along local X and `height` along
 * local Z, centred on the entity origin. IWSDK room planes are tagged at
 * runtime from their semantic label; scene nodes can also carry it.
 */
export const SnapSurface = createComponent('SnapSurface', {
  kind: {
    type: Types.Enum,
    enum: { Wall: 'wall', Desk: 'desk', Door: 'door' },
    default: 'wall',
  },
  width: { type: Types.Float32, default: 1, min: 0.1, step: 0.05 },
  height: { type: Types.Float32, default: 1, min: 0.1, step: 0.05 },
  /** 'room' = real/emulated room plane, 'virtual' = fallback, 'scene' = authored. */
  source: { type: Types.String, default: 'scene' },
  surfaceId: { type: Types.String, default: '' },
});

export const QuestCardTween = createComponent('QuestCardTween', {
  startPosition: { type: Types.Vec3, default: [0, 0, 0] },
  targetPosition: { type: Types.Vec3, default: [0, 0, 0] },
  startScale: { type: Types.Vec3, default: [1, 1, 1] },
  targetScale: { type: Types.Vec3, default: [0.02, 0.02, 0.02] },
  startedAt: { type: Types.Float64, default: 0 },
  durationMs: { type: Types.Float32, default: 800 },
});

export const QuestFocusAction = createComponent('QuestFocusAction', {
  cardId: { type: Types.String, default: '' },
  mode: { type: Types.String, default: 'focus' },
});
