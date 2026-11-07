import {
  BufferGeometry,
  BoxGeometry,
  CanvasTexture,
  createSystem,
  DoubleSide,
  Entity,
  Group,
  Line,
  LineBasicMaterial,
  LocomotionEnvironment,
  LocomotionSystem,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Shape,
  ShapeGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  XRPlane,
} from '@iwsdk/core';

export type RoomPlane = {
  id: string;
  label: string;
  orientation: 'horizontal' | 'vertical';
  position: Vector3;
  normal: Vector3;
  width: number;
  height: number;
};

type DetectedPlane = {
  orientation: 'horizontal' | 'vertical';
  semanticLabel?: string;
  polygon: readonly { x: number; z: number }[];
};

type PlaneOverlay = {
  group: Group;
  entity?: Entity;
  fillGeometry: ShapeGeometry;
  outlineGeometry: BufferGeometry;
  fillMaterial: MeshBasicMaterial;
  outlineMaterial: LineBasicMaterial;
  labelTexture: CanvasTexture;
  labelMaterial: SpriteMaterial;
};

const planeIds = new WeakMap<object, string>();
const planeSubscribers = new Set<(planes: RoomPlane[]) => void>();
const debugOverlays = new Set<PlaneOverlay>();
const overlaysByEntity = new WeakMap<Entity, PlaneOverlay>();
const activeRoomSystems = new Set<RoomSystem>();
const seenLabels = new Set<string>();
const localPlaneNormal = new Vector3(0, 1, 0);
let nextPlaneId = 1;
let currentPlanes: RoomPlane[] = [];
let debugVisible = false;
let labelsLogged = false;
let statusLogged = false;

function stableId(plane: object): string {
  let id = planeIds.get(plane);
  if (id === undefined) {
    id = `room-plane-${nextPlaneId}`;
    nextPlaneId += 1;
    planeIds.set(plane, id);
  }
  return id;
}

function clonePlanes(planes: RoomPlane[]): RoomPlane[] {
  return planes.map(clonePlane);
}

function clonePlane(plane: RoomPlane): RoomPlane {
  return {
    ...plane,
    position: plane.position.clone(),
    normal: plane.normal.clone(),
  };
}

function notifySubscribers(): void {
  for (const subscriber of planeSubscribers) {
    try {
      subscriber(clonePlanes(currentPlanes));
    } catch {
      if (!statusLogged) {
        console.warn('[room] A plane-change subscriber threw; it was ignored.');
        statusLogged = true;
      }
    }
  }
}

function disposeOverlay(overlay: PlaneOverlay): void {
  overlay.entity?.dispose();
  overlay.group.removeFromParent();
  overlay.fillGeometry.dispose();
  overlay.outlineGeometry.dispose();
  overlay.fillMaterial.dispose();
  overlay.outlineMaterial.dispose();
  overlay.labelTexture.dispose();
  overlay.labelMaterial.dispose();
  debugOverlays.delete(overlay);
}

function makeOverlay(
  plane: DetectedPlane,
  label: string,
  width: number,
  height: number,
): PlaneOverlay | null {
  if (plane.polygon.length < 3) return null;

  const shape = new Shape();
  const outlinePoints: Vector3[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < plane.polygon.length; index += 1) {
    const point = plane.polygon[index];
    if (index === 0) shape.moveTo(point.x, point.z);
    else shape.lineTo(point.x, point.z);
    outlinePoints.push(new Vector3(point.x, 0.004, point.z));
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  shape.closePath();

  const fillGeometry = new ShapeGeometry(shape);
  const outlineGeometry = new BufferGeometry().setFromPoints(outlinePoints);
  const fillMaterial = new MeshBasicMaterial({
    color: 0x35c9ff,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    side: DoubleSide,
  });
  const outlineMaterial = new LineBasicMaterial({
    color: 0x35c9ff,
    depthTest: false,
  });
  const group = new Group();
  const fill = new Mesh(fillGeometry, fillMaterial);
  fill.rotation.x = Math.PI / 2;
  fill.position.y = 0.002;
  group.add(fill, new Line(outlineGeometry, outlineMaterial));

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (context === null) {
    fillGeometry.dispose();
    outlineGeometry.dispose();
    fillMaterial.dispose();
    outlineMaterial.dispose();
    return null;
  }
  context.fillStyle = 'rgba(7, 22, 34, 0.82)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff';
  context.font = 'bold 34px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const shownLabel = label || 'unlabeled';
  context.fillText(
    `${shownLabel}  ${width.toFixed(2)} x ${height.toFixed(2)} m`,
    256,
    48,
    492,
  );

  const labelTexture = new CanvasTexture(canvas);
  const labelMaterial = new SpriteMaterial({
    map: labelTexture,
    transparent: true,
    depthTest: false,
  });
  const labelSprite = new Sprite(labelMaterial);
  labelSprite.position.set((minX + maxX) / 2, 0.025, (minZ + maxZ) / 2);
  labelSprite.scale.set(Math.min(Math.max(width, 0.55), 1.5), 0.16, 1);
  group.add(labelSprite);

  const overlay = {
    group,
    fillGeometry,
    outlineGeometry,
    fillMaterial,
    outlineMaterial,
    labelTexture,
    labelMaterial,
  };
  group.visible = debugVisible;
  debugOverlays.add(overlay);
  return overlay;
}

/** Return a snapshot of the currently detected real-room planes. */
export function getPlanes(): RoomPlane[] {
  try {
    return clonePlanes(currentPlanes);
  } catch {
    return [];
  }
}

/** Find a useful horizontal surface, the largest wall, or a labeled door. */
export function findPlane(kind: 'desk' | 'wall' | 'door'): RoomPlane | null {
  try {
    let found: RoomPlane | undefined;
    if (kind === 'desk') {
      found =
        currentPlanes.find((plane) => {
          const label = plane.label.toLowerCase();
          return label.includes('table') || label.includes('desk');
        }) ??
        currentPlanes.find(
          (plane) =>
            plane.orientation === 'horizontal' &&
            plane.position.y >= 0.6 &&
            plane.position.y <= 1.1,
        );
    } else if (kind === 'door') {
      found = currentPlanes.find((plane) => plane.label.toLowerCase().includes('door'));
    } else {
      let largest: RoomPlane | undefined;
      let largestArea = -1;
      for (const plane of currentPlanes) {
        if (plane.orientation !== 'vertical') continue;
        const area = plane.width * plane.height;
        if (area > largestArea) {
          largest = plane;
          largestArea = area;
        }
      }
      found = largest;
    }
    return found === undefined ? null : clonePlane(found);
  } catch {
    return null;
  }
}

/** Subscribe to plane-set changes. The current snapshot is delivered immediately. */
export function onPlanesChanged(cb: (planes: RoomPlane[]) => void): () => void {
  try {
    planeSubscribers.add(cb);
    cb(getPlanes());
  } catch {
    // Consumers must not be able to break room tracking.
  }
  return () => planeSubscribers.delete(cb);
}

/** Enable or hide the developer-only translucent plane overlays. */
export function setPlaneDebugVisible(visible: boolean): void {
  debugVisible = visible;
  for (const system of activeRoomSystems) {
    try {
      system.setDebugVisible(visible);
    } catch {
      if (!statusLogged) {
        console.info('[room] Could not update plane debug overlays.');
        statusLogged = true;
      }
    }
  }
}

/** IWSDK's SceneUnderstandingSystem owns WebXR frames and creates XRPlane entities. */
export class RoomSystem extends createSystem({
  planes: { required: [XRPlane] },
}) {
  private readonly positionBuffer = new Vector3();
  private readonly normalBuffer = new Vector3();
  private readonly quaternionBuffer = new Quaternion();
  private labelLogTimer: number | undefined;
  private noPlaneTimer: number | undefined;
  private fallbackFloorEntity: Entity | undefined;
  private fallbackFloorGeometry: BoxGeometry | undefined;
  private fallbackFloorMaterial: MeshBasicMaterial | undefined;
  private readonly recoveryPosition = new Vector3();

  init(): void {
    this.createFallbackWalkableFloor();
    this.queries.planes.subscribe('qualify', (entity) => this.handlePlaneSetChanged(entity));
    this.queries.planes.subscribe('disqualify', (entity) => {
      this.removeOverlay(entity);
      this.handlePlaneSetChanged();
    });

    const onSessionStart = () => this.handleSessionStart();
    const onSessionEnd = () => {
      this.clearTimers();
      currentPlanes = [];
      notifySubscribers();
    };
    this.xrManager.addEventListener('sessionstart', onSessionStart);
    this.xrManager.addEventListener('sessionend', onSessionEnd);
    activeRoomSystems.add(this);
    this.handlePlaneSetChanged();
    if (this.xrManager.getSession() !== null) this.handleSessionStart();

    this.cleanupFuncs.push(
      () => this.xrManager.removeEventListener('sessionstart', onSessionStart),
      () => this.xrManager.removeEventListener('sessionend', onSessionEnd),
      () => this.clearTimers(),
      () => {
        activeRoomSystems.delete(this);
        for (const entity of this.queries.planes.entities) this.removeOverlay(entity);
        this.fallbackFloorEntity?.dispose();
        this.fallbackFloorEntity = undefined;
        this.fallbackFloorGeometry?.dispose();
        this.fallbackFloorGeometry = undefined;
        this.fallbackFloorMaterial?.dispose();
        this.fallbackFloorMaterial = undefined;
        currentPlanes = [];
        notifySubscribers();
      },
    );
  }

  private createFallbackWalkableFloor(): void {
    const floor = new Mesh(
      new BoxGeometry(200, 0.1, 200),
      new MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        colorWrite: false,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    floor.name = 'Questty Walkable Floor';
    floor.position.y = -0.05;
    this.fallbackFloorGeometry = floor.geometry as BoxGeometry;
    this.fallbackFloorMaterial = floor.material as MeshBasicMaterial;
    this.fallbackFloorEntity = this.world.createTransformEntity(floor);
    this.fallbackFloorEntity.addComponent(LocomotionEnvironment);
  }

  private recoverFallenPlayer(): void {
    const locomotion = this.world.getSystem(LocomotionSystem);
    if (locomotion == null || this.world.player.position.y >= -5) return;
    this.recoveryPosition.set(
      this.world.player.position.x,
      0,
      this.world.player.position.z,
    );
    locomotion.setPlayerPosition(this.recoveryPosition);
  }

  setDebugVisible(visible: boolean): void {
    for (const entity of this.queries.planes.entities) {
      try {
        if (!visible) {
          this.removeOverlay(entity);
          continue;
        }
        const plane = entity.getValue(XRPlane, '_plane') as unknown as DetectedPlane | undefined;
        if (plane === undefined || overlaysByEntity.has(entity)) continue;
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const point of plane.polygon) {
          minX = Math.min(minX, point.x);
          maxX = Math.max(maxX, point.x);
          minZ = Math.min(minZ, point.z);
          maxZ = Math.max(maxZ, point.z);
        }
        this.createOverlay(
          entity,
          plane,
          Number.isFinite(minX) ? maxX - minX : 0,
          Number.isFinite(minZ) ? maxZ - minZ : 0,
        );
      } catch {
        this.logStatusOnce('[room] Could not draw a plane debug overlay.');
      }
    }
  }

  private handleSessionStart(): void {
    this.clearTimers();
    try {
      const enabledFeatures = this.xrManager.getSession()?.enabledFeatures;
      if (!enabledFeatures?.includes('plane-detection')) {
        this.logStatusOnce('[room] Plane detection is unsupported or was not enabled.');
        return;
      }
      this.noPlaneTimer = window.setTimeout(() => {
        this.noPlaneTimer = undefined;
        if (currentPlanes.length === 0) {
          this.logStatusOnce('[room] Plane detection is enabled, but no room planes appeared.');
        }
      }, 5000);
    } catch {
      this.logStatusOnce('[room] Could not inspect plane-detection support.');
    }
  }

  private handlePlaneSetChanged(qualifiedEntity?: Entity): void {
    try {
      const next: RoomPlane[] = [];
      for (const entity of this.queries.planes.entities) {
        const plane = entity.getValue(XRPlane, '_plane') as unknown as DetectedPlane | undefined;
        const object = entity.object3D;
        if (plane === undefined || object == null) continue;

        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const point of plane.polygon) {
          minX = Math.min(minX, point.x);
          maxX = Math.max(maxX, point.x);
          minZ = Math.min(minZ, point.z);
          maxZ = Math.max(maxZ, point.z);
        }
        const width = Number.isFinite(minX) ? maxX - minX : 0;
        const height = Number.isFinite(minZ) ? maxZ - minZ : 0;
        object.updateWorldMatrix(true, false);
        object.getWorldPosition(this.positionBuffer);
        object.getWorldQuaternion(this.quaternionBuffer);
        this.normalBuffer.copy(localPlaneNormal).applyQuaternion(this.quaternionBuffer).normalize();

        const label = plane.semanticLabel ?? '';
        if (
          (label.toLowerCase() === 'floor' ||
            (plane.orientation === 'horizontal' && this.positionBuffer.y <= 0.18)) &&
          !entity.hasComponent(LocomotionEnvironment)
        ) {
          entity.addComponent(LocomotionEnvironment);
        }
        if (entity.hasComponent(LocomotionEnvironment)) this.recoverFallenPlayer();
        next.push({
          id: stableId(plane as object),
          label,
          orientation: plane.orientation,
          position: this.positionBuffer.clone(),
          normal: this.normalBuffer.clone(),
          width,
          height,
        });
        seenLabels.add(label || '(unlabeled)');

        if (
          debugVisible &&
          (qualifiedEntity === undefined || entity === qualifiedEntity) &&
          !overlaysByEntity.has(entity)
        ) {
          try {
            this.createOverlay(entity, plane, width, height);
          } catch {
            this.logStatusOnce('[room] Could not draw a plane debug overlay.');
          }
        }
      }

      currentPlanes = next;
      if (this.noPlaneTimer !== undefined) {
        window.clearTimeout(this.noPlaneTimer);
        this.noPlaneTimer = undefined;
      }
      notifySubscribers();
      this.scheduleLabelLog();
    } catch {
      currentPlanes = [];
      notifySubscribers();
      this.logStatusOnce('[room] Failed to read detected planes; returning an empty room snapshot.');
    }
  }

  private removeOverlay(entity: Entity): void {
    const overlay = overlaysByEntity.get(entity);
    if (overlay !== undefined) {
      disposeOverlay(overlay);
      overlaysByEntity.delete(entity);
    }
  }

  private createOverlay(entity: Entity, plane: DetectedPlane, width: number, height: number): void {
    const object = entity.object3D;
    if (object == null || overlaysByEntity.has(entity)) return;
    const overlay = makeOverlay(plane, plane.semanticLabel ?? '', width, height);
    if (overlay === null) return;
    object.updateWorldMatrix(true, false);
    object.getWorldPosition(this.positionBuffer);
    object.getWorldQuaternion(this.quaternionBuffer);
    overlay.entity = this.world.createTransformEntity(overlay.group);
    overlay.group.position.copy(this.positionBuffer);
    overlay.group.quaternion.copy(this.quaternionBuffer);
    overlaysByEntity.set(entity, overlay);
  }

  private scheduleLabelLog(): void {
    if (labelsLogged) return;
    if (this.labelLogTimer !== undefined) window.clearTimeout(this.labelLogTimer);
    this.labelLogTimer = window.setTimeout(() => {
      this.labelLogTimer = undefined;
      if (labelsLogged || seenLabels.size === 0) return;
      console.info(`[room] Plane labels observed: ${JSON.stringify([...seenLabels].sort())}`);
      labelsLogged = true;
    }, 1500);
  }

  private logStatusOnce(message: string): void {
    if (statusLogged) return;
    statusLogged = true;
    console.info(message);
  }

  private clearTimers(): void {
    if (this.labelLogTimer !== undefined) window.clearTimeout(this.labelLogTimer);
    if (this.noPlaneTimer !== undefined) window.clearTimeout(this.noPlaneTimer);
    this.labelLogTimer = undefined;
    this.noPlaneTimer = undefined;
  }
}
