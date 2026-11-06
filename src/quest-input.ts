import { createSystem, UIKit, UIKitMLAsset } from '@iwsdk/core';
import { createQuestCard } from './quest-card.js';
import { splitQuests, type QuestSuggestion } from './splitQuests.js';
import { startDictation } from './voice.js';
import { getZonePlacement } from './zones.js';
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

export class QuestInputSystem extends createSystem({
  cards: { required: [QuestCard] },
}) {
  private stopDictation: (() => void) | undefined;
  private requestController: AbortController | undefined;
  private statusPanel?: UIKit.Text;
  private statusText?: UIKit.Text;
  private voiceButton?: UIKit.Text;
  private disposed = false;

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    if (panel == null) return;
    this.statusPanel = panel.getElementById<UIKit.Text>('quest-status') ?? undefined;
    this.statusText = panel.getElementById<UIKit.Text>('quest-status-text') ?? undefined;

    for (const { id, quest } of TEMPLATES) {
      const button = panel.getElementById(id);
      if (button == null) continue;
      const spawn = () => {
        void this.spawnPinnedQuest(quest).catch((error: unknown) => {
          console.warn('[quest] Could not create template card.', error);
        });
      };
      button.addEventListener('click', spawn);
      this.cleanupFuncs.push(() => button.removeEventListener('click', spawn));
    }

    this.voiceButton = panel.getElementById<UIKit.Text>('voice-button') ?? undefined;
    if (this.voiceButton !== undefined) {
      const onVoiceClick = () => this.toggleDictation();
      this.voiceButton.addEventListener('click', onVoiceClick);
      this.cleanupFuncs.push(() => this.voiceButton?.removeEventListener('click', onVoiceClick));
    }

    this.cleanupFuncs.push(() => {
      this.disposed = true;
      this.stopDictation?.();
      this.requestController?.abort();
    });
  }

  private toggleDictation(): void {
    if (this.stopDictation !== undefined) {
      this.stopDictation();
      this.stopDictation = undefined;
      this.setStatus(undefined);
      return;
    }

    this.setStatus('Listening...');
    let failedToStart = false;
    const stop = startDictation(
      (text) => {
        this.stopDictation?.();
        this.stopDictation = undefined;
        if (text.trim().length === 0) {
          this.setStatus(undefined);
          return;
        }
        void this.createFromSpeech(text);
      },
      (error) => {
        failedToStart = true;
        this.stopDictation = undefined;
        this.setStatus(error === 'unsupported' ? 'Voice is not supported here.' : 'Could not hear that.');
      },
    );
    if (!failedToStart) this.stopDictation = stop;
  }

  private async createFromSpeech(text: string): Promise<void> {
    this.setStatus('Thinking...');
    const controller = new AbortController();
    this.requestController = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    let quests: QuestSuggestion[];
    try {
      const response = await fetch('/api/quests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
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
    } catch {
      quests = splitQuests(text);
    } finally {
      window.clearTimeout(timeout);
      if (this.requestController === controller) this.requestController = undefined;
    }

    if (this.disposed) return;
    try {
      await this.spawnPinnedQuests(quests);
    } catch (error) {
      console.warn('[quest] Could not create dictated quest cards.', error);
    }
    this.setStatus(undefined);
  }

  private async spawnPinnedQuests(quests: QuestSuggestion[]): Promise<void> {
    const stackCounts = new Map<string, number>();
    for (const quest of quests) {
      const count = stackCounts.get(quest.zone) ?? this.countCardsInZone(quest.zone);
      const placement = getZonePlacement(quest.zone, count);
      if (placement === null) continue;
      await createQuestCard({
        title: quest.title,
        xp: quest.xp,
        zoneId: quest.zone,
        position: placement.position,
      });
      stackCounts.set(quest.zone, count + 1);
    }
  }

  private async spawnPinnedQuest(quest: QuestSuggestion): Promise<void> {
    const stackIndex = this.countCardsInZone(quest.zone);
    const placement = getZonePlacement(quest.zone, stackIndex);
    if (placement === null) return;
    await createQuestCard({
      title: quest.title,
      xp: quest.xp,
      zoneId: quest.zone,
      position: placement.position,
    });
  }

  private countCardsInZone(zone: QuestSuggestion['zone']): number {
    let count = 0;
    for (const entity of this.queries.cards.entities) {
      if (entity.getValue(QuestCard, 'zoneId') === zone) count += 1;
    }
    return count;
  }

  private setStatus(text: string | undefined): void {
    this.statusPanel?.setProperties({ display: text === undefined ? 'none' : 'flex' });
    if (text !== undefined) this.statusText?.setProperties({ text });
  }
}
