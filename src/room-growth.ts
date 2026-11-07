import { Group, type World } from '@iwsdk/core';

type GrowthStep = {
  level: number;
  assetId: 'gallery-set' | 'sideboard-set';
  position: [number, number, number];
  scale: number;
};

const GROWTH_STEPS: GrowthStep[] = [
  { level: 2, assetId: 'gallery-set', position: [-1.45, 0, -2.8], scale: 0.55 },
  { level: 3, assetId: 'sideboard-set', position: [1.3, 0, -3.2], scale: 0.62 },
  { level: 4, assetId: 'gallery-set', position: [-2.45, 0, -4.2], scale: 0.48 },
  { level: 5, assetId: 'sideboard-set', position: [2.7, 0, -4.8], scale: 0.5 },
];

const spawnedByWorld = new WeakMap<World, Set<number>>();
const pendingByWorld = new WeakMap<World, Set<number>>();

/** Add one visible room decoration for every reached level from 2 through 5. */
export async function syncRoomGrowth(world: World, level: number): Promise<void> {
  let spawnedLevels = spawnedByWorld.get(world);
  if (spawnedLevels === undefined) {
    spawnedLevels = new Set<number>();
    spawnedByWorld.set(world, spawnedLevels);
  }
  let pendingLevels = pendingByWorld.get(world);
  if (pendingLevels === undefined) {
    pendingLevels = new Set<number>();
    pendingByWorld.set(world, pendingLevels);
  }
  for (const step of GROWTH_STEPS) {
    if (step.level > level || spawnedLevels.has(step.level) || pendingLevels.has(step.level)) {
      continue;
    }
    pendingLevels.add(step.level);
    try {
      const object = await world.assets.instantiate<Group>(step.assetId);
      object.name = `Room Growth Level ${step.level}`;
      object.position.set(...step.position);
      object.scale.setScalar(step.scale);
      world.createTransformEntity(object);
      spawnedLevels.add(step.level);
    } catch (error) {
      console.warn(`[progress] Room growth for level ${step.level} could not be loaded.`, error);
    } finally {
      pendingLevels.delete(step.level);
    }
  }
}
