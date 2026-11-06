import {
  BackSide,
  Color,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
} from '@iwsdk/core';

/** A quiet, inward-facing focus environment centered at the world origin. */
export function createFocusDome(radius = 10): Mesh {
  const geometry = new SphereGeometry(radius, 48, 32);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const bottom = new Color('#172735');
  const horizon = new Color('#567487');
  const zenith = new Color('#b6c7bc');
  const color = new Color();

  for (let index = 0; index < positions.count; index += 1) {
    const gradient = Math.max(
      0,
      Math.min(1, (positions.getY(index) / radius + 1) * 0.5),
    );
    if (gradient < 0.5) {
      color.lerpColors(bottom, horizon, gradient * 2);
    } else {
      color.lerpColors(horizon, zenith, (gradient - 0.5) * 2);
    }
    color.toArray(colors, index * 3);
  }

  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.name = 'Focus Dome Gradient';
  const material = new MeshBasicMaterial({
    vertexColors: true,
    side: BackSide,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false,
  });
  material.name = 'Calm Focus Gradient';

  const dome = new Mesh(geometry, material);
  dome.name = 'Focus Dome';
  dome.userData.iwsdkPreviewBounds = 'exclude';
  return dome;
}
