import { createSystem, Matrix4, Quaternion, UIKit, UIKitMLAsset, Vector3 } from '@iwsdk/core';
import { allowFloatingFocus, createQuestCard, setQuestCardState, showFocusActionFor } from './quest-card.js';
import { setCardNote } from './documents.js';
import { setWelcomeCollapsed, suppressPillOpen } from './panel.js';
import { classify } from './buddy/parser.js';
import {
  askDumpDuplicates,
  buddyReady,
  buddyWantsAnswer,
  dismissBuddyQuestion,
  findDumpDuplicates,
  reportMic,
  reportMicLevel,
  sendBuddyCommand,
  setPushToTalk,
  toggleBuddyTalk,
  type MicState,
} from './buddy/bus.js';
import { setCardActionMode } from './session-events.js';
import { inferWhenFromTranscript, splitQuests, type QuestSuggestion } from './splitQuests.js';
import { isCategoryId, UNSORTED } from './category-config.js';
import { startVoiceCapture, type VoiceError, type VoiceSession } from './voice.js';
import { FLOAT_CARD_SCALE, homeForward, nextFreeSlot, type CardPose } from './card-layout.js';
import { floatingCardPositions } from './card-arrange.js';
import { QuestCard } from './quest-component.js';

type TemplateQuest = QuestSuggestion;

const TEMPLATES: Array<{ id: string; quest: TemplateQuest }> = [
  { id: 'template-email', quest: { title: 'Email reply', xp: 15, zone: 'desk' } },
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

/** Hero label + hint under the big mic, per voice state. */
const VOICE_LABELS: Record<VoiceUiState, string> = {
  idle: "What's on your mind?",
  starting: 'Opening the mic...',
  listening: "I'm listening",
  transcribing: 'Got it, writing it down...',
  thinking: 'Turning it into quests...',
  error: 'Pinch to try again',
};

const VOICE_HINTS: Record<VoiceUiState, string> = {
  idle: 'Pinch the orb and talk it through',
  starting: 'One moment',
  listening: 'Pause when you are done, or pinch the mic',
  transcribing: 'Hang tight',
  thinking: 'Splitting it into small quests',
  error: 'Or add a quick quest below',
};

/** What the buddy orb shows for each mic state (one mic, one orb: PR 6). */
const ORB_STATE: Record<VoiceUiState, MicState> = {
  idle: 'idle',
  starting: 'listening',
  listening: 'listening',
  transcribing: 'transcribing',
  thinking: 'transcribing',
  error: 'error',
};


const FOCUS_QUEST: QuestSuggestion = { title: 'Focus session', xp: 25, zone: 'desk' };
/** Focus session card: distance ahead and drop below the eyes (seated reach). */
const FOCUS_CARD_DISTANCE = 0.52;
const FOCUS_CARD_DROP = 0.14;
/** Width of a card's focus panel in card units (focus-action.uikitml). */
const FOCUS_PANEL_WIDTH_UNITS = 2.0;
const ORB_SIZE = 84;
const ORB_GROW = 20;

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
  private voiceHint?: UIKit.Text;
  private voiceOrb?: UIKit.Text;
  private orbLevel = 0;
  private lastOrbSize = ORB_SIZE;
  private quickOpen = false;
  private collapseTimer: number | undefined;
  private statusTimer: number | undefined;
  private disposed = false;
  private readonly headPosition = new Vector3();
  private readonly forward = new Vector3();

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    if (panel == null) return;
    this.statusPanel = panel.getElementById<UIKit.Text>('quest-status') ?? undefined;
    this.statusText = panel.getElementById<UIKit.Text>('quest-status-text') ?? undefined;
    this.voiceLabel = panel.getElementById<UIKit.Text>('voice-button-label') ?? undefined;
    this.voiceHint = panel.getElementById<UIKit.Text>('voice-hint') ?? undefined;
    this.voiceOrb = panel.getElementById<UIKit.Text>('voice-orb') ?? undefined;

    const quickList = panel.getElementById('quick-list');
    const quickMore = panel.getElementById('quick-more');
    const quickMoreLabel = panel.getElementById('quick-more-label');
    const onQuickMore = () => {
      this.quickOpen = !this.quickOpen;
      quickList?.setProperties({ display: this.quickOpen ? 'flex' : 'none' });
      quickMoreLabel?.setProperties({ text: this.quickOpen ? 'Hide quests' : 'Quick quest' });
    };
    quickMore?.addEventListener('click', onQuickMore);
    this.cleanupFuncs.push(() => quickMore?.removeEventListener('click', onQuickMore));

    const quickFocus = panel.getElementById('quick-focus');
    const onQuickFocus = () => {
      void this.startFocusSession().catch((error: unknown) => {
        console.warn('[quest] Focus session quick start failed.', error);
      });
    };
    quickFocus?.addEventListener('click', onQuickFocus);
    this.cleanupFuncs.push(() => quickFocus?.removeEventListener('click', onQuickFocus));

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

    // PR 6: the pill's orb is the buddy's mic. Pinch it to talk (tap to start,
    // tap again to stop); the rest of the pill still opens the panel.
    const pillOrb = panel.getElementById('pill-orb');
    const onPillOrb = (event?: { stopPropagation?: () => void }) => {
      suppressPillOpen();
      event?.stopPropagation?.();
      // PR 7: with no push-to-talk in progress, the orb starts/stops a talk
      // session (GPT-Live). Without Live it stays push-to-talk.
      if ((this.voiceState === 'idle' || this.voiceState === 'error') && toggleBuddyTalk()) return;
      this.onVoiceButton();
    };
    setPushToTalk(() => {
      if (this.voiceState === 'idle') this.onVoiceButton();
    });
    this.cleanupFuncs.push(() => setPushToTalk(undefined));
    pillOrb?.addEventListener('click', onPillOrb as never);
    this.cleanupFuncs.push(() => pillOrb?.removeEventListener('click', onPillOrb as never));

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
      window.clearTimeout(this.collapseTimer);
    });
  }

  /**
   * Focus session quick start: one card that floats within easy seated reach
   * (about half a metre ahead, a little below the eyes, facing the user, its
   * focus panel on its right, clear of the home panel), with the length
   * picker open. It works right there; the user can also drag it onto any
   * wall, desk or door, before or during focus.
   */
  private async startFocusSession(): Promise<void> {
    const pose = this.focusCardPose();
    const card = await createQuestCard({
      title: FOCUS_QUEST.title,
      xp: FOCUS_QUEST.xp,
      position: pose.position,
      quaternion: pose.quaternion,
      focusReady: true,
    });
    const cardId = card.getValue(QuestCard, 'cardId') as string;
    allowFloatingFocus(cardId);
    setQuestCardState(card, 'Pick a length here, or drag me onto a wall or desk');
    // Applied as soon as the card's focus control exists.
    setCardActionMode(cardId, 'pick');
    showFocusActionFor(card);
    this.setStatus('Focus card is ready in front of you: pick a length', 'done');
    this.statusTimer = window.setTimeout(() => this.setStatus(undefined), 6_000);
  }

  /** Floating pose for the Focus session card, ~0.52 m ahead and 0.14 m below the eyes. */
  private focusCardPose(): CardPose {
    const head = this.world.player.head;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(this.headPosition);
    head.getWorldDirection(this.forward);
    this.forward.negate();
    const forward = homeForward(this.forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
    forward.normalize();
    const right = new Vector3(-forward.z, 0, forward.x);
    // Shift left by half the focus panel so card + panel sit centred ahead.
    const panelShift = (FOCUS_PANEL_WIDTH_UNITS * FLOAT_CARD_SCALE + 0.015) / 2;
    const position = this.headPosition
      .clone()
      .addScaledVector(forward, FOCUS_CARD_DISTANCE)
      .addScaledVector(right, -panelShift);
    position.y = this.headPosition.y - FOCUS_CARD_DROP;
    const look = new Matrix4().lookAt(this.headPosition, position, new Vector3(0, 1, 0));
    return { position, quaternion: new Quaternion().setFromRotationMatrix(look) };
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
    window.clearTimeout(this.collapseTimer);
    const session = startVoiceCapture({
      onLevel: (rms) => {
        if (this.voiceSession !== session) return;
        this.orbLevel = this.orbLevel * 0.5 + Math.min(1, rms / 0.12) * 0.5;
        reportMicLevel(this.orbLevel);
        this.applyOrb();
      },
      onState: (state, engine) => {
        if (this.disposed || this.voiceSession !== session) return;
        // The big mic shows the state; the small status line stays for extra info.
        if (state === 'starting') this.setVoiceState('starting', undefined);
        else if (state === 'listening') {
          this.setVoiceState(
            'listening',
            engine === 'recorder' ? undefined : 'Using browser speech (no server key).',
            'listening',
          );
        } else this.setVoiceState('transcribing', undefined);
      },
      onTranscript: (text) => {
        if (this.disposed || this.voiceSession !== session) return;
        this.voiceSession = undefined;
        if (text.trim().length === 0) {
          this.setVoiceState('error', 'Did not catch that. Tap the mic and try again.', 'error');
          return;
        }
        // One mic, two jobs (PR 6): a command goes to the buddy, a brain dump
        // (a list, "I need to...") becomes cards as before.
        // PR 8: "yes" / "skip" / "show it" answer the buddy's pending
        // duplicate question, whatever the router would call them.
        if (buddyReady() && (buddyWantsAnswer(text) || classify(text) === 'command')) {
          this.setVoiceState('idle', undefined);
          sendBuddyCommand(text, 'voice');
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
    // A new brain dump is "another command": a pending buddy question lapses silently.
    dismissBuddyQuestion();
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
      // Optional `when` (PR 5): keep a known category from the AI; otherwise
      // read the timing words in the transcript ourselves. Older servers that
      // send no `when` still work.
      quests = payload.quests.map((quest) => {
        const fromAi = isCategoryId(quest.when) && quest.when !== UNSORTED ? quest.when : null;
        const when = fromAi ?? inferWhenFromTranscript(quest.title, text);
        const { when: _ignored, ...rest } = quest;
        return when !== null ? { ...rest, when } : rest;
      });
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
    // PR 8: items already on the board are not added; the buddy asks once about them.
    const dupIdx = new Set(findDumpDuplicates(quests.map((q) => q.title)));
    const fresh = quests.filter((_, i) => !dupIdx.has(i));
    const dups = quests.filter((_, i) => dupIdx.has(i));
    try {
      await this.spawnFloatingQuests(fresh, text);
    } catch (error) {
      console.warn('[quest] Could not create dictated quest cards.', error);
    }
    if (this.disposed) return;
    const count = fresh.length;
    const added =
      count === 0
        ? `Nothing new: ${dups.length === 1 ? "it's" : "they're"} already on your board.`
        : `Added ${count} quest${count === 1 ? '' : 's'}${usedAi ? '' : ' (offline split)'}.`;
    this.setVoiceState('idle', added, 'done');
    if (dups.length > 0) {
      setWelcomeCollapsed(true);
      askDumpDuplicates(
        dups.map((q) => ({ title: q.title, category: q.when, xp: q.xp })),
        count,
      );
      this.statusTimer = window.setTimeout(() => {
        if (this.voiceState === 'idle') this.setStatus(undefined);
      }, 6_000);
      return;
    }
    reportMic('cards', added);
    this.statusTimer = window.setTimeout(() => {
      if (this.voiceState === 'idle') this.setStatus(undefined);
    }, 6_000);
    // Get out of the way once the cards are out: shrink to the pill.
    this.collapseTimer = window.setTimeout(() => {
      if (this.voiceState === 'idle') setWelcomeCollapsed(true);
    }, 4_500);
  }

  private applyOrb(): void {
    const size = Math.round(ORB_SIZE + (this.voiceState === 'listening' ? this.orbLevel * ORB_GROW : 0));
    if (size === this.lastOrbSize) return;
    this.lastOrbSize = size;
    this.voiceOrb?.setProperties({ width: size, height: size, borderRadius: size / 2 } as never);
  }

  private async spawnFloatingQuests(quests: QuestSuggestion[], transcript?: string): Promise<void> {
    for (const quest of quests) {
      await this.spawnFloatingQuest(quest, transcript);
    }
  }

  private async spawnFloatingQuest(quest: QuestSuggestion, transcript?: string): Promise<void> {
    const pose = this.getNextFloatingPose();
    const card = await createQuestCard({
      title: quest.title,
      xp: quest.xp,
      position: pose.position,
      quaternion: pose.quaternion,
      category: quest.when,
    });
    // PR 10: a card from a brain dump keeps the words it came from, as notes the buddy can open.
    if (transcript !== undefined && transcript.trim().length > 0) {
      setCardNote(card.getValue(QuestCard, 'cardId') as string, `# ${quest.title}\n\nFrom your brain dump:\n\n${transcript.trim()}`);
    }
  }

  /** Next free slot in the seated-reach arc (see card-layout.ts). */
  private getNextFloatingPose(): CardPose {
    const head = this.world.player.head;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(this.headPosition);
    head.getWorldDirection(this.forward);
    this.forward.negate();
    return nextFreeSlot(this.headPosition, homeForward(this.forward), floatingCardPositions(this.queries.cards.entities));
  }

  private setVoiceState(
    state: VoiceUiState,
    status: string | undefined,
    tone: keyof typeof STATUS_COLORS = 'busy',
  ): void {
    this.voiceState = state;
    this.voiceLabel?.setProperties({ text: VOICE_LABELS[state] });
    this.voiceHint?.setProperties({ text: VOICE_HINTS[state] });
    // The glowing buddy orb (buddy/orb.ts) shows the state now, in the panel and the pill.
    reportMic(ORB_STATE[state], state === 'error' ? status : undefined);
    if (state !== 'listening') {
      this.orbLevel = 0;
      this.applyOrb();
    }
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
