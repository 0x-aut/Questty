import { Vector3, type Entity } from '@iwsdk/core';
import { QuestCard, QuestCardTween } from './quest-component.js';

/** World positions of cards floating in front of the user (not pinned, not completing). */
export function floatingCardPositions(cards: Iterable<Entity>): Vector3[] {
  const out: Vector3[] = [];
  for (const card of cards) {
    if (!card.active || card.hasComponent(QuestCardTween)) continue;
    if ((card.getValue(QuestCard, 'surfaceId') as string).length > 0) continue;
    const object = card.object3D;
    if (object == null) continue;
    object.updateWorldMatrix(true, false);
    out.push(object.getWorldPosition(new Vector3()));
  }
  return out;
}
