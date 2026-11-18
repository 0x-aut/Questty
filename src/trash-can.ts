/**
 * PR 12: the trash can finished and tossed cards go into (it replaces the old
 * trophy plinth, which read as a white pillar of light in passthrough).
 *
 * A simple low-poly bin from primitives: a tapered open drum, a darker inside,
 * a rolled rim and a base, about 42 cm tall. It stands on the floor a little
 * away from a seated user (front right, ~2 m out), so a card or paper ball has
 * somewhere to fly to without the bin sitting in the way.
 */
import {
  BackSide,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';

export const TRASH_CAN_HEIGHT = 0.42;
const TOP_RADIUS = 0.17;
const BOTTOM_RADIUS = 0.13;
const SIDES = 14;

/** Where the bin stands on the floor (world, local-floor space). */
export const TRASH_CAN_ORIGIN = new Vector3(1.05, 0, -1.9);
/** Where cards and paper balls aim: just inside the mouth. */
export const TRASH_CAN_MOUTH = new Vector3(TRASH_CAN_ORIGIN.x, TRASH_CAN_HEIGHT - 0.06, TRASH_CAN_ORIGIN.z);

export function createTrashCan(): Group {
  const outer = new MeshStandardMaterial({ color: 0x4f6b5a, roughness: 0.55, metalness: 0.25, flatShading: true });
  const inner = new MeshStandardMaterial({ color: 0x1d2621, roughness: 0.9, metalness: 0.05, side: BackSide });
  const rimMat = new MeshStandardMaterial({ color: 0x8fa597, roughness: 0.4, metalness: 0.4, flatShading: true });

  const drum = new Mesh(new CylinderGeometry(TOP_RADIUS, BOTTOM_RADIUS, TRASH_CAN_HEIGHT, SIDES, 1, true), outer);
  drum.position.y = TRASH_CAN_HEIGHT / 2;
  const lining = new Mesh(
    new CylinderGeometry(TOP_RADIUS - 0.008, BOTTOM_RADIUS - 0.008, TRASH_CAN_HEIGHT - 0.01, SIDES, 1, true),
    inner,
  );
  lining.position.y = TRASH_CAN_HEIGHT / 2 + 0.005;
  const base = new Mesh(new CircleGeometry(BOTTOM_RADIUS, SIDES), new MeshStandardMaterial({ color: 0x1d2621, side: DoubleSide }));
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0.004;
  const rim = new Mesh(new TorusGeometry(TOP_RADIUS, 0.012, 6, SIDES * 2), rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = TRASH_CAN_HEIGHT;
  const foot = new Mesh(new TorusGeometry(BOTTOM_RADIUS, 0.01, 6, SIDES * 2), rimMat);
  foot.rotation.x = Math.PI / 2;
  foot.position.y = 0.01;

  const can = new Group();
  can.name = 'Trash Can';
  can.add(drum, lining, base, rim, foot);
  // Decoration only: never catch a pointer ray or a card drop.
  can.traverse((o) => {
    if (o instanceof Mesh) {
      o.raycast = () => undefined;
      o.castShadow = true;
    }
  });
  can.position.copy(TRASH_CAN_ORIGIN);
  return can;
}
