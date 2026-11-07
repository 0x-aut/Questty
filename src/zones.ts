import {
  CanvasTexture,
  createSystem,
  Entity,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { findPlane, onPlanesChanged } from './room.js';
import { ZoneMarker } from './quest-component.js';

export type Zone = {
  id: 'desk' | 'door' | 'wall';
  label: string;
  position: Vector3;
  normal: Vector3;
  width: number;
  height: number;
};

const localMarkerNormal = new Vector3(0, 0, 1);
const worldUp = new Vector3(0, 1, 0);
const zoneClearance = 0.035;
export const MAX_CARDS_PER_ZONE = 6;
const gridSpacingX = 0.58;
const gridSpacingY = 0.4;
const fallbackPosition = {
  desk: new Vector3(0, 0.75, -0.6),
  door: new Vector3(-0.9, 1.1, -1.1),
  wall: new Vector3(0, 1.25, -1.4),
};
const fallbackNormal = {
  desk: new Vector3(0, 1, 0),
  door: new Vector3(0, 0, 1),
  wall: new Vector3(0, 0, 1),
};

let currentZones: Zone[] = [
  fallbackZone('desk', 'Desk'),
  fallbackZone('door', 'Door'),
  fallbackZone('wall', 'Wall'),
];
let activeZoneSystem: ZoneSystem | undefined;
const heldCardIds = new Set<string>();
const viewerPosition = new Vector3();

function fallbackZone(id: Zone['id'], label: string): Zone {
  return {
    id,
    label,
    position: fallbackPosition[id].clone(),
    normal: fallbackNormal[id].clone(),
    width: 1.2,
    height: 1.2,
  };
}

function zoneFromPlane(
  id: Zone['id'],
  label: string,
  kind: 'desk' | 'wall' | 'door',
): Zone {
  const plane = findPlane(kind);
  if (plane === null) return fallbackZone(id, label);
  const normal = plane.normal.clone();
  if (id !== 'desk' && activeZoneSystem !== undefined) {
    activeZoneSystem.getViewerPosition(viewerPosition);
    if (normal.dot(viewerPosition.sub(plane.position)) < 0) normal.negate();
  }
  return {
    id,
    label,
    position: plane.position,
    normal,
    width: plane.width,
    height: plane.height,
  };
}

function recomputeZones(): void {
  if (heldCardIds.size > 0) return;
  currentZones = [
    zoneFromPlane('desk', 'Desk', 'desk'),
    zoneFromPlane('door', 'Door', 'door'),
    zoneFromPlane('wall', 'Wall', 'wall'),
  ];
  activeZoneSystem?.applyZones();
}

export function getZones(): Zone[] {
  return currentZones.map((zone) => ({
    ...zone,
    position: zone.position.clone(),
    normal: zone.normal.clone(),
  }));
}

export function findNearestZone(
  position: Vector3,
  maxDistance: number,
): { zone: Zone; distance: number } | null {
  let nearest: Zone | undefined;
  let nearestDistance = maxDistance;
  for (const zone of currentZones) {
    const distance = zone.position.distanceTo(position);
    if (distance <= nearestDistance) {
      nearest = zone;
      nearestDistance = distance;
    }
  }
  return nearest === undefined
    ? null
    : { zone: getZoneSnapshot(nearest), distance: nearestDistance };
}

export function getZonePlacement(
  id: Zone['id'],
  stackIndex = 0,
): { zone: Zone; position: Vector3; normal: Vector3 } | null {
  const zone = currentZones.find((candidate) => candidate.id === id);
  if (zone === undefined || stackIndex < 0 || stackIndex >= MAX_CARDS_PER_ZONE) return null;
  const normal = zone.normal.clone().normalize();
  const position = zone.position.clone();
  const columns = zone.width >= 1.35 ? 3 : 2;
  const rows = MAX_CARDS_PER_ZONE / columns;
  const column = stackIndex % columns;
  const row = Math.floor(stackIndex / columns);
  const lateral = (column - (columns - 1) / 2) * gridSpacingX;
  const vertical = ((rows - 1) / 2 - row) * gridSpacingY;
  if (Math.abs(normal.y) >= 0.7) {
    position
      .addScaledVector(normal, zoneClearance)
      .add(new Vector3(lateral, 0, vertical));
  } else {
    const right = new Vector3(normal.z, 0, -normal.x).normalize();
    position
      .addScaledVector(normal, zoneClearance)
      .addScaledVector(right, lateral)
      .addScaledVector(worldUp, vertical);
  }
  return { zone: getZoneSnapshot(zone), position, normal };
}

export function beginZoneHold(cardId: string): void {
  heldCardIds.add(cardId);
}

export function endZoneHold(cardId: string): void {
  heldCardIds.delete(cardId);
  if (heldCardIds.size === 0) recomputeZones();
}

function getZoneSnapshot(zone: Zone): Zone {
  return { ...zone, position: zone.position.clone(), normal: zone.normal.clone() };
}

function makeMarker(label: string): Group {
  const marker = new Group();
  const orb = new Mesh(
    new SphereGeometry(0.025, 12, 8),
    new MeshBasicMaterial({
      color: 0x60d8c5,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }),
  );
  const ring = new Mesh(
    new TorusGeometry(0.055, 0.004, 8, 32),
    new MeshBasicMaterial({
      color: 0xb7fff3,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    }),
  );
  marker.add(orb, ring);

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 80;
  const context = canvas.getContext('2d');
  if (context !== null) {
    context.fillStyle = 'rgba(12, 35, 40, 0.78)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#eafffa';
    context.font = 'bold 36px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label.toUpperCase(), canvas.width / 2, canvas.height / 2);
  }
  const texture = new CanvasTexture(canvas);
  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const badge = new Sprite(material);
  badge.position.set(0, 0.055, 0.025);
  badge.scale.set(0.2, 0.0625, 1);
  marker.add(badge);
  return marker;
}

function disposeMarker(entity: Entity): void {
  const object = entity.object3D;
  if (object !== undefined) {
    object.traverse((child) => {
      if (child instanceof Mesh) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        for (const material of materials) material.dispose();
      } else if (child instanceof Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    });
  }
  entity.dispose();
}

/** Keeps the desk, door, and wall drop targets aligned with detected room planes. */
export class ZoneSystem extends createSystem({
  markers: { required: [ZoneMarker] },
}) {
  private readonly worldNormal = new Vector3();
  private readonly rotation = new Quaternion();

  getViewerPosition(target: Vector3): void {
    this.world.player.head.getWorldPosition(target);
  }

  init(): void {
    activeZoneSystem = this;
    for (const zone of [
      fallbackZone('desk', 'Desk'),
      fallbackZone('door', 'Door'),
      fallbackZone('wall', 'Wall'),
    ]) {
      const marker = this.world.createTransformEntity(makeMarker(zone.label));
      marker.object3D!.name = `Zone ${zone.label}`;
      marker.addComponent(ZoneMarker, { id: zone.id });
    }

    const unsubscribe = onPlanesChanged(() => {
      if (heldCardIds.size === 0) recomputeZones();
    });
    this.cleanupFuncs.push(
      unsubscribe,
      () => {
        for (const entity of this.queries.markers.entities) disposeMarker(entity);
        if (activeZoneSystem === this) activeZoneSystem = undefined;
      },
    );
    recomputeZones();
  }

  applyZones(): void {
    for (const entity of this.queries.markers.entities) {
      const id = entity.getValue(ZoneMarker, 'id') as Zone['id'];
      const zone = currentZones.find((candidate) => candidate.id === id);
      const object = entity.object3D;
      if (zone === undefined || object == null) continue;
      this.worldNormal.copy(zone.normal).normalize();
      this.rotation.setFromUnitVectors(localMarkerNormal, this.worldNormal);
      object.position
        .copy(zone.position)
        .addScaledVector(this.worldNormal, 0.012);
      object.quaternion.copy(this.rotation);
    }
  }
}
