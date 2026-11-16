/**
 * The buddy orb (PR 6): a soft glowing sphere, not a character. It sits in
 * the home panel (the hero mic spot when the panel is open, the pill when it
 * is collapsed) and shows what the buddy is doing:
 *
 *   idle      slow breathing, warm pearl-gold
 *   listening warm coral, swells with the mic level
 *   thinking  pearl sand, gentle surface ripple + rings drifting out
 *   acting    brighter gold while light lines reach the cards it touches
 *   done      a soft sage settle ring, then back to idle
 *   error     muted rose, a small shake
 *
 * Colours ease between states (~0.35 s); nothing snaps. Pure three.js, no
 * textures to load (the halo is a canvas gradient).
 */
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
  type Object3D,
} from '@iwsdk/core';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'acting' | 'done' | 'error';
export const ORB_STATES: readonly OrbState[] = ['idle', 'listening', 'thinking', 'acting', 'done', 'error'];

type Palette = { core: string; rim: string; halo: string };
// A luminous pearl: a pale core, a warm rim of light, a soft halo. Muted tints, no neon.
const PALETTE: Record<OrbState, Palette> = {
  idle: { core: '#f4e6c4', rim: '#f3c769', halo: '#f0c25c' },
  listening: { core: '#fbd6c9', rim: '#f39278', halo: '#f2896c' },
  thinking: { core: '#ece6dc', rim: '#b9cbe0', halo: '#a9c0dc' },
  acting: { core: '#fbefcf', rim: '#f6c75a', halo: '#f5c04a' },
  done: { core: '#e3efd9', rim: '#9cc98a', halo: '#8fc27c' },
  error: { core: '#f3d6cf', rim: '#de8a7a', halo: '#d97f6f' },
};

const PALETTE_C: Record<OrbState, { core: Color; rim: Color; halo: Color }> = Object.fromEntries(
  Object.entries(PALETTE).map(([k, v]) => [k, { core: new Color(v.core), rim: new Color(v.rim), halo: new Color(v.halo) }]),
) as Record<OrbState, { core: Color; rim: Color; halo: Color }>;

const VERT = /* glsl */ `
uniform float uTime;
uniform float uRipple;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vLocal;
void main() {
  vec3 p = position;
  float wave = sin(p.y * 18.0 + uTime * 4.2) * 0.5 + sin(p.x * 14.0 - uTime * 3.1) * 0.5;
  p += normal * wave * uRipple * 0.035;
  vLocal = p;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vNormalV = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uRim;
uniform float uGlow;
uniform float uTime;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vLocal;
void main() {
  vec3 n = normalize(vNormalV);
  float facing = clamp(dot(n, normalize(vViewDir)), 0.0, 1.0);
  float fres = pow(1.0 - facing, 2.2);
  // Soft vertical gradient: lighter on top, a little deeper underneath.
  float g = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 base = mix(mix(uCore, uRim, 0.35) * 0.78, uCore * 1.05, g);
  // A slow inner swirl so the surface never looks flat.
  float swirl = sin(vLocal.x * 9.0 + uTime * 0.9) * sin(vLocal.y * 7.0 - uTime * 0.7);
  base += uRim * swirl * 0.045;
  // Diffuse inner light (top-left), like light inside frosted glass.
  float spot = pow(max(dot(n, normalize(vec3(-0.35, 0.6, 0.72))), 0.0), 6.0);
  vec3 color = base + vec3(1.0) * spot * 0.28 + uRim * fres * (0.9 + 0.8 * uGlow);
  color = min(color, vec3(1.0));
  float alpha = mix(0.98, 0.7, pow(fres, 1.6));
  gl_FragColor = vec4(color, alpha);
}
`;

let haloTexture: CanvasTexture | undefined;
function getHaloTexture(): CanvasTexture {
  if (haloTexture !== undefined) return haloTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.6)');
    g.addColorStop(0.62, 'rgba(255,255,255,0.16)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  haloTexture = new CanvasTexture(canvas);
  haloTexture.colorSpace = SRGBColorSpace;
  return haloTexture;
}

const RING_COUNT = 2;

export class BuddyOrb {
  readonly group = new Group();
  private readonly sphere: Mesh;
  private readonly material: ShaderMaterial;
  private readonly halo: Mesh;
  private readonly haloMaterial: MeshBasicMaterial;
  private readonly rings: Array<{ mesh: Mesh; material: MeshBasicMaterial }> = [];
  private readonly core = new Color(PALETTE.idle.core);
  private readonly rim = new Color(PALETTE.idle.rim);
  private readonly haloColor = new Color(PALETTE.idle.halo);
  private readonly fromCore = new Color();
  private readonly fromRim = new Color();
  private readonly fromHalo = new Color();
  private blendStart = 0;
  private stateStart = 0;
  private level = 0;
  private ripple = 0;
  private scaleNow = 1;
  private readonly camPos = new Vector3();
  state: OrbState = 'idle';

  constructor() {
    this.group.name = 'Buddy Orb';
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: true,
      uniforms: {
        uCore: { value: this.core.clone() },
        uRim: { value: this.rim.clone() },
        uGlow: { value: 0 },
        uTime: { value: 0 },
        uRipple: { value: 0 },
      },
    });
    this.sphere = new Mesh(new SphereGeometry(1, 48, 32), this.material);
    this.sphere.name = 'Buddy Orb Core';
    this.sphere.renderOrder = 12;
    this.haloMaterial = new MeshBasicMaterial({
      map: getHaloTexture(),
      color: this.haloColor.clone(),
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.halo = new Mesh(new PlaneGeometry(1, 1), this.haloMaterial);
    this.halo.name = 'Buddy Orb Halo';
    this.halo.renderOrder = 11;
    this.group.add(this.halo, this.sphere);
    for (let i = 0; i < RING_COUNT; i += 1) {
      const material = new MeshBasicMaterial({
        color: '#fff6e4',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
      });
      const mesh = new Mesh(new RingGeometry(0.97, 1, 64, 1), material);
      mesh.name = 'Buddy Orb Ring';
      mesh.renderOrder = 13;
      mesh.visible = false;
      this.rings.push({ mesh, material });
      this.group.add(mesh);
    }
    // Purely visual: pinches go to the panel element behind it.
    for (const object of [this.sphere, this.halo, ...this.rings.map((r) => r.mesh)]) {
      object.raycast = () => undefined;
    }
    this.group.userData.iwsdkPreviewBounds = 'exclude';
  }

  setState(state: OrbState): void {
    if (state === this.state) return;
    this.state = state;
    const now = performance.now();
    this.stateStart = now;
    this.blendStart = now;
    this.fromCore.copy(this.core);
    this.fromRim.copy(this.rim);
    this.fromHalo.copy(this.haloColor);
  }

  /** Mic level 0..1 (listening). */
  setLevel(level: number): void {
    this.level = Math.max(0, Math.min(1, level));
  }

  /** Radius in metres; the group's world scale. */
  update(now: number, radius: number, camera: Object3D): void {
    const t = now / 1000;
    const p = PALETTE_C[this.state];
    const blend = Math.min(1, (now - this.blendStart) / 350);
    const e = blend * blend * (3 - 2 * blend);
    this.core.copy(this.fromCore).lerp(p.core, e);
    this.rim.copy(this.fromRim).lerp(p.rim, e);
    this.haloColor.copy(this.fromHalo).lerp(p.halo, e);
    const u = this.material.uniforms;
    (u.uCore.value as Color).copy(this.core);
    (u.uRim.value as Color).copy(this.rim);
    u.uTime.value = t;
    const since = (now - this.stateStart) / 1000;

    // Breathing / level / ripple per state.
    let scale = 1;
    let glow = 0.25;
    let haloOpacity = 0.32;
    const rippleTarget = this.state === 'thinking' ? 1 : this.state === 'acting' ? 0.35 : 0;
    this.ripple += (rippleTarget - this.ripple) * 0.08;
    u.uRipple.value = this.ripple;
    let shake = 0;
    switch (this.state) {
      case 'idle': {
        const b = 0.5 - 0.5 * Math.cos((t * 2 * Math.PI) / 4.2);
        scale = 0.97 + 0.05 * b;
        glow = 0.2 + 0.3 * b;
        haloOpacity = 0.42 + 0.22 * b;
        break;
      }
      case 'listening':
        scale = 1.02 + 0.2 * this.level;
        glow = 0.5 + 0.5 * this.level;
        haloOpacity = 0.6 + 0.4 * this.level;
        break;
      case 'thinking':
        scale = 1 + 0.025 * Math.sin(t * 5);
        glow = 0.55;
        haloOpacity = 0.55 + 0.12 * Math.sin(t * 3);
        break;
      case 'acting':
        scale = 1.05;
        glow = 0.85;
        haloOpacity = 0.85;
        break;
      case 'done':
        scale = 1 + 0.06 * Math.exp(-since * 3) * Math.cos(since * 9);
        glow = 0.7 * Math.exp(-since * 0.8) + 0.25;
        haloOpacity = 0.7;
        break;
      case 'error':
        shake = since < 0.5 ? Math.sin(since * 50) * 0.08 * (1 - since / 0.5) : 0;
        scale = 0.98;
        glow = 0.4;
        haloOpacity = 0.5;
        break;
    }
    this.scaleNow += (scale - this.scaleNow) * 0.2;
    u.uGlow.value = glow;
    this.sphere.scale.setScalar(radius * this.scaleNow);
    this.sphere.position.set(shake * radius, 0, 0);
    this.halo.scale.setScalar(radius * 3.2 * (0.9 + 0.1 * this.scaleNow));
    this.haloMaterial.color.copy(this.haloColor);
    this.haloMaterial.opacity = haloOpacity;

    // Rings: drift outward while thinking; one settle ring on done.
    this.rings.forEach((ring, i) => {
      let k = -1;
      if (this.state === 'thinking') k = ((t * 0.7 + i / RING_COUNT) % 1 + 1) % 1;
      else if (this.state === 'done' && i === 0 && since < 0.9) k = since / 0.9;
      ring.mesh.visible = k >= 0;
      if (k < 0) return;
      ring.mesh.scale.setScalar(radius * (1.1 + 1.3 * k));
      ring.material.opacity = (this.state === 'done' ? 0.55 : 0.32) * (1 - k) * Math.min(1, k * 4);
      ring.material.color.copy(this.rim);
    });

    // Halo and rings face the eyes (billboards).
    camera.getWorldPosition(this.camPos);
    this.group.updateWorldMatrix(true, false);
    // Object3D.lookAt takes a WORLD point.
    this.halo.lookAt(this.camPos);
    for (const ring of this.rings) ring.mesh.lookAt(this.camPos);
  }

  dispose(): void {
    this.sphere.geometry.dispose();
    this.material.dispose();
    this.halo.geometry.dispose();
    this.haloMaterial.dispose();
    for (const ring of this.rings) {
      ring.mesh.geometry.dispose();
      ring.material.dispose();
    }
  }
}
