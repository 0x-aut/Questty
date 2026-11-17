/**
 * PR 11: every sound Questty makes, on one shared AudioContext.
 *
 *  - effects bus: chime, level-up fanfare and the card "tap"; silenced by the
 *    "Mute sound effects" setting.
 *  - buddy voice: an HRTF PannerNode that sits on the buddy orb (moved every
 *    frame by SpatialAudioSystem) so the buddy's talk-mode voice and its cue
 *    sound come from where the orb is in the room. The cue goes through the
 *    mute too; the talk-mode voice does not (that is a conversation, not an
 *    effect).
 *
 * All sounds are synthesised with oscillators (no audio files, licence-clean).
 * Nothing here allocates per frame; the sound functions build a few nodes per
 * play, which the audio thread frees when they stop.
 */
import { getSettings, onSettings } from './settings.js';
import { relativeDirection, type V3 } from './sfx-logic.js';

export type SoundKind = 'chime' | 'levelup' | 'buddy-cue' | 'tap';
export type SoundEvent = {
  /** 'buddy-voice' marks when the talk-mode voice was routed onto the orb. */
  kind: SoundKind | 'buddy-voice';
  /** performance.now() and Date.now() when it was asked to play. */
  at: number;
  wall: number;
  muted: boolean;
  /** Buddy sounds: where the orb was relative to the head when it played. */
  azimuthDeg?: number;
  elevationDeg?: number;
  distance?: number;
  /** Why it played (award, break, talk...). */
  reason?: string;
};

let ctx: AudioContext | undefined;
let bus: GainNode | undefined;
let panner: PannerNode | undefined;
let voiceIn: GainNode | undefined;
let cueIn: GainNode | undefined;
const log: SoundEvent[] = [];
const MAX_LOG = 200;
const BUS_LEVEL = 1;

const listenerPos: V3 = { x: 0, y: 1.6, z: 0 };
const listenerFwd: V3 = { x: 0, y: 0, z: -1 };
const sourcePos: V3 = { x: 0, y: 1.2, z: -0.6 };
let spatialUpdates = 0;

function ctor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

/** The shared context (created on first use). */
export function audioContext(): AudioContext | undefined {
  if (ctx !== undefined) return ctx;
  const C = ctor();
  if (C === undefined) return undefined;
  try {
    ctx = new C();
    bus = ctx.createGain();
    bus.gain.value = getSettings().muteSounds ? 0 : BUS_LEVEL;
    bus.connect(ctx.destination);
    panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 0.6;
    panner.maxDistance = 20;
    panner.rolloffFactor = 0.8;
    panner.connect(ctx.destination);
    voiceIn = ctx.createGain();
    voiceIn.connect(panner);
    cueIn = ctx.createGain();
    cueIn.gain.value = getSettings().muteSounds ? 0 : 1;
    cueIn.connect(panner);
    applySpatial();
  } catch {
    ctx = undefined;
  }
  return ctx;
}

onSettings((s, changed) => {
  if (changed !== 'muteSounds' || ctx === undefined) return;
  const v = s.muteSounds ? 0 : BUS_LEVEL;
  bus?.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
  cueIn?.gain.setTargetAtTime(s.muteSounds ? 0 : 1, ctx.currentTime, 0.02);
});

/** Create/resume the context. Call from a pinch so autoplay rules allow it. */
export function primeAudio(): void {
  const c = audioContext();
  if (c !== undefined && c.state === 'suspended') void c.resume().catch(() => undefined);
}

/** Is a sound able to play right now (context running)? */
export function audioRunning(): boolean {
  return ctx !== undefined && ctx.state === 'running';
}

function record(kind: SoundEvent['kind'], reason?: string, spatial = false): SoundEvent {
  const event: SoundEvent = { kind, at: performance.now(), wall: Date.now(), muted: getSettings().muteSounds, ...(reason ? { reason } : {}) };
  if (spatial) {
    const d = relativeDirection(listenerPos, listenerFwd, sourcePos);
    event.azimuthDeg = Math.round(d.azimuthDeg * 10) / 10;
    event.elevationDeg = Math.round(d.elevationDeg * 10) / 10;
    event.distance = Math.round(d.distance * 1000) / 1000;
  }
  log.push(event);
  if (log.length > MAX_LOG) log.shift();
  return event;
}

// ---- Synth voices (each takes any BaseAudioContext so the dev hook can render them offline) ----

/** A gentle three-note bell (E5, B5, E6), the completion chime since PR 3. */
export function synthChime(c: BaseAudioContext, out: AudioNode, at: number): number {
  const master = c.createGain();
  master.gain.value = 0.22;
  master.connect(out);
  const notes = [659.25, 987.77, 1318.51];
  notes.forEach((frequency, index) => {
    const t = at + index * 0.18;
    for (const [ratio, level] of [
      [1, 1],
      [2.01, 0.18],
    ] as const) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency * ratio;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.6 * level, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
      osc.connect(gain);
      gain.connect(master);
      osc.start(t);
      osc.stop(t + 1.9);
    }
  });
  return 2.3;
}

/**
 * The level-up fanfare: a quick square-wave arpeggio up (C5 E5 G5 C6 E6), a
 * bright held C major chord with a little vibrato, and a rising sparkle on
 * top. Clearly a "you levelled up" game sound, distinct from the soft chime.
 */
export function synthLevelUp(c: BaseAudioContext, out: AudioNode, at: number): number {
  const master = c.createGain();
  master.gain.value = 0.16;
  master.connect(out);
  const tone = c.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 5200;
  tone.connect(master);
  const arp = [523.25, 659.25, 783.99, 1046.5, 1318.51];
  arp.forEach((f, i) => {
    const t = at + i * 0.075;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'square';
    osc.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(g);
    g.connect(tone);
    osc.start(t);
    osc.stop(t + 0.18);
  });
  const chordAt = at + arp.length * 0.075 + 0.02;
  const vib = c.createOscillator();
  const vibDepth = c.createGain();
  vib.frequency.value = 6;
  vibDepth.gain.value = 5;
  vib.connect(vibDepth);
  vib.start(chordAt);
  vib.stop(chordAt + 1.25);
  for (const [f, type, level] of [
    [1046.5, 'triangle', 0.5],
    [1318.51, 'triangle', 0.38],
    [1567.98, 'triangle', 0.34],
    [523.25, 'square', 0.16],
  ] as const) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.value = f;
    vibDepth.connect(osc.detune);
    g.gain.setValueAtTime(0.0001, chordAt);
    g.gain.exponentialRampToValueAtTime(level, chordAt + 0.02);
    g.gain.setValueAtTime(level, chordAt + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, chordAt + 1.2);
    osc.connect(g);
    g.connect(tone);
    osc.start(chordAt);
    osc.stop(chordAt + 1.25);
  }
  // Sparkle: a fast rising sine sweep, twice.
  for (let i = 0; i < 2; i += 1) {
    const t = chordAt + 0.05 + i * 0.16;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(2093, t);
    osc.frequency.exponentialRampToValueAtTime(4186, t + 0.14);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + 0.16);
  }
  return chordAt - at + 1.3;
}

/** The buddy's cue: a soft rising two-note "bloop" (A5 -> E6). */
export function synthBuddyCue(c: BaseAudioContext, out: AudioNode, at: number): number {
  const master = c.createGain();
  master.gain.value = 0.5;
  master.connect(out);
  [
    [880, 0],
    [1318.51, 0.11],
  ].forEach(([f, dt]) => {
    const t = at + dt;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f * 0.94, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.05);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + 0.34);
  });
  return 0.5;
}

/** A soft "tap" as a card settles onto a surface: a few ms of filtered noise. */
export function synthTap(c: BaseAudioContext, out: AudioNode, at: number): number {
  const length = Math.floor(c.sampleRate * 0.045);
  const buffer = c.createBuffer(1, length, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  const source = c.createBufferSource();
  source.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1400;
  const gain = c.createGain();
  gain.gain.value = 0.18;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(out);
  source.start(at);
  return 0.06;
}

const SYNTH: Record<SoundKind, (c: BaseAudioContext, out: AudioNode, at: number) => number> = {
  chime: synthChime,
  levelup: synthLevelUp,
  'buddy-cue': synthBuddyCue,
  tap: synthTap,
};

/** Play a room sound (chime, level-up, tap) on the effects bus. */
export function playSound(kind: Exclude<SoundKind, 'buddy-cue'>, reason?: string): SoundEvent | null {
  if (kind === 'tap') {
    // The tap never wakes the context itself: silent until a pinch primed it.
    if (!audioRunning() || bus === undefined || ctx === undefined) return null;
    try {
      synthTap(ctx, bus, ctx.currentTime);
    } catch {
      return null;
    }
    return record('tap', reason);
  }
  primeAudio();
  const event = record(kind, reason);
  const c = ctx;
  if (c === undefined || bus === undefined) return event;
  try {
    SYNTH[kind](c, bus, c.currentTime + 0.05);
  } catch {
    // A blocked or missing audio device must never break completion.
  }
  return event;
}

/** The buddy's cue sound, from the orb (HRTF panner). */
export function playBuddyCue(reason?: string): SoundEvent | null {
  primeAudio();
  const event = record('buddy-cue', reason, true);
  if (ctx === undefined || cueIn === undefined) return event;
  try {
    synthBuddyCue(ctx, cueIn, ctx.currentTime + 0.03);
  } catch {
    // ignore
  }
  return event;
}

let voiceSource: MediaStreamAudioSourceNode | undefined;
let voiceAttachedAt = 0;
/**
 * Route the buddy's talk-mode voice (a WebRTC MediaStream) through the orb's
 * panner. Returns false when Web Audio is not available (the caller then plays
 * it plainly).
 */
export function attachBuddyVoice(stream: MediaStream): boolean {
  primeAudio();
  if (ctx === undefined || voiceIn === undefined) return false;
  try {
    voiceSource?.disconnect();
    voiceSource = ctx.createMediaStreamSource(stream);
    voiceSource.connect(voiceIn);
    voiceAttachedAt = performance.now();
    record('buddy-voice', 'talk', true);
    return true;
  } catch {
    return false;
  }
}

/**
 * PR 11: play a spoken buddy line (decoded text-to-speech audio) from the orb,
 * on the same HRTF panner as the talk-mode voice. Resolves when it ends.
 */
export async function playBuddySpeech(encoded: ArrayBuffer, reason?: string): Promise<boolean> {
  primeAudio();
  const c = ctx;
  if (c === undefined || voiceIn === undefined) return false;
  try {
    const buffer = await c.decodeAudioData(encoded.slice(0));
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(voiceIn);
    record('buddy-voice', reason ?? 'speech', true);
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      src.start(c.currentTime + 0.02);
    });
    src.disconnect();
    return true;
  } catch {
    return false;
  }
}

export function detachBuddyVoice(): void {
  try {
    voiceSource?.disconnect();
  } catch {
    // ignore
  }
  voiceSource = undefined;
}

/**
 * Every frame (SpatialAudioSystem): the head is the listener, the orb is the
 * source. Only writes the audio params; no allocation.
 */
export function updateSpatial(head: V3, forward: V3, up: V3, orb: V3): void {
  listenerPos.x = head.x;
  listenerPos.y = head.y;
  listenerPos.z = head.z;
  listenerFwd.x = forward.x;
  listenerFwd.y = forward.y;
  listenerFwd.z = forward.z;
  sourcePos.x = orb.x;
  sourcePos.y = orb.y;
  sourcePos.z = orb.z;
  spatialUpdates += 1;
  applySpatial(up);
}

function applySpatial(up: V3 = { x: 0, y: 1, z: 0 }): void {
  if (ctx === undefined || panner === undefined) return;
  const l = ctx.listener;
  if (l.positionX !== undefined) {
    l.positionX.value = listenerPos.x;
    l.positionY.value = listenerPos.y;
    l.positionZ.value = listenerPos.z;
    l.forwardX.value = listenerFwd.x;
    l.forwardY.value = listenerFwd.y;
    l.forwardZ.value = listenerFwd.z;
    l.upX.value = up.x;
    l.upY.value = up.y;
    l.upZ.value = up.z;
  } else {
    l.setPosition(listenerPos.x, listenerPos.y, listenerPos.z);
    l.setOrientation(listenerFwd.x, listenerFwd.y, listenerFwd.z, up.x, up.y, up.z);
  }
  if (panner.positionX !== undefined) {
    panner.positionX.value = sourcePos.x;
    panner.positionY.value = sourcePos.y;
    panner.positionZ.value = sourcePos.z;
  } else {
    panner.setPosition(sourcePos.x, sourcePos.y, sourcePos.z);
  }
}

/** Dev/test: the recent sound events (copy). */
export function soundLog(): SoundEvent[] {
  return log.map((e) => ({ ...e }));
}

/** Dev/test: what the panner and listener hold right now. */
export function spatialState() {
  const d = relativeDirection(listenerPos, listenerFwd, sourcePos);
  return {
    context: ctx?.state ?? 'none',
    model: panner?.panningModel ?? null,
    panner: panner?.positionX !== undefined ? [panner.positionX.value, panner.positionY.value, panner.positionZ.value] : null,
    listener: ctx?.listener.positionX !== undefined ? [ctx.listener.positionX.value, ctx.listener.positionY.value, ctx.listener.positionZ.value] : null,
    forward: ctx?.listener.forwardX !== undefined ? [ctx.listener.forwardX.value, ctx.listener.forwardY.value, ctx.listener.forwardZ.value] : null,
    source: [sourcePos.x, sourcePos.y, sourcePos.z],
    azimuthDeg: d.azimuthDeg,
    elevationDeg: d.elevationDeg,
    distance: d.distance,
    updates: spatialUpdates,
    voiceAttached: voiceSource !== undefined,
    voiceAttachedAt,
    busGain: bus?.gain.value ?? null,
  };
}

/**
 * Dev/test: render one sound offline (mono, 48 kHz) and return it as a WAV
 * byte string in base64, so the video can carry the app's own sounds.
 */
export async function renderSoundWav(kind: SoundKind): Promise<string> {
  const rate = 48_000;
  const seconds = kind === 'levelup' ? 2.2 : kind === 'chime' ? 2.4 : kind === 'buddy-cue' ? 0.6 : 0.1;
  const off = new OfflineAudioContext(1, Math.ceil(rate * seconds), rate);
  SYNTH[kind](off, off.destination, 0.01);
  const buf = await off.startRendering();
  const pcm = buf.getChannelData(0);
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Dev/test: record the buddy panner's real (HRTF, stereo) output for `ms`,
 * returned as base64 webm/opus. Proves the voice really comes out panned.
 */
export async function recordBuddyOutput(ms: number): Promise<{ mime: string; base64: string } | null> {
  const c = audioContext();
  if (c === undefined || panner === undefined || typeof MediaRecorder === 'undefined') return null;
  const dest = c.createMediaStreamDestination();
  dest.channelCount = 2;
  panner.connect(dest);
  const rec = new MediaRecorder(dest.stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  rec.start(500);
  await new Promise((r) => window.setTimeout(r, ms));
  rec.stop();
  await done;
  panner.disconnect(dest);
  const blob = new Blob(chunks, { type: rec.mimeType });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mime: rec.mimeType, base64: btoa(s) };
}
