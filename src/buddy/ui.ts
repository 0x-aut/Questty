/**
 * The AI buddy (PR 6): talk to your room and it gets things done.
 *
 * BuddySystem owns what the user sees and touches:
 *  - the orb (orb.ts), living in the home panel: the hero mic spot when the
 *    panel is open, the pill when it is collapsed. Pinch it to talk (the same
 *    tap-to-start / tap-to-stop mic as before);
 *  - caption bubbles under the pill, with big chips (Undo, Confirm, Start the
 *    first one?, first-run suggestions), fading after ~4 s;
 *  - a light line from the orb to every card it touches, and an acknowledge
 *    pulse on the card;
 *  - "plan my day" order badges on the cards.
 *
 * The pipeline: transcript -> /api/buddy (AI, validated) or the offline
 * parser -> executor.ts. See README/PR 6 for the safety rules.
 */
import {
  CanvasTexture,
  createSystem,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PokeInteractable,
  Quaternion,
  RayInteractable,
  SRGBColorSpace,
  UIKit,
  UIKitMLAsset,
  Vector3,
  type Entity,
} from '@iwsdk/core';
import { QuestCard, QuestCardTween } from '../quest-component.js';
import { createQuestCard, findQuestCard, onCardEvent } from '../quest-card.js';
import { pulseCards } from '../categories.js';
import { isWelcomeCollapsed, setWelcomeCollapsed } from '../panel.js';
import { getBuddyFocusApi } from '../session-events.js';
import { focusNow } from '../focus-store.js';
import { CARD_UNITS_H, CARD_UNITS_W, homeForward, nextFreeSlot } from '../card-layout.js';
import { floatingCardPositions } from '../card-arrange.js';
import { cleanReply, validateActions, type BuddyAction, type BuddyCard, type Rejection } from './actions.js';
import { classify, parseCommand } from './parser.js';
import { askBuddyApi, resetBuddyApiBackoff, type FocusInfo } from './client.js';
import { BuddyExecutor, type ExecResult, type Offer, type UndoEntry } from './executor.js';
import { BuddyOrb, type OrbState } from './orb.js';
import { BUDDY_SLOW, LightLines } from './light-line.js';
import { setBuddyLink, type MicState } from './bus.js';

const USED_KEY = 'questty.buddy.v1';
/** UIKit px -> metres at the home panel's scale (0.01 units/px x 0.1). */
const PX_AT_PANEL = 0.001;
const ORB_FILL = 0.84;
const ORB_FORWARD = 0.012;
const BUBBLE_GAP = 0.012;
const BUBBLE_SCALE = 0.1;
const FADE_IN_MS = 220;
const FADE_OUT_MS = 380;
const LINE_COLOR = '#ffe7b0';
const ACK_COLOR = '#f2d27c';
const SUGGESTIONS = ["What's left today?", 'Plan my day'];

type ChipKind = 'plain' | 'primary' | 'danger';
type Chip = { label: string; kind: ChipKind; run: () => void };
const CHIP_STYLE: Record<ChipKind, { bg: string; border: string }> = {
  plain: { bg: '#e6dece', border: '#d3c9b4' },
  primary: { bg: '#f0d787', border: '#d8bb5e' },
  danger: { bg: '#efc4b9', border: '#d69a8c' },
};

type Bubble = {
  entity: Entity;
  panel: UIKitMLAsset;
  text: string;
  tag: string;
  chips: Chip[];
  shownAt: number;
  until: number;
  opacity: number;
  lastOpacity: number;
  sticky: boolean;
  hovered: boolean;
};

type RunRecord = {
  text: string;
  source: 'voice' | 'tap';
  mode: 'ai' | 'offline' | 'local';
  apiError?: string;
  actions: BuddyAction[];
  rejected: Rejection[];
  reply: string;
  log: ExecResult['log'];
  at: number;
};

let badgeTextures = new Map<number, CanvasTexture>();
function badgeTexture(n: number): CanvasTexture {
  const cached = badgeTextures.get(n);
  if (cached !== undefined) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    // Soft shadow, gold disc, thin paper rim, dark numeral.
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.arc(64, 68, 54, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f7f1e4';
    ctx.beginPath();
    ctx.arc(64, 64, 54, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ecd07c';
    ctx.beginPath();
    ctx.arc(64, 64, 47, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2b2416';
    ctx.font = '700 64px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), 64, 68);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  badgeTextures.set(n, texture);
  return texture;
}

export class BuddySystem extends createSystem({
  cards: { required: [QuestCard] },
}) {
  private orb!: BuddyOrb;
  private orbEntity?: Entity;
  private lines!: LightLines;
  private executor!: BuddyExecutor;
  private bubble?: Bubble;
  private bubblePending = false;
  private bubbleQueued?: { text: string; tag: string; chips: Chip[]; ms: number; sticky: boolean };
  private busy = false;
  private orbHoldUntil = 0;
  private orbAfter: OrbState = 'idle';
  private readonly undoStack: UndoEntry[] = [];
  private pendingOffer?: Offer;
  private plan: string[] | null = null;
  private readonly badges = new Map<string, Mesh>();
  private readonly orbLog: Array<{ state: OrbState; at: number }> = [];
  private readonly runs: RunRecord[] = [];
  private used = false;
  private orbRadius = 0;
  private readonly orbPos = new Vector3();
  private readonly tmp = new Vector3();
  private readonly tmpQ = new Quaternion();
  private readonly head = new Vector3();
  private micState: MicState = 'idle';

  init(): void {
    try {
      this.used = localStorage.getItem(USED_KEY) === 'used';
    } catch {
      this.used = false;
    }
    this.orb = new BuddyOrb();
    this.orbEntity = this.world.createTransformEntity(this.orb.group, { parent: this.world.sceneEntity, persistent: true });
    this.lines = new LightLines();
    this.world.createTransformEntity(this.lines.group, { parent: this.world.sceneEntity, persistent: true });
    this.executor = new BuddyExecutor({
      spawnCard: (title, category) => this.spawnCard(title, category),
      getPlan: () => (this.plan === null ? null : [...this.plan]),
      setPlan: (order) => this.setPlan(order),
      cards: () => this.cardList(),
    });
    this.logOrb('idle');

    setBuddyLink({
      command: (text, source) => void this.handle(text, source),
      mic: (state, detail) => this.onMic(state, detail),
      level: (level) => this.orb.setLevel(level),
    });

    const off = onCardEvent((type, entity) => {
      if (type !== 'completed' && type !== 'removed') return;
      const id = entity.getValue(QuestCard, 'cardId') as string;
      this.removeBadge(id);
      if (this.plan !== null && type === 'removed') {
        // Keep numbers honest: the plan loses the card, the rest renumber.
        const next = this.plan.filter((x) => x !== id);
        if (next.length !== this.plan.length) window.setTimeout(() => this.setPlan(next.length > 0 ? next : null), 0);
      }
    });

    if (import.meta.env.DEV) {
      const w = window as unknown as { __questty?: Record<string, unknown> };
      w.__questty = {
        ...w.__questty,
        buddy: {
          state: () => this.debugState(),
          run: (text: string) => this.handle(text, 'tap'),
          parse: (text: string) => parseCommand(text, this.cardList()),
          classify: (text: string) => classify(text),
          validate: (raw: unknown) => validateActions(raw, new Set(this.cardList().map((c) => c.id))),
          cards: () => this.cardList(),
          undo: () => this.undo(),
          chip: (index: number) => this.onChip(index),
          resetApi: () => resetBuddyApiBackoff(),
          orb: (state: OrbState) => this.setOrb(state),
          say: (text: string) => this.say(text, { ms: 4000 }),
          forgetUsed: () => {
            this.used = false;
            try {
              localStorage.removeItem(USED_KEY);
            } catch {
              // ignore
            }
          },
        },
      };
    }

    this.cleanupFuncs.push(off, () => {
      setBuddyLink(undefined);
      this.orb.dispose();
    });
  }

  update(): void {
    const now = performance.now();
    this.placeOrb(now);
    this.lines.update(now);
    if (!this.busy && this.orbHoldUntil > 0 && now > this.orbHoldUntil) {
      this.orbHoldUntil = 0;
      this.setOrb(this.orbAfter);
    }
    this.updateBubble(now);
  }

  // ------------------------------------------------------------ the orb

  private setOrb(state: OrbState, holdMs = 0, after: OrbState = 'idle'): void {
    if (this.orb.state !== state) this.logOrb(state);
    this.orb.setState(state);
    this.orbHoldUntil = holdMs > 0 ? performance.now() + holdMs * BUDDY_SLOW : 0;
    this.orbAfter = after;
  }

  private logOrb(state: OrbState): void {
    this.orbLog.push({ state, at: Math.round(performance.now()) });
    if (this.orbLog.length > 80) this.orbLog.shift();
  }

  /** Over the panel's mic spot: the hero orb when open, the pill orb when collapsed. */
  private placeOrb(now: number): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    if (panel == null) return;
    const collapsed = isWelcomeCollapsed();
    const el = panel.getElementById(collapsed ? 'pill-orb' : 'voice-orb');
    if (el == null) return;
    panel.updateWorldMatrix(true, false);
    el.updateWorldMatrix(true, false);
    const e = el.matrixWorld.elements;
    panel.getWorldQuaternion(this.tmpQ);
    const px = PX_AT_PANEL * (panel.scale.x / 0.1);
    const diameterPx = collapsed ? 56 : 84;
    this.orbRadius = (diameterPx * px * ORB_FILL) / 2;
    this.tmp.set(0, 0, 1).applyQuaternion(this.tmpQ);
    this.orbPos.set(e[12], e[13], e[14]).addScaledVector(this.tmp, ORB_FORWARD);
    const group = this.orb.group;
    group.position.copy(this.orbPos);
    group.quaternion.copy(this.tmpQ);
    group.visible = panel.visible !== false;
    this.orb.update(now, this.orbRadius, this.world.player.head);
  }

  // ------------------------------------------------------------ mic link

  private onMic(state: MicState, detail?: string): void {
    this.micState = state;
    if (this.busy) return;
    switch (state) {
      case 'listening':
        this.setOrb('listening');
        if (isWelcomeCollapsed()) this.say("I'm listening...", { tag: 'LISTENING', sticky: true });
        break;
      case 'transcribing':
        this.setOrb('thinking');
        if (isWelcomeCollapsed()) this.say('Got it, one moment...', { tag: 'THINKING', sticky: true });
        break;
      case 'cards':
        this.setOrb('done', 1400);
        if (isWelcomeCollapsed() && detail) this.say(detail, { ms: 4000 });
        else this.hideBubble();
        break;
      case 'error':
        this.setOrb('error', 1800);
        if (isWelcomeCollapsed() && detail) this.say(detail, { ms: 4500 });
        break;
      default:
        if (this.orb.state === 'listening' || this.orb.state === 'thinking') this.setOrb('idle');
        if (this.bubble?.sticky) this.hideBubble();
    }
  }

  // ------------------------------------------------------------ pipeline

  private cardList(): BuddyCard[] {
    const focus = getBuddyFocusApi()?.snapshot() ?? null;
    const out: BuddyCard[] = [];
    for (const e of this.queries.cards.entities) {
      if (!e.active || e.hasComponent(QuestCardTween)) continue;
      const id = e.getValue(QuestCard, 'cardId') as string;
      const pinned = (e.getValue(QuestCard, 'zoneId') as string).length > 0;
      out.push({
        id,
        title: e.getValue(QuestCard, 'title') as string,
        category: e.getValue(QuestCard, 'category') as string,
        state: focus?.cardId === id ? (focus.pausedRemainingMs !== null ? 'paused' : 'focusing') : pinned ? 'pinned' : 'floating',
      });
    }
    return out;
  }

  private focusInfo(): FocusInfo {
    const snap = getBuddyFocusApi()?.snapshot() ?? null;
    if (snap === null) return null;
    const remaining = snap.pausedRemainingMs ?? Math.max(0, snap.endsAt - focusNow());
    return { card_id: snap.cardId, paused: snap.pausedRemainingMs !== null, remaining_min: Math.ceil(remaining / 60_000) };
  }

  private markUsed(): void {
    if (this.used) return;
    this.used = true;
    try {
      localStorage.setItem(USED_KEY, 'used');
    } catch {
      // ignore
    }
  }

  /** One command, spoken or tapped. */
  async handle(text: string, source: 'voice' | 'tap'): Promise<RunRecord | null> {
    const spoken = text.trim();
    if (spoken.length === 0 || this.busy) return null;
    this.markUsed();
    setWelcomeCollapsed(true);
    const cards = this.cardList();
    const local = parseCommand(spoken, cards);
    if (local.kind === 'undo') {
      await this.undo();
      return null;
    }
    if (local.kind === 'accept') {
      await this.acceptOffer();
      return null;
    }

    this.busy = true;
    this.setOrb('thinking');
    this.say(`"${spoken.length > 70 ? `${spoken.slice(0, 67)}...` : spoken}"`, { tag: 'THINKING', sticky: true });
    const record: RunRecord = { text: spoken, source, mode: 'ai', actions: [], rejected: [], reply: '', log: [], at: Date.now() };
    const ids = new Set(cards.map((c) => c.id));
    let aiReply: string | null = null;
    let validated = { actions: [] as BuddyAction[], rejected: [] as Rejection[] };
    try {
      const reply = await askBuddyApi(spoken, cards, this.focusInfo());
      aiReply = cleanReply(reply.reply);
      validated = validateActions(reply.actions, ids);
      record.rejected = validated.rejected;
      // The AI only sent things we refuse: try the offline parser instead.
      if (validated.actions.length === 0 && validated.rejected.length > 0) record.mode = 'offline';
    } catch (error) {
      record.mode = 'offline';
      record.apiError = (error as { code?: string }).code ?? 'error';
    }
    if (record.mode === 'offline') {
      aiReply = null;
      if (local.kind === 'command') {
        const v = validateActions(local.actions, ids);
        validated = { actions: v.actions, rejected: [...record.rejected, ...v.rejected] };
        record.rejected = validated.rejected;
      } else {
        validated = { actions: [], rejected: record.rejected };
      }
    }
    record.actions = validated.actions;
    this.runs.push(record);
    if (this.runs.length > 30) this.runs.shift();

    if (validated.actions.length === 0) {
      const reply =
        aiReply ?? (local.kind === 'miss' ? local.reply : "Sorry, I can't do that yet. Try \"what's left today?\"");
      record.reply = reply;
      this.busy = false;
      this.setOrb(aiReply !== null ? 'done' : 'error', 1500);
      this.say(reply, { tag: this.tagFor(record.mode), ms: 4500 });
      return record;
    }

    let result: ExecResult;
    try {
      result = await this.executor.run(validated.actions);
    } catch (error) {
      console.warn('[buddy] action failed', error);
      this.busy = false;
      record.reply = 'Something went wrong there.';
      this.setOrb('error', 1800);
      this.say(record.reply, { ms: 4500 });
      return record;
    }
    record.log = result.log;
    const allOk = result.log.length > 0 && result.log.every((l) => l.ok) && result.confirm === undefined;
    record.reply = aiReply !== null && allOk && result.offer === undefined ? aiReply : result.reply;
    await this.present(result, record.reply, this.tagFor(record.mode));
    return record;
  }

  private tagFor(mode: RunRecord['mode']): string {
    return mode === 'offline' ? 'QUESTTY  (OFFLINE)' : 'QUESTTY';
  }

  /** Show what happened: light lines, pulses, the reply and its chips. */
  private async present(result: ExecResult, reply: string, tag: string): Promise<void> {
    const touched = [...new Set(result.touched)];
    this.busy = false;
    if (result.undo !== undefined) {
      this.undoStack.push(result.undo);
      if (this.undoStack.length > 5) this.undoStack.shift();
    }
    this.pendingOffer = result.offer;
    if (touched.length > 0) {
      this.setOrb('acting');
      this.drawLines(touched);
      const settle = (420 + Math.min(touched.length, 6) * 110 + 250) * BUDDY_SLOW;
      window.setTimeout(() => {
        if (!this.busy && this.orb.state === 'acting') this.setOrb('done', 1300);
      }, settle);
    } else {
      this.setOrb('done', 1300);
    }
    if (result.highlight.length > 0) {
      window.setTimeout(() => pulseCards(result.highlight, 3600 * BUDDY_SLOW), 450 * BUDDY_SLOW);
    }
    const chips: Chip[] = [];
    if (result.confirm !== undefined) {
      const confirm = result.confirm;
      chips.push({ label: confirm.label, kind: 'danger', run: () => void this.confirm(confirm.actions) });
      chips.push({ label: 'Keep it', kind: 'plain', run: () => this.say('Kept it.', { ms: 2500 }) });
    }
    if (result.offer !== undefined) {
      const offer = result.offer;
      chips.push({ label: offer.label, kind: 'primary', run: () => void this.acceptOffer() });
    }
    if (result.undo !== undefined && result.changed) {
      chips.push({ label: 'Undo', kind: 'plain', run: () => void this.undo() });
    }
    const ms = result.confirm !== undefined || result.offer !== undefined ? 12_000 : chips.length > 0 ? 6_500 : 4_000;
    this.say(reply, { tag, chips, ms });
  }

  private drawLines(cardIds: string[]): void {
    const from = this.orbPos.clone();
    cardIds.slice(0, 6).forEach((id, index) => {
      const card = findQuestCard(id)?.object3D;
      if (card == null) return;
      card.updateWorldMatrix(true, false);
      const to = card.getWorldPosition(new Vector3());
      // End just in front of the card face, at its left edge (toward the orb side).
      card.getWorldQuaternion(this.tmpQ);
      const s = card.scale.x;
      to.addScaledVector(new Vector3(0, 0, 1).applyQuaternion(this.tmpQ), 0.004);
      to.addScaledVector(new Vector3(-1, 0, 0).applyQuaternion(this.tmpQ), (CARD_UNITS_W / 2) * s * 0.55);
      to.addScaledVector(new Vector3(0, 1, 0).applyQuaternion(this.tmpQ), (CARD_UNITS_H / 2) * s * 0.2);
      this.lines.draw(id, from, to, LINE_COLOR, index * 110 * BUDDY_SLOW, () => pulseCards([id], 1100 * BUDDY_SLOW, ACK_COLOR));
    });
  }

  private async confirm(actions: BuddyAction[]): Promise<void> {
    if (this.busy) return;
    const ids = new Set(this.cardList().map((c) => c.id));
    const v = validateActions(actions, ids);
    if (v.actions.length === 0) {
      this.say('That card is already gone.', { ms: 3000 });
      return;
    }
    this.busy = true;
    // Lines first, so the user sees which card goes, then delete.
    this.setOrb('acting');
    this.drawLines(v.actions.flatMap((a) => ('card_id' in a ? [a.card_id] : [])));
    await new Promise((r) => window.setTimeout(r, 520 * BUDDY_SLOW));
    const result = await this.executor.run(v.actions, { confirmed: true });
    result.touched = [];
    await this.present(result, result.reply, 'QUESTTY');
  }

  private async acceptOffer(): Promise<void> {
    const offer = this.pendingOffer;
    this.pendingOffer = undefined;
    if (offer === undefined) {
      this.say('Nothing to start right now.', { ms: 3000 });
      return;
    }
    if (this.busy) return;
    const v = validateActions([offer.action], new Set(this.cardList().map((c) => c.id)));
    if (v.actions.length === 0) {
      this.say('That card is gone now.', { ms: 3000 });
      return;
    }
    this.busy = true;
    const result = await this.executor.run(v.actions);
    await this.present(result, result.reply, 'QUESTTY');
  }

  async undo(): Promise<void> {
    if (this.busy) return;
    const entry = this.undoStack.pop();
    if (entry === undefined) {
      this.say('Nothing to undo.', { ms: 3000 });
      return;
    }
    this.busy = true;
    this.pendingOffer = undefined;
    let touched: string[] = [];
    try {
      touched = await entry.run();
    } catch (error) {
      console.warn('[buddy] undo failed', error);
    }
    this.busy = false;
    if (touched.length > 0) {
      this.setOrb('acting');
      // Restored cards need a frame to get their pose.
      window.setTimeout(() => this.drawLines(touched), 120);
      window.setTimeout(() => {
        if (!this.busy && this.orb.state === 'acting') this.setOrb('done', 1200);
      }, 900 * BUDDY_SLOW);
    } else {
      this.setOrb('done', 1200);
    }
    this.say('Undone.', { ms: 3000 });
  }

  // ------------------------------------------------------------ cards

  private async spawnCard(title: string, category?: string): Promise<Entity> {
    const head = this.world.player.head;
    head.updateWorldMatrix(true, false);
    const position = head.getWorldPosition(new Vector3());
    const forward = head.getWorldDirection(new Vector3()).negate();
    const pose = nextFreeSlot(position, homeForward(forward), floatingCardPositions(this.queries.cards.entities));
    return createQuestCard({ title, xp: 20, position: pose.position, quaternion: pose.quaternion, category });
  }

  private setPlan(order: string[] | null): void {
    for (const id of [...this.badges.keys()]) this.removeBadge(id);
    this.plan = order === null || order.length === 0 ? null : [...order];
    this.plan?.forEach((id, index) => {
      const card = findQuestCard(id)?.object3D;
      if (card == null) return;
      const badge = new Mesh(
        new PlaneGeometry(0.52, 0.52),
        new MeshBasicMaterial({ map: badgeTexture(index + 1), transparent: true, depthWrite: false }),
      );
      badge.name = `Plan Badge ${index + 1}`;
      badge.renderOrder = 3;
      badge.raycast = () => undefined;
      // Sits on the face's top-left corner, like a numbered tab. The face is as
      // tall as its title, so read its real height (UIKit px -> card units).
      const root = (card as UIKitMLAsset).getElementById?.('quest-card-root');
      const size = (root as unknown as { size?: { peek?: () => [number, number] | undefined } } | null)?.size?.peek?.();
      const faceH = size !== undefined ? size[1] * 0.01 : CARD_UNITS_H;
      const faceW = size !== undefined ? size[0] * 0.01 : CARD_UNITS_W;
      badge.position.set(-faceW / 2 + 0.06, faceH / 2 - 0.06, 0.03);
      card.add(badge);
      this.badges.set(id, badge);
    });
  }

  private removeBadge(id: string): void {
    const badge = this.badges.get(id);
    if (badge === undefined) return;
    badge.removeFromParent();
    badge.geometry.dispose();
    (badge.material as MeshBasicMaterial).dispose();
    this.badges.delete(id);
  }

  // ------------------------------------------------------------ bubble

  private say(text: string, { tag = 'QUESTTY', chips = [] as Chip[], ms = 4000, sticky = false } = {}): void {
    if (this.bubble === undefined) {
      this.bubbleQueued = { text, tag, chips, ms, sticky };
      void this.ensureBubble();
      return;
    }
    const b = this.bubble;
    b.text = text;
    b.tag = tag;
    b.chips = chips.slice(0, 3);
    b.shownAt = performance.now();
    b.until = sticky ? Infinity : b.shownAt + ms * BUDDY_SLOW;
    b.sticky = sticky;
    b.panel.getElementById<UIKit.Text>('buddy-text')?.setProperties({ text });
    b.panel.getElementById<UIKit.Text>('buddy-tag-text')?.setProperties({ text: tag });
    const dot = tag.includes('OFFLINE') ? '#a9a191' : tag === 'LISTENING' ? '#ef9a84' : '#e0b85c';
    b.panel.getElementById<UIKit.Text>('buddy-tag-dot')?.setProperties({ backgroundColor: dot });
    b.panel.getElementById<UIKit.Text>('buddy-chips')?.setProperties({ display: b.chips.length > 0 ? 'flex' : 'none' });
    for (let i = 0; i < 3; i += 1) {
      const chip = b.chips[i];
      const el = b.panel.getElementById<UIKit.Text>(`buddy-chip-${i}`);
      if (chip === undefined) {
        el?.setProperties({ display: 'none' });
        continue;
      }
      const style = CHIP_STYLE[chip.kind];
      el?.setProperties({ display: 'flex', backgroundColor: style.bg, borderColor: style.border } as never);
      b.panel.getElementById<UIKit.Text>(`buddy-chip-${i}-label`)?.setProperties({ text: chip.label });
    }
  }

  private hideBubble(): void {
    if (this.bubble !== undefined) {
      this.bubble.until = Math.min(this.bubble.until, performance.now());
      this.bubble.sticky = false;
      this.bubble.chips = [];
    }
  }

  private async ensureBubble(): Promise<void> {
    if (this.bubble !== undefined || this.bubblePending) return;
    this.bubblePending = true;
    try {
      const panel = await this.world.assets.instantiate<UIKitMLAsset>('buddy-bubble');
      panel.name = 'Buddy Bubble';
      const entity = this.world.createTransformEntity(panel);
      entity.object3D!.name = 'Buddy Bubble';
      entity.addComponent(RayInteractable);
      entity.addComponent(PokeInteractable);
      const root = panel.requireElementById('buddy-bubble');
      // Anchored at its top-left corner: hangs under the orb, grows down and right.
      root.setProperties({ anchorX: 'left', anchorY: 'top', renderOrder: 6 } as never);
      // While a pinch-ray rests on the bubble it doesn't fade (time to reach a chip).
      root.addEventListener('pointerover', () => {
        if (this.bubble !== undefined) this.bubble.hovered = true;
      });
      root.addEventListener('pointerout', () => {
        if (this.bubble !== undefined) this.bubble.hovered = false;
      });
      for (let i = 0; i < 3; i += 1) {
        panel.requireElementById(`buddy-chip-${i}`).addEventListener('click', () => this.onChip(i));
      }
      panel.visible = false;
      this.bubble = { entity, panel, text: '', tag: '', chips: [], shownAt: 0, until: 0, opacity: 0, lastOpacity: -1, sticky: false, hovered: false };
      const queued = this.bubbleQueued;
      this.bubbleQueued = undefined;
      if (queued !== undefined) this.say(queued.text, queued);
    } catch (error) {
      console.warn('[buddy] Could not create the bubble.', error);
    } finally {
      this.bubblePending = false;
    }
  }

  private onChip(index: number): void {
    const b = this.bubble;
    if (b === undefined || !b.panel.visible || b.opacity < 0.3) return;
    const chip = b.chips[index];
    if (chip === undefined) return;
    b.chips = [];
    chip.run();
  }

  /** Under the pill, facing the eyes; fades in and out. Suggestions on a first run. */
  private updateBubble(now: number): void {
    const collapsed = isWelcomeCollapsed();
    if (
      collapsed &&
      !this.used &&
      !this.busy &&
      this.micState !== 'listening' &&
      (this.bubble === undefined || now > this.bubble.until + FADE_OUT_MS) &&
      this.cardList().length > 0
    ) {
      this.say('Try asking me. Pinch the orb and talk.', {
        tag: 'QUESTTY',
        chips: SUGGESTIONS.map((label) => ({ label, kind: 'plain' as ChipKind, run: () => void this.handle(label, 'tap') })),
        sticky: true,
      });
    }
    const b = this.bubble;
    if (b === undefined) return;
    // Pointed at with chips to press: hold it a little longer.
    if (b.hovered && b.chips.length > 0 && b.opacity > 0.5 && b.until - now < 1500 * BUDDY_SLOW) b.until = now + 1500 * BUDDY_SLOW;
    const want = collapsed && now < b.until ? 1 : 0;
    const step = want > b.opacity ? 1000 / FADE_IN_MS : 1000 / FADE_OUT_MS;
    const dt = Math.min(0.1, (now - (this.lastBubbleAt || now)) / 1000);
    this.lastBubbleAt = now;
    b.opacity = want > b.opacity ? Math.min(1, b.opacity + step * dt) : Math.max(0, b.opacity - step * dt);
    const visible = b.opacity > 0.01;
    if (b.panel.visible !== visible) b.panel.visible = visible;
    if (!visible) return;
    if (Math.abs(b.lastOpacity - b.opacity) > 0.02 || (b.opacity === 1 && b.lastOpacity !== 1)) {
      b.lastOpacity = b.opacity;
      b.panel.getElementById('buddy-bubble')?.setProperties({ opacity: b.opacity } as never);
    }
    this.placeBubble(b, 1 - b.opacity);
  }

  private lastBubbleAt = 0;

  private placeBubble(b: Bubble, slide: number): void {
    const home = this.world.getSceneObject<UIKitMLAsset>('welcome-panel');
    if (home == null) return;
    const pill = home.getElementById('panel-pill');
    if (pill == null) return;
    home.updateWorldMatrix(true, false);
    pill.updateWorldMatrix(true, false);
    const e = pill.matrixWorld.elements;
    home.getWorldQuaternion(this.tmpQ);
    const px = PX_AT_PANEL * (home.scale.x / 0.1);
    const size = (pill as unknown as { size?: { peek?: () => [number, number] | undefined } }).size?.peek?.();
    const pillW = (size?.[0] ?? 352) * px;
    const pillH = (size?.[1] ?? 116) * px;
    const up = new Vector3(0, 1, 0).applyQuaternion(this.tmpQ);
    const right = new Vector3(1, 0, 0).applyQuaternion(this.tmpQ);
    const normal = new Vector3(0, 0, 1).applyQuaternion(this.tmpQ);
    // Top-left corner just under the pill's left edge (under the orb), so the
    // bubble grows away from the card arc on the right.
    const position = new Vector3(e[12], e[13], e[14])
      .addScaledVector(right, -pillW / 2 + 0.004)
      .addScaledVector(up, -(pillH / 2 + BUBBLE_GAP) + slide * 0.012)
      .addScaledVector(normal, 0.004);
    b.panel.position.copy(position);
    b.panel.quaternion.copy(this.tmpQ);
    b.panel.scale.setScalar(BUBBLE_SCALE * (home.scale.x / 0.1));
  }

  // ------------------------------------------------------------ dev view

  private debugState() {
    const b = this.bubble;
    const box = (() => {
      if (b === undefined || !b.panel.visible) return null;
      b.panel.updateWorldMatrix(true, false);
      const el = b.panel.getElementById('buddy-bubble');
      const size = (el as unknown as { size?: { peek?: () => [number, number] | undefined } })?.size?.peek?.();
      const pos = b.panel.getWorldPosition(new Vector3());
      const q = b.panel.getWorldQuaternion(new Quaternion());
      const px = 0.001 * (b.panel.scale.x / 0.1);
      const w = (size?.[0] ?? 300) * px;
      const h = (size?.[1] ?? 150) * px;
      const r = new Vector3(1, 0, 0).applyQuaternion(q);
      const u = new Vector3(0, 1, 0).applyQuaternion(q);
      // Top-left anchored: the corners and edge midpoints in world space.
      const corners: number[][] = [];
      for (const fx of [0, 0.5, 1]) {
        for (const fy of [0, 0.5, 1]) {
          corners.push(pos.clone().addScaledVector(r, w * fx).addScaledVector(u, -h * fy).toArray());
        }
      }
      return { position: pos.toArray(), sizePx: size ?? null, scale: b.panel.scale.x, corners };
    })();
    this.world.player.head.getWorldPosition(this.head);
    return {
      orb: {
        state: this.orb.state,
        position: this.orbPos.toArray(),
        radius: this.orbRadius,
        visible: this.orb.group.visible,
        log: [...this.orbLog],
      },
      bubble: b
        ? {
            visible: b.panel.visible,
            opacity: +b.opacity.toFixed(3),
            text: b.text,
            tag: b.tag,
            chips: b.chips.map((c) => ({ label: c.label, kind: c.kind })),
            box,
          }
        : null,
      plan: this.plan,
      badges: [...this.badges.keys()],
      lines: this.lines.recent(),
      runs: this.runs.map((r) => ({ ...r })),
      undoDepth: this.undoStack.length,
      offer: this.pendingOffer ? { label: this.pendingOffer.label, action: this.pendingOffer.action } : null,
      busy: this.busy,
      used: this.used,
      head: this.head.toArray(),
    };
  }
}
