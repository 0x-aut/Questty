import { createComponent, Types } from '@iwsdk/core';

export const QuestCard = createComponent('QuestCard', {
  cardId: { type: Types.String, default: '' },
  title: { type: Types.String, default: '' },
  xp: { type: Types.Int16, default: 0 },
  zoneId: { type: Types.String, default: '' },
  previousZoneId: { type: Types.String, default: '' },
  previousPosition: { type: Types.Vec3, default: [0, 0, 0] },
});

export const ZoneMarker = createComponent('ZoneMarker', {
  id: { type: Types.String, default: '' },
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
