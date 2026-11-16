/**
 * Talk mode (PR 7): a full-duplex voice conversation with the buddy over
 * GPT-Live (gpt-live-1) and WebRTC.
 *
 * The browser makes an SDP offer with the mic track and an "oai-events" data
 * channel; /api/live exchanges it with OpenAI on the server (the key never
 * reaches the client). The session uses CLIENT delegation: GPT-Live only
 * talks, and whenever the user wants something done it raises
 * `session.delegation.created`. We then take what the user said (input
 * transcript since the last delegation), run it through the buddy's normal
 * pipeline (validated actions -> executor, with Undo and light lines) and send
 * the executor's own result back with `session.commentary.append`, which
 * GPT-Live says in a short sentence. Nothing the voice model says is ever
 * executed.
 *
 * Captions come from `session.input_transcript.delta` /
 * `session.output_transcript.delta`. The orb follows the buddy's output audio
 * level. A session ends on a second pinch, after ~60 s with no speech, or
 * after a hard cap, always with a graceful `session.close`.
 */

export type TalkState = 'off' | 'connecting' | 'live' | 'closing' | 'failed';

export type TalkHost = {
  /** Run one spoken request through the validated pipeline; resolve with the line to say. */
  command(text: string): Promise<string>;
  /** Captions for the bubble: who is speaking and the text so far. */
  caption(who: 'you' | 'buddy', text: string): void;
  state(state: TalkState, detail?: string): void;
  /** The buddy's output level 0..1 (and the user's mic level), per animation frame. */
  levels(output: number, input: number): void;
};

export type TalkDebug = {
  state: TalkState;
  sessionId: string;
  events: Record<string, number>;
  delegations: Array<{ id: string; text: string; reply: string }>;
  you: string;
  buddy: string;
  usageSeconds: number | null;
  closedReason: string | null;
  error: string | null;
  peakOutput: number;
  startedAt: number;
  endedAt: number;
};

const IDLE_MS = 60_000;
const MAX_SESSION_MS = 5 * 60_000;
const CLOSE_WAIT_MS = 6_000;

export class TalkSession {
  private peer: RTCPeerConnection | null = null;
  private events: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private outAnalyser: AnalyserNode | null = null;
  private inAnalyser: AnalyserNode | null = null;
  private raf = 0;
  private lastActivity = 0;
  private closeTimer = 0;
  private youSinceDelegation = '';
  private youLine = '';
  private buddyLine = '';
  private lastSpeaker: 'you' | 'buddy' | null = null;
  private eventSeq = 0;
  private queue: Promise<void> = Promise.resolve();
  readonly debug: TalkDebug = {
    state: 'off',
    sessionId: '',
    events: {},
    delegations: [],
    you: '',
    buddy: '',
    usageSeconds: null,
    closedReason: null,
    error: null,
    peakOutput: 0,
    startedAt: 0,
    endedAt: 0,
  };

  constructor(private readonly host: TalkHost) {}

  get state(): TalkState {
    return this.debug.state;
  }

  private setState(state: TalkState, detail?: string): void {
    this.debug.state = state;
    this.host.state(state, detail);
  }

  async start(): Promise<void> {
    if (this.state !== 'off' && this.state !== 'failed') return;
    this.setState('connecting');
    this.debug.startedAt = Date.now();
    try {
      if (typeof RTCPeerConnection === 'undefined') throw new Error('no-webrtc');
      const peer = new RTCPeerConnection();
      this.peer = peer;
      this.audio = new Audio();
      this.audio.autoplay = true;
      peer.addEventListener('track', (event) => {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        if (this.audio !== null) {
          this.audio.srcObject = stream;
          void this.audio.play().catch(() => undefined);
        }
        this.watchLevel(stream, 'out');
      });
      peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState === 'failed') this.fail('connection-failed');
      });
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      for (const track of this.mic.getAudioTracks()) peer.addTrack(track, this.mic);
      this.watchLevel(this.mic, 'in');

      // The event channel must exist before the offer.
      const events = peer.createDataChannel('oai-events');
      this.events = events;
      events.addEventListener('message', (message) => this.onEvent(message.data));
      events.addEventListener('close', () => {
        if (this.state === 'live' || this.state === 'connecting') this.fail('events-closed');
        else if (this.state === 'closing') this.cleanup('closed-early');
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIce(peer, 8_000);
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error('no-offer');
      const response = await fetch('/api/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp }),
      });
      if (!response.ok) {
        let code = `http-${response.status}`;
        try {
          const err = (await response.json()) as { error?: unknown };
          if (typeof err.error === 'string') code = err.error;
        } catch {
          // not JSON
        }
        throw new Error(code);
      }
      const result = (await response.json()) as { session?: { id?: string }; transport?: { sdp?: string } };
      if (typeof result.transport?.sdp !== 'string') throw new Error('bad-answer');
      this.debug.sessionId = result.session?.id ?? '';
      if ((this.state as TalkState) !== 'connecting') return; // stopped meanwhile
      await peer.setRemoteDescription({ type: 'answer', sdp: result.transport.sdp });
      this.lastActivity = performance.now();
      // The HTTP request started the session; wait for session.started.
      window.setTimeout(() => {
        if ((this.state as TalkState) === 'connecting') this.fail('no-session-started');
      }, 15_000);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** Graceful close: session.close, then wait for session.closed (or time out). */
  stop(reason = 'user'): void {
    if (this.state === 'off' || this.state === 'closing') return;
    if (this.events?.readyState !== 'open' || this.state !== 'live') {
      this.debug.closedReason = reason;
      this.cleanup(reason);
      return;
    }
    this.setState('closing', reason);
    this.debug.closedReason = reason;
    this.send({ type: 'session.close' });
    this.closeTimer = window.setTimeout(() => this.cleanup('close-timeout'), CLOSE_WAIT_MS);
  }

  /** Called every frame by the buddy: idle and hard-cap timeouts. */
  tick(now: number): void {
    if (this.state !== 'live') return;
    if (now - this.lastActivity > IDLE_MS) this.stop('idle');
    else if (Date.now() - this.debug.startedAt > MAX_SESSION_MS) this.stop('max-length');
  }

  private fail(code: string): void {
    if (this.state === 'off') return;
    console.warn('[talk] failed:', code);
    this.debug.error = code;
    this.cleanup(code, 'failed');
  }

  private cleanup(reason: string, state: TalkState = 'off'): void {
    window.clearTimeout(this.closeTimer);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    const events = this.events;
    this.events = null;
    try {
      events?.close();
    } catch {
      // ignore
    }
    this.peer?.close();
    this.peer = null;
    if (this.audio !== null) this.audio.srcObject = null;
    this.audio = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.outAnalyser = null;
    this.inAnalyser = null;
    this.debug.endedAt = Date.now();
    if (this.debug.closedReason === null) this.debug.closedReason = reason;
    this.host.levels(0, 0);
    this.setState(state, reason);
  }

  private send(event: Record<string, unknown>): void {
    if (this.events?.readyState !== 'open') return;
    this.eventSeq += 1;
    this.events.send(JSON.stringify({ event_id: `questty_${Date.now().toString(36)}_${this.eventSeq}`, ...event }));
  }

  private onEvent(raw: unknown): void {
    let event: { type?: string; [key: string]: unknown };
    try {
      event = JSON.parse(String(raw)) as typeof event;
    } catch {
      return;
    }
    const type = typeof event.type === 'string' ? event.type : 'unknown';
    this.debug.events[type] = (this.debug.events[type] ?? 0) + 1;
    switch (type) {
      case 'session.started':
        this.lastActivity = performance.now();
        this.setState('live');
        break;
      case 'session.input_transcript.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        this.lastActivity = performance.now();
        if (this.lastSpeaker !== 'you') this.youLine = '';
        this.lastSpeaker = 'you';
        this.youLine += delta;
        this.youSinceDelegation += delta;
        this.debug.you = this.youLine.trim();
        this.host.caption('you', this.youLine.trim());
        break;
      }
      case 'session.output_transcript.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        this.lastActivity = performance.now();
        if (this.lastSpeaker !== 'buddy') this.buddyLine = '';
        this.lastSpeaker = 'buddy';
        this.buddyLine += delta;
        this.debug.buddy = this.buddyLine.trim();
        this.host.caption('buddy', this.buddyLine.trim());
        break;
      }
      case 'session.delegation.created': {
        const delegation = event.delegation as { id?: unknown; target?: unknown } | undefined;
        const id = typeof delegation?.id === 'string' ? delegation.id : '';
        if (id.length === 0) break;
        this.lastActivity = performance.now();
        // Cancel the generic spoken acknowledgement; the real result follows.
        this.send({ type: 'session.thinking.append', delegation_id: id, content: 'Working on it in the room.' });
        this.queue = this.queue.then(() => this.runDelegation(id));
        break;
      }
      case 'session.usage.updated': {
        const usage = event.usage as { seconds?: unknown } | undefined;
        if (typeof usage?.seconds === 'number') this.debug.usageSeconds = usage.seconds;
        break;
      }
      case 'session.closed': {
        const usage = event.usage as { seconds?: unknown } | undefined;
        if (typeof usage?.seconds === 'number') this.debug.usageSeconds = usage.seconds;
        if (typeof event.reason === 'string') this.debug.closedReason = event.reason;
        this.cleanup(this.debug.closedReason ?? 'closed');
        break;
      }
      case 'error': {
        const err = event.error as { code?: unknown; message?: unknown } | undefined;
        this.debug.error = String(err?.code ?? err?.message ?? 'error');
        console.warn('[talk] session error', err?.code, err?.message);
        break;
      }
      default:
        break;
    }
  }

  private async runDelegation(id: string): Promise<void> {
    // Transcript deltas can trail the delegation event a little.
    if (this.youSinceDelegation.trim().length === 0) await delay(600);
    const text = this.youSinceDelegation.trim();
    this.youSinceDelegation = '';
    let reply: string;
    if (text.length === 0) {
      reply = "I didn't catch what to do. Ask the user to say it again.";
    } else {
      try {
        reply = await this.host.command(text);
      } catch {
        reply = 'That did not work. Nothing changed.';
      }
    }
    this.debug.delegations.push({ id, text, reply });
    this.lastActivity = performance.now();
    this.send({
      type: 'session.commentary.append',
      delegation_id: id,
      content: `App result (say it briefly, in your own words): ${reply}`,
    });
  }

  private watchLevel(stream: MediaStream, which: 'in' | 'out'): void {
    try {
      this.ctx ??= new AudioContext();
      void this.ctx.resume().catch(() => undefined);
      const source = this.ctx.createMediaStreamSource(stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      if (which === 'out') this.outAnalyser = analyser;
      else this.inAnalyser = analyser;
    } catch {
      return;
    }
    if (this.raf !== 0) return;
    const buf = new Float32Array(512);
    const level = (a: AnalyserNode | null) => {
      if (a === null) return 0;
      a.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
      return Math.min(1, Math.sqrt(sum / buf.length) * 6);
    };
    const loop = () => {
      const out = level(this.outAnalyser);
      const inp = level(this.inAnalyser);
      if (out > this.debug.peakOutput) this.debug.peakOutput = out;
      if (out > 0.04) this.lastActivity = performance.now();
      this.host.levels(out, inp);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function waitForIce(peer: RTCPeerConnection, ms: number): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (peer.iceGatheringState !== 'complete') return;
      peer.removeEventListener('icegatheringstatechange', done);
      window.clearTimeout(timer);
      resolve();
    };
    // Gathering can stall without a STUN reply; host candidates are enough to try.
    const timer = window.setTimeout(() => {
      peer.removeEventListener('icegatheringstatechange', done);
      resolve();
    }, ms);
    peer.addEventListener('icegatheringstatechange', done);
  });
}

/** Can this browser try a talk session at all (WebRTC + mic)? */
export function talkSupported(): boolean {
  return typeof RTCPeerConnection !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}
