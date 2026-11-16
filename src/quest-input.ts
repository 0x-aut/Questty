import { createSystem, UIKit, UIKitMLAsset, Vector3 } from '@iwsdk/core';
import { createQuestCard } from './quest-card.js';
import { splitQuests, type QuestSuggestion } from './splitQuests.js';
import { startVoiceCapture, type VoiceError, type VoiceSession } from './voice.js';
import { QuestCard } from './quest-component.js';

type TemplateQuest = QuestSuggestion;

const TEMPLATES: Array<{ id: string; quest: TemplateQuest }> = [
  { id: 'template-email', quest: { title: 'Email reply', xp: 15, zone: 'desk' } },
  { id: 'template-deep-work', quest: { title: 'Deep work 25m', xp: 30, zone: 'desk' } },
  { id: 'template-errand', quest: { title: 'Errand', xp: 20, zone: 'door' } },
  { id: 'template-exercise', quest: { title: 'Exercise', xp: 25, zone: 'wall' } },
  { id: 'template-plan', quest: { title: 'Plan tomorrow', xp: 20, zone: 'desk' } },
];

function isQuestSuggestion(value: unknown): value is QuestSuggestion {
  if (typeof value !== 'object' || value === null) return false;
  const quest = value as Record<string, unknown>;
  return (
    typeof quest.title === 'string' &&
    Number.isInteger(quest.xp) &&
    (quest.xp as number) >= 10 &&
    (quest.xp as number) <= 50 &&
    (quest.zone === 'desk' || quest.zone === 'door' || quest.zone === 'wall')
  );
}

type VoiceUiState = 'idle' | 'starting' | 'listening' | 'transcribing' | 'thinking' | 'error';

const VOICE_LABELS: Record<VoiceUiState, string> = {
  idle: 'Speak a quest',
  starting: 'Starting mic...',
  listening: 'Done talking',
  transcribing: 'Transcribing...',
  thinking: 'Making quests...',
  error: 'Try voice again',
};

// Status pill colors: warm for listening, neutral for work in progress,
// soft red for problems. Dark text stays readable on all of them.
const STATUS_COLORS = {
  listening: '#f7c4b8',
  busy: '#e8dfc9',
  done: '#cfe8c6',
  error: '#f2b6ae',
} as const;

function voiceErrorMessage(error: VoiceError): string {
  switch (error) {
    case 'insecure-context':
      return 'Voice needs an https:// page. Use the quick quests.';
    case 'unsupported':
      return 'Voice is not set up here. Use the quick quests.';
    case 'mic-denied':
      return 'Mic access is off. Allow it in browser settings.';
    case 'mic-unavailable':
      return 'Could not open the microphone. Check it is on and allowed.';
    case 'transcribe-failed':
      return 'Could not transcribe that. Tap the mic to retry.';
    case 'record-failed':
      return 'Recording stopped unexpectedly. Try again.';
    default:
      return 'Could not hear that. Tap the mic to retry.';
  }
}

export class QuestInputSystem extends createSystem({
  cards: { required: [QuestCard] },
}) {
  private voiceSession: VoiceSession | undefined;
  private voiceState: VoiceUiState = 'idle';
  private requestController: AbortController | undefined;
  private statusPanel?: UIKit.Text;
  private statusText?: UIKit.Text;
  private voiceButton?: UIKit.Text;
  private voiceLabel?: UIKit.Text;
  private statusTimer: number | undefined;
  private disposed = false;
  private floatingSlot = 0;
  private readonly headPosition = new Vector3();
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly floatingPosition = new Vector3();

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    if (panel == null) return;
    this.statusPanel = panel.getElementById<UIKit.Text>('quest-status') ?? undefined;
    this.statusText = panel.getElementById<UIKit.Text>('quest-status-text') ?? undefined;
    this.voiceLabel = panel.getElementById<UIKit.Text>('voice-button-label') ?? undefined;

    for (const { id, quest } of TEMPLATES) {
      const button = panel.getElementById(id);
      if (button == null) continue;
      const spawn = () => {
        void this.spawnFloatingQuest(quest).catch((error: unknown) => {
          console.warn('[quest] Could not create template card.', error);
        });
      };
      button.addEventListener('click', spawn);
      this.cleanupFuncs.push(() => button.removeEventListener('click', spawn));
    }

    this.voiceButton = panel.getElementById<UIKit.Text>('voice-button') ?? undefined;
    if (this.voiceButton !== undefined) {
      const onVoiceClick = () => this.onVoiceButton();
      this.voiceButton.addEventListener('click', onVoiceClick);
      this.cleanupFuncs.push(() => this.voiceButton?.removeEventListener('click', onVoiceClick));
    }

    this.cleanupFuncs.push(() => {
      this.disposed = true;
      this.voiceSession?.cancel();
      this.voiceSession = undefined;
      this.requestController?.abort();
      window.clearTimeout(this.statusTimer);
    });
  }

  /** Mic button: tap to start, tap again to finish (it also stops on a pause). */
  private onVoiceButton(): void {
    switch (this.voiceState) {
      case 'starting':
      case 'listening':
        this.voiceSession?.stop();
        return;
      case 'transcribing':
      case 'thinking':
        return; // Busy: ignore extra taps.
      default:
        this.startVoice();
    }
  }

  private startVoice(): void {
    const session = startVoiceCapture({
      onState: (state, engine) => {
        if (this.disposed || this.voiceSession !== session) return;
        if (state === 'starting') this.setVoiceState('starting', 'Starting mic...', 'busy');
        else if (state === 'listening') {
          this.setVoiceState(
            'listening',
            engine === 'recorder'
              ? 'Listening... say your tasks, then pause or tap Done.'
              : 'Listening (browser speech)... say your tasks.',
            'listening',
          );
        } else this.setVoiceState('transcribing', 'Transcribing...', 'busy');
      },
      onTranscript: (text) => {
        if (this.disposed || this.voiceSession !== session) return;
        this.voiceSession = undefined;
        if (text.trim().length === 0) {
          this.setVoiceState('error', 'Did not catch that. Tap the mic and try again.', 'error');
          return;
        }
        void this.createFromSpeech(text);
      },
      onError: (error) => {
        if (this.disposed || this.voiceSession !== session) return;
        this.voiceSession = undefined;
        console.warn('[voice]', error);
        this.setVoiceState('error', voiceErrorMessage(error), 'error');
      },
    });
    this.voiceSession = session;
  }

  private async createFromSpeech(text: string): Promise<void> {
    this.setVoiceState('thinking', `Making quests from: "${truncate(text, 60)}"`, 'busy');
    const controller = new AbortController();
    this.requestController = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    let quests: QuestSuggestion[];
    let usedAi = true;
    try {
      const response = await fetch('/api/quests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: truncate(text, 1_000) }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Quest API returned ${response.status}`);
      const payload = (await response.json()) as { quests?: unknown };
      if (
        !Array.isArray(payload.quests) ||
        payload.quests.length < 3 ||
        payload.quests.length > 5 ||
        !payload.quests.every(isQuestSuggestion)
      ) {
        throw new Error('Quest API returned invalid quests');
      }
      quests = payload.quests;
    } catch (error) {
      // No AI (no key, offline, bad reply): split the sentence locally instead.
      console.warn('[quest] Falling back to local split.', error);
      usedAi = false;
      quests = splitQuests(text);
    } finally {
      window.clearTimeout(timeout);
      if (this.requestController === controller) this.requestController = undefined;
    }

    if (this.disposed) return;
    if (quests.length === 0) {
      this.setVoiceState('error', 'Did not catch any tasks. Try again.', 'error');
      return;
    }
    try {
      await this.spawnFloatingQuests(quests);
    } catch (error) {
      console.warn('[quest] Could not create dictated quest cards.', error);
    }
    if (this.disposed) return;
    const count = quests.length;
    this.setVoiceState(
      'idle',
      `Added ${count} quest${count === 1 ? '' : 's'}${usedAi ? '' : ' (offline split)'}.`,
      'done',
    );
    this.statusTimer = window.setTimeout(() => {
      if (this.voiceState === 'idle') this.setStatus(undefined);
    }, 6_000);
  }

  private async spawnFloatingQuests(quests: QuestSuggestion[]): Promise<void> {
    for (const quest of quests) {
      await this.spawnFloatingQuest(quest);
    }
  }

  private async spawnFloatingQuest(quest: QuestSuggestion): Promise<void> {
    const position = this.getNextFloatingPosition();
    await createQuestCard({
      title: quest.title,
      xp: quest.xp,
      position,
    });
  }

  private getNextFloatingPosition(): Vector3 {
    // Two rows of three in front of the player; the seventh card reuses slot one.
    const index = this.floatingSlot % 6;
    this.floatingSlot += 1;
    const column = index % 3;
    const row = Math.floor(index / 3);

    const head = this.world.player.head;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(this.headPosition);
    head.getWorldDirection(this.forward);
    this.forward.negate();
    this.forward.y = 0;
    if (this.forward.lengthSq() < 0.0001) this.forward.set(0, 0, -1);
    else this.forward.normalize();
    this.right.set(-this.forward.z, 0, this.forward.x).normalize();

    this.floatingPosition
      .copy(this.headPosition)
      .addScaledVector(this.forward, 0.95 + row * 0.05)
      .addScaledVector(this.right, (column - 1) * 0.42);
    // Chest height, below the welcome panel, so new cards never hide the mic button.
    this.floatingPosition.y -= 0.32 + row * 0.34;
    return this.floatingPosition.clone();
  }

  private setVoiceState(
    state: VoiceUiState,
    status: string | undefined,
    tone: keyof typeof STATUS_COLORS = 'busy',
  ): void {
    this.voiceState = state;
    this.voiceLabel?.setProperties({ text: VOICE_LABELS[state] });
    this.setStatus(status, tone);
  }

  private setStatus(text: string | undefined, tone: keyof typeof STATUS_COLORS = 'busy'): void {
    window.clearTimeout(this.statusTimer);
    this.statusPanel?.setProperties({
      display: text === undefined ? 'none' : 'flex',
      backgroundColor: STATUS_COLORS[tone],
    });
    if (text !== undefined) this.statusText?.setProperties({ text });
  }
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 3).join('')}...`;
}
