import {
  BackSide,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  Vector4,
} from '@iwsdk/core';

/**
 * PR 11: with the "Calm scene in focus" setting (on by default) the same
 * shell fades the room out into a calm desk scene instead (one shader branch,
 * still one draw); off keeps the frosted glass.
 *
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
  uniform float uCalm;
  uniform float uTime;
  uniform vec4 uWin0;
  uniform vec4 uWin1;
  varying vec3 vDir;

  // PR 11: the calm desk scene, drawn from the view direction alone (the shell is
  // centred on the head): a wooden desk in front of a wide window at dusk, a hazy
  // meadow below it, two soft mountain ridges, a low sun and slow clouds.
  vec3 calmScene(vec3 dir) {
    float el = dir.y;
    float az = atan(dir.x, -dir.z);
    // Sky: warm horizon to soft blue, a low sun and drifting cloud bands.
    vec3 col = mix(vec3(0.99, 0.83, 0.68), vec3(0.45, 0.60, 0.80), smoothstep(0.0, 0.75, el));
    vec3 sunDir = normalize(vec3(-0.38, 0.13, -0.92));
    float sd = max(dot(dir, sunDir), 0.0);
    col += vec3(1.0, 0.86, 0.62) * (pow(sd, 90.0) * 0.9 + pow(sd, 7.0) * 0.16);
    float band = sin(az * 2.0 + uTime * 0.015 + sin(az * 5.0) * 0.6) * 0.5 + 0.5;
    float cloud = smoothstep(0.55, 0.95, band) * smoothstep(0.12, 0.3, el) * (1.0 - smoothstep(0.45, 0.8, el));
    col = mix(col, vec3(1.0, 0.95, 0.9), cloud * 0.35);
    // Mountains: a far, hazy ridge and a nearer, darker one.
    float far = 0.11 + 0.05 * sin(az * 2.3 + 1.0) + 0.03 * sin(az * 5.7 + 2.0) + 0.012 * sin(az * 13.1);
    float near = 0.05 + 0.035 * sin(az * 3.1 + 4.0) + 0.018 * sin(az * 8.3 + 0.5);
    col = mix(col, vec3(0.62, 0.66, 0.78), smoothstep(far + 0.004, far - 0.004, el) * 0.9);
    col = mix(col, vec3(0.40, 0.47, 0.56), smoothstep(near + 0.004, near - 0.004, el));
    // Below the horizon: a meadow fading into haze.
    float ground = smoothstep(0.004, -0.004, el);
    vec3 meadow = mix(vec3(0.47, 0.58, 0.45), vec3(0.78, 0.76, 0.70), smoothstep(-0.25, 0.0, el));
    col = mix(col, meadow, ground);
    // The desk: a plane 0.5 m below the eyes, its far edge (the window sill) ~1 m away.
    float t = 0.5 / max(-el, 0.001);
    vec2 p = dir.xz * t;
    float onDesk = smoothstep(1.02, 0.98, length(vec2(p.x * 0.55, p.y))) * step(el, -0.02);
    float grain = sin(p.x * 34.0 + sin(p.y * 4.0) * 2.5) * 0.5 + 0.5;
    vec3 wood = mix(vec3(0.50, 0.34, 0.22), vec3(0.63, 0.45, 0.29), grain);
    wood *= 0.85 + 0.25 * smoothstep(-1.0, 0.0, -t);
    wood += vec3(1.0, 0.8, 0.6) * 0.08 * pow(max(dot(normalize(vec3(p.x, 0.0, p.y)), normalize(vec3(sunDir.x, 0.0, sunDir.z))), 0.0), 4.0);
    col = mix(col, wood, onDesk);
    // Window mullions: two slim frames either side, and a cream sill line.
    float mull = smoothstep(0.012, 0.004, abs(abs(az) - 1.05)) * step(-0.02, el);
    col = mix(col, vec3(0.93, 0.90, 0.84), mull * 0.85);
    return col;
  }

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
    if (uCalm > 0.0) {
      // Calm scene: opaque past the windows; the windows keep a soft warm rim.
      vec3 calm = calmScene(dir) + rim * vec3(0.10, 0.08, 0.05);
      frost = mix(frost, calm, uCalm);
      alpha = mix(alpha, uOpacity * (1.0 - clear), uCalm);
    }
    gl_FragColor = vec4(frost, alpha);
  }
`;

export type FocusShell = {
  mesh: Mesh;
  material: ShaderMaterial;
  geometry: SphereGeometry;
  setOpacity(value: number): void;
  /** PR 11: 0 = frosted glass, 1 = the calm desk scene. */
  setCalm(value: number): void;
  setTime(seconds: number): void;
  /** Window centred on `dir` (unit vector from the shell centre), half-angle in radians. */
  setWindow(index: 0 | 1, dir: Vector3 | null, halfAngle: number): void;
  dispose(): void;
};

export function createFocusShell(): FocusShell {
  const geometry = new SphereGeometry(SHELL_RADIUS, 48, 24);
  const material = new ShaderMaterial({
    uniforms: {
      uOpacity: { value: 0 },
      uCalm: { value: 0 },
      uTime: { value: 0 },
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
    setCalm(value: number) {
      material.uniforms.uCalm.value = Math.max(0, Math.min(1, value));
    },
    setTime(seconds: number) {
      material.uniforms.uTime.value = seconds;
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
