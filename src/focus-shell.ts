import {
  BackSide,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  Vector4,
} from '@iwsdk/core';

/**
 * The focus "frost" shell: an inward-facing sphere around the seated user that
 * softens everything past ~1.25 m with a milky, dimmed, grainy frost, leaving
 * clear round windows around the active task card and the timer.
 *
 * Why not a real blur: WebXR never exposes the passthrough camera image, so
 * the browser cannot blur the real room. The virtual content is a handful of
 * props, and blurring it would need an extra stereo scene pass plus blur
 * passes every frame; this shell is one transparent draw with no render
 * targets and no per-frame allocation.
 */
export const SHELL_RADIUS = 1.25;

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uOpacity;
  uniform vec4 uWin0;
  uniform vec4 uWin1;
  varying vec3 vDir;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float windowMask(vec4 win, vec3 dir) {
    if (win.w <= 0.0) return 0.0;
    float d = dot(dir, win.xyz);
    float inner = cos(win.w);
    float outer = cos(win.w + 0.17);
    return smoothstep(outer, inner, d);
  }

  void main() {
    vec3 dir = normalize(vDir);
    float clear = max(windowMask(uWin0, dir), windowMask(uWin1, dir));
    float t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 low = vec3(0.47, 0.55, 0.60);
    vec3 high = vec3(0.80, 0.85, 0.83);
    vec3 frost = mix(low, high, smoothstep(0.2, 0.9, t));
    float grain = hash(floor(dir * 420.0)) - 0.5;
    frost += grain * 0.035;
    // A faint bright rim where the frost meets each window, like frosted glass.
    float rim = clear * (1.0 - clear) * 4.0;
    frost += rim * 0.06;
    float alpha = uOpacity * (1.0 - clear) * (0.92 + grain * 0.06);
    gl_FragColor = vec4(frost, alpha);
  }
`;

export type FocusShell = {
  mesh: Mesh;
  material: ShaderMaterial;
  geometry: SphereGeometry;
  setOpacity(value: number): void;
  /** Window centred on `dir` (unit vector from the shell centre), half-angle in radians. */
  setWindow(index: 0 | 1, dir: Vector3 | null, halfAngle: number): void;
  dispose(): void;
};

export function createFocusShell(): FocusShell {
  const geometry = new SphereGeometry(SHELL_RADIUS, 48, 24);
  const material = new ShaderMaterial({
    uniforms: {
      uOpacity: { value: 0 },
      uWin0: { value: new Vector4(0, 0, -1, 0) },
      uWin1: { value: new Vector4(0, 0, -1, 0) },
    },
    vertexShader,
    fragmentShader,
    side: BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  material.name = 'Focus Frost Shell';
  const mesh = new Mesh(geometry, material);
  mesh.name = 'Focus Frost Shell';
  mesh.renderOrder = 900;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.userData.iwsdkPreviewBounds = 'exclude';
  const windows = [material.uniforms.uWin0.value as Vector4, material.uniforms.uWin1.value as Vector4];
  return {
    mesh,
    material,
    geometry,
    setOpacity(value: number) {
      material.uniforms.uOpacity.value = value;
      mesh.visible = value > 0.002;
    },
    setWindow(index, dir, halfAngle) {
      const w = windows[index];
      if (dir === null) w.set(0, 0, -1, 0);
      else w.set(dir.x, dir.y, dir.z, halfAngle);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
