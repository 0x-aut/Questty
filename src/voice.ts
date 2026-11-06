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
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
};
type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

export function startDictation(
  onFinal: (transcript: string) => void,
  onError: (error: string) => void,
): () => void {
  if (typeof window === 'undefined') {
    onError('unsupported');
    return () => {};
  }
  const browser = window as SpeechRecognitionWindow;
  const Recognition = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  if (Recognition === undefined) {
    onError('unsupported');
    return () => {};
  }

  const recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result?.isFinal) onFinal(result[0]?.transcript ?? '');
    }
  };
  recognition.onerror = (event) => onError(event.error);
  try {
    recognition.start();
  } catch (error) {
    onError(error instanceof Error ? error.message : 'start-failed');
    return () => {};
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try {
      recognition.stop();
    } catch {
      // It may already have stopped after a browser-side speech error.
    }
  };
}
