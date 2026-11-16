/**
 * Voice capture for Questty.
 *
 * Primary path (desktop browsers and Quest Browser alike): record the mic with
 * MediaRecorder and send the clip to `/api/transcribe` (OpenAI speech-to-text,
 * key stays on the server). This behaves the same on every browser, unlike the
 * Web Speech API, which Quest Browser lacks and which Chromium only runs
 * through Google's servers.
 *
 * Fallback: when the server cannot transcribe (no OPENAI_API_KEY configured,
 * route missing, offline), use the browser's Web Speech API if it has one.
 * When neither works, the caller shows the no-AI quick quests instead.
 */

type SpeechRecognitionAlternativeLike = { transcript: string };
type SpeechRecognitionResultLike = ArrayLike<SpeechRecognitionAlternativeLike> & {
  isFinal: boolean;
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
};

export type VoiceEngine = 'recorder' | 'speech';
export type VoiceState = 'starting' | 'listening' | 'transcribing';

/** Error codes reported through `onError`. */
export type VoiceError =
  | 'insecure-context'
  | 'unsupported'
  | 'mic-denied'
  | 'mic-unavailable'
  | 'record-failed'
  | 'transcribe-failed'
  | 'speech-failed';

export type VoiceCallbacks = {
  onState(state: VoiceState, engine: VoiceEngine): void;
  /** Final transcript. An empty string means nothing was heard. */
  onTranscript(text: string): void;
  onError(error: VoiceError): void;
};

export type VoiceSession = {
  readonly engine: VoiceEngine;
  /** Stop listening and process what was said. */
  stop(): void;
  /** Stop listening and drop everything (no callbacks after this). */
  cancel(): void;
};

const MAX_RECORDING_MS = 30_000;
const TRANSCRIBE_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 4_000;
// Hands-free stop: once speech was heard, stop after this much quiet.
const SILENCE_STOP_MS = 2_200;
// Loud samples needed before a pause counts (ignores a single click or bump).
const MIN_LOUD_SAMPLES = 3;
const MIN_QUIET_SAMPLES = 6;
const SPEECH_RMS = 0.02;
const LEVEL_SAMPLE_MS = 100;
const SPEECH_END_GRACE_MS = 4_000;

let serverTranscription: Promise<boolean> | undefined;

/**
 * Asks `/api/transcribe` (GET) whether server transcription is configured.
 * Cached; a later failed upload clears the cache.
 */
export function checkServerTranscription(): Promise<boolean> {
  serverTranscription ??= (async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetch('/api/transcribe', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as { configured?: unknown };
      return payload.configured === true;
    } catch {
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  })();
  return serverTranscription;
}

function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  const browser = window as SpeechRecognitionWindow;
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

function canRecord(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    navigator.mediaDevices?.getUserMedia !== undefined
  );
}

/**
 * Starts voice capture. Call from a user action (the mic button). Returns a
 * session immediately; callbacks always fire later (never synchronously), and
 * `onState('listening', ...)` fires once the mic is live.
 */
export function startVoiceCapture(callbacks: VoiceCallbacks): VoiceSession {
  let inner: VoiceSession | undefined;
  let stopRequested = false;
  let cancelled = false;
  let engine: VoiceEngine = 'recorder';

  const guarded: VoiceCallbacks = {
    onState: (state, which) => {
      if (!cancelled) callbacks.onState(state, which);
    },
    onTranscript: (text) => {
      if (!cancelled) callbacks.onTranscript(text);
    },
    onError: (error) => {
      if (!cancelled) callbacks.onError(error);
    },
  };

  const session: VoiceSession = {
    get engine() {
      return engine;
    },
    stop() {
      stopRequested = true;
      inner?.stop();
    },
    cancel() {
      cancelled = true;
      inner?.cancel();
    },
  };

  if (typeof window === 'undefined') {
    queueMicrotask(() => guarded.onError('unsupported'));
    return session;
  }
  if (!window.isSecureContext) {
    // getUserMedia and Web Speech both need https (or localhost).
    queueMicrotask(() => guarded.onError('insecure-context'));
    return session;
  }

  // Callbacks never fire synchronously, so callers can store the session first.
  queueMicrotask(() => guarded.onState('starting', engine));
  void checkServerTranscription().then((serverReady) => {
    if (cancelled) return;
    const Recognition = speechRecognitionCtor();
    if (serverReady && canRecord()) {
      engine = 'recorder';
      inner = startRecorder(guarded);
    } else if (Recognition !== undefined) {
      engine = 'speech';
      inner = startSpeechRecognition(Recognition, guarded);
    } else {
      guarded.onError('unsupported');
      return;
    }
    if (stopRequested) inner.stop();
  });
  return session;
}

function startSpeechRecognition(
  Recognition: SpeechRecognitionCtor,
  callbacks: VoiceCallbacks,
): VoiceSession {
  const recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = navigator.language || 'en-US';
  let transcript = '';
  let done = false;
  let failed = false;
  let maxTimer: number | undefined;
  let endWatchdog: number | undefined;

  const finish = () => {
    if (done || failed) return;
    done = true;
    window.clearTimeout(maxTimer);
    window.clearTimeout(endWatchdog);
    callbacks.onTranscript(transcript.trim());
  };
  // Some browsers never fire `end` when their speech service is unreachable,
  // so a stop always resolves within a few seconds.
  const requestStop = () => {
    if (done) return;
    try {
      recognition.stop();
    } catch {
      // Already stopped after a browser-side speech error.
    }
    window.clearTimeout(endWatchdog);
    endWatchdog = window.setTimeout(finish, SPEECH_END_GRACE_MS);
  };

  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result?.isFinal) transcript += `${result[0]?.transcript ?? ''} `;
    }
  };
  recognition.onerror = (event) => {
    if (done) return;
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    failed = true;
    done = true;
    window.clearTimeout(maxTimer);
    window.clearTimeout(endWatchdog);
    callbacks.onError(
      event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'mic-denied'
        : event.error === 'audio-capture'
          ? 'mic-unavailable'
          : 'speech-failed',
    );
  };
  recognition.onend = finish;
  try {
    recognition.start();
    maxTimer = window.setTimeout(requestStop, MAX_RECORDING_MS);
    callbacks.onState('listening', 'speech');
  } catch {
    done = true;
    queueMicrotask(() => callbacks.onError('speech-failed'));
  }

  return {
    engine: 'speech',
    stop: requestStop,
    cancel() {
      done = true;
      window.clearTimeout(maxTimer);
      window.clearTimeout(endWatchdog);
      try {
        recognition.abort();
      } catch {
        // Already stopped.
      }
    },
  };
}

function pickMimeType(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type));
}

function startRecorder(callbacks: VoiceCallbacks): VoiceSession {
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let audioContext: AudioContext | undefined;
  let levelTimer: number | undefined;
  let autoStop: number | undefined;
  let stopRequested = false;
  let cancelled = false;
  let finished = false;
  const chunks: Blob[] = [];

  const release = () => {
    window.clearTimeout(autoStop);
    window.clearInterval(levelTimer);
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    void audioContext?.close().catch(() => undefined);
    audioContext = undefined;
  };
  const fail = (error: VoiceError) => {
    if (finished || cancelled) return;
    finished = true;
    release();
    callbacks.onError(error);
  };
  const stopRecording = () => {
    if (recorder?.state === 'recording') recorder.stop();
  };

  const upload = async (blob: Blob) => {
    if (cancelled) return;
    if (blob.size === 0) {
      finished = true;
      callbacks.onTranscript('');
      return;
    }
    callbacks.onState('transcribing', 'recorder');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: await blobToBase64(blob), mimeType: blob.type }),
        signal: controller.signal,
      });
      if (!response.ok) {
        // e.g. the key was removed: re-probe next time so Web Speech can take over.
        if (response.status === 500 || response.status === 404) serverTranscription = undefined;
        throw new Error(`transcribe-${response.status}`);
      }
      const payload = (await response.json()) as { text?: unknown };
      if (typeof payload.text !== 'string') throw new Error('transcribe-invalid');
      if (cancelled) return;
      finished = true;
      callbacks.onTranscript(payload.text.trim());
    } catch (error) {
      console.warn('[voice] Transcription failed.', error);
      fail('transcribe-failed');
    } finally {
      window.clearTimeout(timeout);
    }
  };

  // Hands-free stop: watch the mic level and stop after a pause in speech.
  const watchLevel = (micStream: MediaStream) => {
    try {
      audioContext = new AudioContext();
      void audioContext.resume().catch(() => undefined);
      const source = audioContext.createMediaStreamSource(micStream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      // Wall-clock timing, so a busy main thread (slow frames) cannot stretch the pause.
      let loudSamples = 0;
      let quietSamples = 0;
      let lastLoudAt = 0;
      levelTimer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
        const now = performance.now();
        if (Math.sqrt(sum / samples.length) > SPEECH_RMS) {
          loudSamples += 1;
          quietSamples = 0;
          lastLoudAt = now;
        } else {
          quietSamples += 1;
        }
        // Needs both enough quiet time and several quiet readings in a row, so
        // one late timer tick (a long frame) cannot cut the speaker off mid-word.
        if (
          loudSamples >= MIN_LOUD_SAMPLES &&
          quietSamples >= MIN_QUIET_SAMPLES &&
          now - lastLoudAt >= SILENCE_STOP_MS
        ) {
          stopRecording();
        }
      }, LEVEL_SAMPLE_MS);
    } catch {
      // No level meter (e.g. AudioContext blocked): tap-to-stop and the 30 s cap still work.
    }
  };

  void navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .then((micStream) => {
      stream = micStream;
      if (cancelled || stopRequested) {
        release();
        if (!cancelled) {
          finished = true;
          callbacks.onTranscript('');
        }
        return;
      }
      const mimeType = pickMimeType();
      try {
        // 32 kbps Opus is plenty for speech and keeps 30 s under ~150 KB.
        recorder = new MediaRecorder(micStream, {
          ...(mimeType ? { mimeType } : {}),
          audioBitsPerSecond: 32_000,
        });
      } catch {
        fail('record-failed');
        return;
      }
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => fail('record-failed');
      recorder.onstop = () => {
        const type = recorder?.mimeType || mimeType || 'audio/webm';
        release();
        if (cancelled || finished) return;
        void upload(new Blob(chunks, { type }));
      };
      recorder.start(250);
      autoStop = window.setTimeout(stopRecording, MAX_RECORDING_MS);
      watchLevel(micStream);
      callbacks.onState('listening', 'recorder');
    })
    .catch((error: unknown) => {
      const name = (error as { name?: unknown } | null)?.name;
      console.warn('[voice] getUserMedia failed:', name, error);
      fail(
        name === 'NotAllowedError' || name === 'SecurityError' ? 'mic-denied' : 'mic-unavailable',
      );
    });

  return {
    engine: 'recorder',
    stop() {
      if (finished || cancelled) return;
      if (recorder === undefined) {
        // Permission prompt still open: stop as soon as the mic opens.
        stopRequested = true;
        return;
      }
      stopRecording();
    },
    cancel() {
      cancelled = true;
      if (recorder?.state === 'recording') recorder.stop();
      release();
    },
  };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read-failed'));
    reader.readAsDataURL(blob);
  });
}
