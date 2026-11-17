/**
 * PR 10: the document focus view. The buddy opens a document ("open my
 * essay", "read the project brief") in a focused reading panel:
 *
 *  - big, sharp text drawn once into a tall canvas texture (mipmapped,
 *    anisotropic) and scrolled by moving the texture window: scrolling never
 *    redraws or re-uploads anything;
 *  - pinch the page (pinch-ray or a direct pinch/poke) and drag up or down to
 *    scroll, with a little glide when you let go (none with reduced motion);
 *  - the room dims behind frosted glass around it (the focus shell, with a
 *    clear window over the page);
 *  - pinch the header to carry it, let go near a wall, desk or door to pin it
 *    there (the same snap preview cards use); Close beside the header;
 *  - the reading position (per document), the open document and where it
 *    stands are saved, so a reload comes back to the same line.
 *
 * Cost: page (1 draw), scrollbar (1), header + close (UIKit), and the frost
 * shell (1, only while open). Nothing allocates per frame.
 */
import {
  CanvasTexture,
  createSystem,
  DistanceGrabbable,
  DoubleSide,
  Grabbed,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MovementMode,
  OneHandGrabbable,
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
import { createFocusShell, type FocusShell } from './focus-shell.js';
import {
  cardNote,
  draftOutline,
  generatedDocs,
  loadDocView,
  parseMarkdown,
  readMinutes,
  SAMPLE_DOCS,
  saveDocView,
  saveGeneratedDoc,
  wrapText,
  type DocSource,
  type DocViewSaved,
} from './documents.js';
import { findQuestCard } from './quest-card.js';
import { QuestCard } from './quest-component.js';
import { setExternalPreview, surfaceHitFor, type NearBand, type SnapTarget, type SurfaceFrame } from './surfaces.js';
import { getSettings, onSettings, SEATED_REACH_M } from './settings.js';
import { getBuddyFocusApi } from './session-events.js';
import type { DocOutcome, DocRequest } from './buddy/executor.js';

export const VIEW_W = 0.5;
export const VIEW_H = 0.36;
const CANVAS_W = 1280;
const PX_PER_M = CANVAS_W / VIEW_W;
const VIEW_PX = Math.round(VIEW_H * PX_PER_M);
const MAX_CANVAS_H = 8192;
const HEADER_H = 0.054;
const HEADER_GAP = 0.012;
const UI_SCALE = 0.1;
const OPEN_DISTANCE = 0.52;
const OPEN_DROP = 0.03;
const FROST = 0.55;
const FADE_MS = 450;
const FRICTION_S = 0.32;
const SURFACE_GAP = 0.004;
const DESK_LEAN = (16 * Math.PI) / 180;
const BAND: NearBand = { wall: [0.06, 0.25], door: [0.06, 0.25], desk: [0.06, 0.32] };
const NEAR_ENTER = 0.12;
const NEAR_EXIT = 0.2;

type OpenDoc = { id: string; title: string; source: DocSource; body: string; cardId?: string };
type Drag = { kind: 'ray' | 'tip' | 'pinch'; hand: 'left' | 'right'; startV: number; startScroll: number; lastV: number; lastAt: number; velocity: number; pointerId: number };

let active: DocViewSystem | undefined;

/** Open a document (the buddy's open_document action). */
export function openDocumentView(request: DocRequest): Promise<DocOutcome> {
  return active?.open(request) ?? Promise.resolve({ ok: false, reply: "Documents aren't ready yet." });
}
export function closeDocumentView(): boolean {
  return active?.close() ?? false;
}

export class DocViewSystem extends createSystem({}) {
  private doc: OpenDoc | null = null;
  private saved: DocViewSaved = loadDocView();
  private canvas!: HTMLCanvasElement;
  private texture!: CanvasTexture;
  private page!: Mesh;
  private pageMat!: MeshBasicMaterial;
  private thumb!: Mesh;
  private pageEntity: Entity | undefined;
  private header: UIKitMLAsset | undefined;
  private headerEntity: Entity | undefined;
  private closeEntity: Entity | undefined;
  private closePanel: UIKitMLAsset | undefined;
  private shell: FocusShell | undefined;
  private shellOpacity = 0;
  private shellTarget = 0;
  private shellFrom = 0;
  private shellAt = 0;
  private contentPx = VIEW_PX;
  private canvasPx = VIEW_PX;
  private scroll = 0;
  private shownScroll = -1;
  private velocity = 0;
  private drag: Drag | null = null;
  private lastFrame = performance.now();
  private dirtySaveAt = 0;
  private held = false;
  private nearMode = false;
  private heldTarget: { surface: SurfaceFrame; point: Vector3 } | null = null;
  private preview: SnapTarget | null = null;
  private mount: { surfaceId: string; kind: string } | null = null;
  private frame = 0;
  private uiLoading: Promise<void> | null = null;
  private restorePending = false;
  private readonly center = new Vector3();
  private readonly quat = new Quaternion();
  private readonly head = new Vector3();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpC = new Vector3();
  private readonly tmpQ = new Quaternion();
  private readonly tmpM = new Matrix4();
  private readonly log: Array<{ at: number; event: string; detail?: string }> = [];

  init(): void {
    active = this;
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = VIEW_PX;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.anisotropy = Math.min(8, this.world.renderer.capabilities.getMaxAnisotropy());
    this.pageMat = new MeshBasicMaterial({ map: this.texture, side: DoubleSide, toneMapped: false });
    this.pageMat.name = 'Document Page';
    this.page = new Mesh(new PlaneGeometry(VIEW_W, VIEW_H), this.pageMat);
    this.page.name = 'Document Page';
    this.page.visible = false;
    // A hidden page must not catch pinch-rays (three.js raycasts invisible meshes).
    const page = this.page;
    page.raycast = (raycaster, hits) => {
      if (page.visible) Mesh.prototype.raycast.call(page, raycaster, hits);
    };
    this.page.renderOrder = 960;
    const thumbMat = new MeshBasicMaterial({ color: 0x8a7a5c, transparent: true, opacity: 0.85, depthWrite: false });
    this.thumb = new Mesh(new PlaneGeometry(0.006, 1), thumbMat);
    this.thumb.name = 'Document Scrollbar';
    this.thumb.raycast = () => undefined;
    this.thumb.renderOrder = 961;
    this.page.add(this.thumb);
    this.pageEntity = this.world.createTransformEntity(this.page, { parent: this.world.sceneEntity, persistent: true });
    this.pageEntity.addComponent(RayInteractable);
    this.pageEntity.addComponent(PokeInteractable);
    this.page.addEventListener('pointerdown', (event: unknown) => this.onPagePointerDown(event as PagePointerEvent));
    this.page.addEventListener('pointerup', (event: unknown) => this.onPagePointerUp(event as PagePointerEvent));
    this.page.addEventListener('pointercancel', (event: unknown) => this.onPagePointerUp(event as PagePointerEvent));

    this.shell = createFocusShell();
    this.shell.mesh.name = 'Document Frost Shell';
    this.shell.mesh.renderOrder = 899;
    this.world.createTransformEntity(this.shell.mesh, { parent: this.world.sceneEntity, persistent: true });

    this.cleanupFuncs.push(
      onSettings((_s, changed) => {
        if (this.doc !== null && (changed === 'largeText' || changed === 'highContrast')) {
          const frac = this.contentPx > VIEW_PX ? this.scroll / (this.contentPx - VIEW_PX) : 0;
          this.render();
          this.scroll = Math.max(0, frac * Math.max(0, this.contentPx - VIEW_PX));
          this.shownScroll = -1;
        }
      }),
    );
    // A document left open comes back after a reload, where it was, at the same line.
    if (this.saved.open !== null) this.restorePending = true;
    const xr = this.world.renderer.xr;
    const onStart = () => {
      if (this.restorePending) window.setTimeout(() => void this.restoreOpen(), 1200);
    };
    xr.addEventListener('sessionstart', onStart);
    this.cleanupFuncs.push(() => {
      xr.removeEventListener('sessionstart', onStart);
      if (active === this) active = undefined;
      this.texture.dispose();
      this.pageMat.dispose();
      this.page.geometry.dispose();
      thumbMat.dispose();
      this.thumb.geometry.dispose();
      this.shell?.dispose();
    });
    if (import.meta.env.DEV) this.installDevHooks();
  }

  // ------------------------------------------------------------ open / close

  async open(request: DocRequest): Promise<DocOutcome> {
    const previous = this.doc === null ? null : { ...this.doc };
    const prevPose = this.doc === null ? null : { p: this.center.clone(), q: this.quat.clone() };
    let next: OpenDoc | null = null;
    let written = false;
    if ('body' in request) {
      const g = saveGeneratedDoc(request.title, request.body);
      next = { id: g.id, title: g.title, source: 'buddy', body: g.body };
      written = true;
    } else if ('doc_id' in request) {
      const sample = SAMPLE_DOCS.find((d) => d.id === request.doc_id);
      if (sample !== undefined) {
        const body = await this.fetchSample(sample.file);
        if (body === null) return { ok: false, reply: `I couldn't load "${sample.title}".` };
        next = { id: sample.id, title: sample.title, source: 'sample', body };
      } else {
        const g = generatedDocs().find((d) => d.id === request.doc_id);
        if (g === undefined) return { ok: false, reply: "I couldn't find that document." };
        next = { id: g.id, title: g.title, source: 'buddy', body: g.body };
      }
    } else {
      const card = findQuestCard(request.card_id);
      if (card === undefined) return { ok: false, reply: 'That card is gone.' };
      const title = card.getValue(QuestCard, 'title') as string;
      const note = cardNote(request.card_id);
      if (note === null) return { ok: false, reply: `"${title.slice(0, 28)}" has no notes yet.` };
      next = { id: `notes-${request.card_id}`, title: `Notes: ${title}`.slice(0, 60), source: 'card', body: note, cardId: request.card_id };
    }
    await this.show(next, null);
    this.pushLog('open', next.id);
    const opened = next;
    return {
      ok: true,
      title: opened.title,
      minutes: readMinutes(opened.body),
      written,
      undo: () => {
        if (previous !== null && prevPose !== null) void this.show(previous, { p: prevPose.p.toArray() as [number, number, number], q: prevPose.q.toArray() as [number, number, number, number] });
        else this.close();
      },
    };
  }

  private async fetchSample(file: string): Promise<string | null> {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}docs/${file}`);
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  private async restoreOpen(): Promise<void> {
    this.restorePending = false;
    const o = this.saved.open;
    if (o === null || this.doc !== null) return;
    let body: string | null = null;
    if (o.source === 'sample') {
      const s = SAMPLE_DOCS.find((d) => d.id === o.id);
      body = s ? await this.fetchSample(s.file) : null;
    } else if (o.source === 'buddy') body = generatedDocs().find((d) => d.id === o.id)?.body ?? null;
    else if (o.cardId !== undefined) body = cardNote(o.cardId);
    if (body === null) {
      this.saved.open = null;
      saveDocView(this.saved);
      return;
    }
    await this.show({ ...o, body }, this.saved.pose);
    this.pushLog('restored', o.id);
  }

  private async show(doc: OpenDoc, pose: DocViewSaved['pose']): Promise<void> {
    if (this.doc !== null) this.persistScroll();
    await this.ensureUi();
    this.doc = doc;
    this.render();
    this.scroll = Math.min(this.saved.scroll[doc.id] ?? 0, Math.max(0, this.contentPx - VIEW_PX));
    this.shownScroll = -1;
    this.velocity = 0;
    this.drag = null;
    if (pose !== null) {
      this.center.fromArray(pose.p);
      this.quat.fromArray(pose.q);
      this.mount = pose.surfaceId !== undefined ? { surfaceId: pose.surfaceId, kind: pose.kind ?? 'wall' } : null;
    } else if (!this.page.visible) this.placeInFront();
    this.header?.getElementById<UIKit.Text>('doc-title')?.setProperties({ text: doc.title });
    this.page.visible = true;
    if (this.header) this.header.visible = true;
    if (this.closePanel) this.closePanel.visible = true;
    this.layout();
    this.applyScroll();
    this.fadeShell(FROST);
    this.saved.open = { id: doc.id, title: doc.title, source: doc.source, ...(doc.cardId ? { cardId: doc.cardId } : {}) };
    this.savePose();
  }

  close(): boolean {
    if (this.doc === null) return false;
    this.persistScroll();
    this.pushLog('close', this.doc.id);
    this.doc = null;
    this.drag = null;
    this.velocity = 0;
    this.page.visible = false;
    if (this.header) this.header.visible = false;
    if (this.closePanel) this.closePanel.visible = false;
    // Out of every pointer's way while hidden (UI panels and the header's grab handle).
    this.header?.position.set(0, -50, 0);
    this.closePanel?.position.set(0, -50, 0);
    if (this.preview !== null) setExternalPreview(null);
    this.preview = null;
    this.fadeShell(0);
    this.saved.open = null;
    saveDocView(this.saved);
    return true;
  }

  private ensureUi(): Promise<void> {
    this.uiLoading ??= (async () => {
      const header = await this.world.assets.instantiate<UIKitMLAsset>('doc-header');
      header.name = 'Document Header';
      header.scale.setScalar(UI_SCALE);
      this.header = header;
      this.headerEntity = this.world.createTransformEntity(header, { parent: this.world.sceneEntity, persistent: true });
      this.headerEntity.object3D!.name = 'Document Header';
      this.setGrab('ray');
      const close = await this.world.assets.instantiate<UIKitMLAsset>('doc-close');
      close.name = 'Document Close';
      close.scale.setScalar(UI_SCALE);
      this.closePanel = close;
      this.closeEntity = this.world.createTransformEntity(close, { parent: this.world.sceneEntity, persistent: true });
      this.closeEntity.object3D!.name = 'Document Close';
      this.closeEntity.addComponent(RayInteractable);
      this.closeEntity.addComponent(PokeInteractable);
      close.requireElementById('doc-close').addEventListener('click', () => this.close());
      header.visible = false;
      close.visible = false;
      header.position.set(0, -50, 0);
      close.position.set(0, -50, 0);
    })();
    return this.uiLoading;
  }

  // ------------------------------------------------------------ drawing

  private render(): void {
    const doc = this.doc;
    if (doc === null) return;
    const s = getSettings();
    const big = s.largeText;
    const hc = s.highContrast;
    const base = big ? 46 : 36;
    const styles = {
      h1: { size: Math.round(base * 1.6), weight: 800, gapBefore: 0, color: hc ? '#000000' : '#16130f' },
      h2: { size: Math.round(base * 1.18), weight: 700, gapBefore: base * 0.9, color: hc ? '#000000' : '#2a241b' },
      p: { size: base, weight: 400, gapBefore: base * 0.35, color: hc ? '#000000' : '#26231f' },
      li: { size: base, weight: 400, gapBefore: base * 0.2, color: hc ? '#000000' : '#26231f' },
      oli: { size: base, weight: 400, gapBefore: base * 0.2, color: hc ? '#000000' : '#26231f' },
      gap: { size: base, weight: 400, gapBefore: 0, color: '#000' },
    } as const;
    const margin = 84;
    const indent = Math.round(base * 1.3);
    const ctx = this.canvas.getContext('2d');
    if (ctx === null) return;
    const font = (size: number, weight: number) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    // 1. Lay out (measure) every line.
    type Line = { text: string; x: number; y: number; size: number; weight: number; color: string; marker?: string; mx?: number };
    const lines: Line[] = [];
    let y = margin * 0.85;
    for (const block of parseMarkdown(doc.body)) {
      if (block.kind === 'gap') {
        y += base * 0.45;
        continue;
      }
      const st = styles[block.kind];
      y += st.gapBefore;
      ctx.font = font(st.size, st.weight);
      const listy = block.kind === 'li' || block.kind === 'oli';
      const x = margin + (listy ? indent : 0);
      const wrapped = wrapText(block.text, CANVAS_W - margin - x, (t) => ctx.measureText(t).width);
      wrapped.forEach((text, i) => {
        y += st.size * 1.42;
        lines.push({ text, x, y, size: st.size, weight: st.weight, color: st.color, ...(listy && i === 0 ? { marker: block.marker, mx: margin + 4 } : {}) });
      });
      if (block.kind === 'h1') y += base * 0.5;
    }
    this.contentPx = Math.ceil(y + margin * 0.9);
    this.canvasPx = Math.min(MAX_CANVAS_H, Math.max(VIEW_PX, this.contentPx));
    this.contentPx = Math.min(this.contentPx, this.canvasPx);
    // 2. Draw once into a canvas exactly as tall as the content.
    this.canvas.height = this.canvasPx;
    ctx.fillStyle = hc ? '#ffffff' : '#f7f3ea';
    ctx.fillRect(0, 0, CANVAS_W, this.canvasPx);
    if (!hc) {
      // Soft paper edge.
      ctx.fillStyle = '#ece5d6';
      ctx.fillRect(0, 0, 10, this.canvasPx);
      ctx.fillRect(CANVAS_W - 10, 0, 10, this.canvasPx);
    }
    ctx.textBaseline = 'alphabetic';
    for (const l of lines) {
      if (l.y > this.canvasPx - 4) break;
      ctx.font = font(l.size, l.weight);
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, l.x, l.y);
      if (l.marker !== undefined && l.mx !== undefined) {
        ctx.fillStyle = hc ? '#000000' : '#9a6b2f';
        ctx.fillText(l.marker, l.mx, l.y);
      }
    }
    this.texture.dispose(); // the canvas size may have changed: re-create the GPU texture
    this.texture.needsUpdate = true;
    this.texture.repeat.set(1, VIEW_PX / this.canvasPx);
    this.thumb.visible = this.contentPx > VIEW_PX + 2;
    this.thumb.scale.y = VIEW_H * Math.min(1, VIEW_PX / this.contentPx);
    (this.thumb.material as MeshBasicMaterial).color.set(hc ? 0x000000 : 0x8a7a5c);
    this.shownScroll = -1;
  }

  private maxScroll(): number {
    return Math.max(0, this.contentPx - VIEW_PX);
  }

  private applyScroll(): void {
    if (Math.abs(this.shownScroll - this.scroll) < 0.25) return;
    this.shownScroll = this.scroll;
    // Texture rows from the top: UV v runs bottom-up (flipY), so the window's bottom is at 1 - (scroll + view) / H.
    this.texture.offset.set(0, 1 - (this.scroll + VIEW_PX) / this.canvasPx);
    const range = this.maxScroll();
    const thumbH = this.thumb.scale.y;
    const t = range > 0 ? this.scroll / range : 0;
    this.thumb.position.set(VIEW_W / 2 - 0.014, VIEW_H / 2 - thumbH / 2 - t * (VIEW_H - thumbH), 0.001);
  }

  // ------------------------------------------------------------ placement

  private headPose(): void {
    const h = this.world.player.head;
    h.updateWorldMatrix(true, false);
    h.getWorldPosition(this.head);
  }

  /** In front of the eyes, a little low, facing them; within arm's reach in seated mode. */
  private placeInFront(): void {
    this.headPose();
    const fwd = this.world.player.head.getWorldDirection(this.tmpA).negate();
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    const dist = getSettings().seated ? Math.min(OPEN_DISTANCE, SEATED_REACH_M - 0.06) : OPEN_DISTANCE;
    this.center.copy(this.head).addScaledVector(fwd, dist);
    this.center.y -= OPEN_DROP;
    this.faceHead(this.center, this.quat);
    this.mount = null;
  }

  private faceHead(at: Vector3, out: Quaternion): void {
    this.headPose();
    this.tmpM.lookAt(this.head, at, this.tmpB.set(0, 1, 0));
    out.setFromRotationMatrix(this.tmpM);
  }

  /** Header, page and Close from the document's pose (centre of the page). */
  private layout(): void {
    this.page.position.copy(this.center);
    this.page.quaternion.copy(this.quat);
    const up = this.tmpA.set(0, 1, 0).applyQuaternion(this.quat);
    const right = this.tmpB.set(1, 0, 0).applyQuaternion(this.quat);
    if (this.header !== undefined && !this.held) {
      this.header.position.copy(this.center).addScaledVector(up, VIEW_H / 2 + HEADER_GAP + HEADER_H / 2);
      this.header.quaternion.copy(this.quat);
    }
    if (this.closePanel !== undefined && this.header !== undefined) {
      this.closePanel.position.copy(this.header.position).addScaledVector(right, VIEW_W / 2 + 0.072);
      this.closePanel.quaternion.copy(this.quat);
    }
    this.updateShellWindow();
  }

  private savePose(): void {
    this.saved.pose = {
      p: this.center.toArray() as [number, number, number],
      q: this.quat.toArray() as [number, number, number, number],
      ...(this.mount !== null ? { surfaceId: this.mount.surfaceId, kind: this.mount.kind } : {}),
    };
    saveDocView(this.saved);
  }

  private persistScroll(): void {
    if (this.doc === null) return;
    this.saved.scroll[this.doc.id] = Math.round(this.scroll);
    saveDocView(this.saved);
  }

  // ------------------------------------------------------------ grab (header)

  private setGrab(mode: 'near' | 'ray'): void {
    const e = this.headerEntity;
    if (e === undefined || e.hasComponent(Grabbed)) return;
    const want = mode === 'near' ? OneHandGrabbable : DistanceGrabbable;
    if (e.hasComponent(want)) return;
    if (e.hasComponent(OneHandGrabbable)) e.removeComponent(OneHandGrabbable);
    if (e.hasComponent(DistanceGrabbable)) e.removeComponent(DistanceGrabbable);
    for (const component of e.getComponents()) {
      if ((component as { id?: string }).id === 'Handle') e.removeComponent(component);
    }
    if (mode === 'near') e.addComponent(OneHandGrabbable, { rotate: false, translate: true });
    else e.addComponent(DistanceGrabbable, { movementMode: MovementMode.MoveFromTarget, rotate: false, scale: false, translate: true });
  }

  private updateGrabMode(): void {
    if (this.header === undefined) return;
    const p = this.world.player;
    const spaces = [p.indexTipSpaces.left, p.indexTipSpaces.right, p.gripSpaces.left, p.gripSpaces.right];
    let nearest = Infinity;
    for (const s of spaces) nearest = Math.min(nearest, s.getWorldPosition(this.tmpC).distanceTo(this.header.position));
    const near = this.nearMode ? nearest < NEAR_EXIT + VIEW_W / 2 : nearest < NEAR_ENTER + 0.05;
    if (near !== this.nearMode) {
      this.nearMode = near;
      this.setGrab(near ? 'near' : 'ray');
    }
  }

  private whileHeld(): void {
    const header = this.header;
    if (header === undefined) return;
    // Upright and turned to the eyes while carried; the page hangs under the header.
    this.faceHead(header.position, this.tmpQ);
    header.quaternion.copy(this.tmpQ);
    this.quat.copy(this.tmpQ);
    const up = this.tmpA.set(0, 1, 0).applyQuaternion(this.quat);
    this.center.copy(header.position).addScaledVector(up, -(VIEW_H / 2 + HEADER_GAP + HEADER_H / 2));
    this.mount = null;
    this.layout();
    if (this.frame % 2 === 0) {
      const hit = this.headerEntity === undefined ? null : surfaceHitFor(this.headerEntity, this.center, BAND);
      this.heldTarget = hit === null ? null : { surface: hit.surface, point: hit.point };
      this.updatePreview();
    }
  }

  private pinPose(target: { surface: SurfaceFrame; point: Vector3 }, outP: Vector3, outQ: Quaternion): void {
    const s = target.surface;
    if (s.kind === 'desk') {
      // Stands on the desk, leaning back a little, turned to the eyes.
      this.headPose();
      const f = this.tmpA.copy(this.head).sub(target.point);
      f.y = 0;
      if (f.lengthSq() < 1e-4) f.set(0, 0, 1);
      f.normalize();
      const worldUp = this.tmpB.set(0, 1, 0);
      const n = f.clone().multiplyScalar(Math.cos(DESK_LEAN)).addScaledVector(worldUp, Math.sin(DESK_LEAN)).normalize();
      const u = worldUp.clone().multiplyScalar(Math.cos(DESK_LEAN)).addScaledVector(f, -Math.sin(DESK_LEAN)).normalize();
      const x = new Vector3().crossVectors(u, n).normalize();
      outQ.setFromRotationMatrix(this.tmpM.makeBasis(x, u, n));
      outP.copy(target.point).addScaledVector(u, VIEW_H / 2 + 0.012).addScaledVector(n, 0.01);
      return;
    }
    // Flat on the wall or door, upright, a few millimetres off it.
    const n = s.normal.clone();
    const u = new Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize();
    const x = new Vector3().crossVectors(u, n).normalize();
    outQ.setFromRotationMatrix(this.tmpM.makeBasis(x, u, n));
    outP.copy(target.point).addScaledVector(n, SURFACE_GAP);
  }

  private updatePreview(): void {
    if (this.heldTarget === null) {
      if (this.preview !== null) setExternalPreview(null);
      this.preview = null;
      return;
    }
    const p = new Vector3();
    const q = new Quaternion();
    this.pinPose(this.heldTarget, p, q);
    const k = this.heldTarget.surface.kind;
    this.preview = {
      surfaceId: this.heldTarget.surface.id,
      kind: k,
      label: k === 'door' ? 'Door' : k === 'desk' ? 'Desk' : 'Wall',
      position: p,
      quaternion: q,
      // The ghost is card-shaped (2.6 card units wide): match the page's width.
      scale: VIEW_W / 2.6,
      via: 'near',
      verb: 'pin to',
    };
    setExternalPreview(this.preview);
  }

  private onRelease(): void {
    const target = this.heldTarget;
    this.heldTarget = null;
    if (this.preview !== null) setExternalPreview(null);
    this.preview = null;
    if (target !== null) {
      this.pinPose(target, this.center, this.quat);
      this.mount = { surfaceId: target.surface.id, kind: target.surface.kind };
      this.pushLog('pinned', target.surface.kind);
    } else {
      this.mount = null;
      this.pushLog('floated');
    }
    this.layout();
    this.savePose();
  }

  // ------------------------------------------------------------ scrolling

  private onPagePointerDown(event: PagePointerEvent): void {
    if (this.doc === null) return;
    const hit = event.point;
    if (hit === undefined) return;
    // Which hand is it: the pinch-ray whose ray meets the page at this point, else the nearest fingertip.
    let best: { kind: 'ray' | 'tip'; hand: 'left' | 'right'; d: number } | null = null;
    for (const hand of ['left', 'right'] as const) {
      const v = this.rayOnPage(hand);
      if (v !== null) {
        const d = this.pageLocal(hit, this.tmpC).distanceTo(new Vector3(v.x, v.y, 0));
        if (best === null || d < best.d) best = { kind: 'ray', hand, d };
      }
      const tip = this.world.player.indexTipSpaces[hand].getWorldPosition(this.tmpA);
      const d = tip.distanceTo(hit);
      if (d < 0.04 && (best === null || d < best.d)) best = { kind: 'tip', hand, d };
    }
    if (best === null) return;
    const v = this.sourceV(best.kind, best.hand) ?? this.pageLocal(hit, this.tmpC).y;
    this.drag = { kind: best.kind, hand: best.hand, startV: v, startScroll: this.scroll, lastV: v, lastAt: performance.now(), velocity: 0, pointerId: event.pointerId ?? -1 };
    this.velocity = 0;
    const target = event.target as { setPointerCapture?: (id: number) => void } | undefined;
    try {
      if (event.pointerId !== undefined) target?.setPointerCapture?.(event.pointerId);
    } catch {
      // capture is a nicety
    }
    this.pushLog('drag-start', best.kind);
  }

  private onPagePointerUp(event: PagePointerEvent): void {
    if (this.drag === null) return;
    if (event.pointerId !== undefined && this.drag.pointerId !== -1 && event.pointerId !== this.drag.pointerId) return;
    this.endDrag();
  }

  private endDrag(): void {
    if (this.drag === null) return;
    this.velocity = getSettings().reducedMotion ? 0 : this.drag.velocity;
    this.drag = null;
    this.dirtySaveAt = performance.now() + 600;
    this.pushLog('drag-end', this.scroll.toFixed(0));
  }

  /** Page-local point (x right, y up, metres) of a world point. */
  private pageLocal(world: Vector3, out: Vector3): Vector3 {
    out.copy(world).sub(this.center).applyQuaternion(this.tmpQ.copy(this.quat).invert());
    return out;
  }

  /** Where a hand's pinch-ray meets the page plane (page-local), or null. */
  private rayOnPage(hand: 'left' | 'right'): { x: number; y: number } | null {
    const ray = this.world.player.raySpaces[hand];
    ray.updateWorldMatrix(true, false);
    const o = ray.getWorldPosition(this.tmpA);
    const d = this.tmpB.set(0, 0, -1).applyQuaternion(ray.getWorldQuaternion(this.tmpQ)).normalize();
    const n = this.tmpC.set(0, 0, 1).applyQuaternion(this.quat);
    const denom = d.dot(n);
    if (Math.abs(denom) < 1e-4) return null;
    const t = this.tmpA.clone().sub(this.center).dot(n) / -denom;
    if (t < 0 || t > 10) return null;
    const p = o.clone().addScaledVector(d, t);
    const local = this.pageLocal(p, p);
    return { x: local.x, y: local.y };
  }

  /** Is that hand still pinching (hand gamepad button 0, as Quest Browser reports it; or the controller trigger)? */
  private pinching(hand: 'left' | 'right'): boolean {
    const session = this.world.renderer.xr.getSession?.();
    if (session == null) return true;
    for (const source of session.inputSources) {
      if (source.handedness !== hand) continue;
      const b = source.gamepad?.buttons[0];
      if (b === undefined) return true;
      return b.pressed || b.value > 0.5;
    }
    return false;
  }

  private sourceV(kind: 'ray' | 'tip' | 'pinch', hand: 'left' | 'right'): number | null {
    if (kind === 'ray') return this.rayOnPage(hand)?.y ?? null;
    // 'tip' and 'pinch' follow the index fingertip (a pinch's fingertips meet there).
    const tip = this.world.player.indexTipSpaces[hand].getWorldPosition(this.tmpA);
    return this.pageLocal(tip, this.tmpB).y;
  }

  private readonly wasPinching: Record<'left' | 'right', boolean> = { left: false, right: false };

  /**
   * A pinch made right at the page (fingertips within a few cm of it) grabs
   * the page itself: drag the pinched hand up or down to scroll. The pinch-ray
   * does not fire that close, and a fingertip touch works too (pointer events).
   */
  private detectNearPinch(): void {
    for (const hand of ['left', 'right'] as const) {
      const pinching = this.pinching(hand) && this.handPresent(hand);
      const started = pinching && !this.wasPinching[hand];
      this.wasPinching[hand] = pinching;
      if (!started || this.drag !== null || this.held) continue;
      const tip = this.world.player.indexTipSpaces[hand].getWorldPosition(this.tmpA);
      const local = this.pageLocal(tip, this.tmpB);
      if (Math.abs(local.x) > VIEW_W / 2 + 0.02 || Math.abs(local.y) > VIEW_H / 2 + 0.02 || local.z > 0.07 || local.z < -0.03) continue;
      this.drag = { kind: 'pinch', hand, startV: local.y, startScroll: this.scroll, lastV: local.y, lastAt: performance.now(), velocity: 0, pointerId: -1 };
      this.velocity = 0;
      this.pushLog('drag-start', 'pinch');
    }
  }

  private handPresent(hand: 'left' | 'right'): boolean {
    const session = this.world.renderer.xr.getSession?.();
    if (session == null) return false;
    for (const source of session.inputSources) if (source.handedness === hand) return true;
    return false;
  }

  private updateScroll(dt: number): void {
    const now = performance.now();
    const max = this.maxScroll();
    this.detectNearPinch();
    if (this.drag !== null) {
      const v = this.sourceV(this.drag.kind, this.drag.hand);
      if (v !== null) {
        // The page follows the finger: drag up to read on.
        const next = this.drag.startScroll + (v - this.drag.startV) * PX_PER_M;
        const dtS = Math.max(1e-3, (now - this.drag.lastAt) / 1000);
        const instV = ((v - this.drag.lastV) * PX_PER_M) / dtS;
        this.drag.velocity = this.drag.velocity * 0.6 + instV * 0.4;
        this.drag.lastV = v;
        this.drag.lastAt = now;
        // A little rubber band past the ends.
        this.scroll = next < 0 ? next * 0.3 : next > max ? max + (next - max) * 0.3 : next;
      }
      // The ray may leave the page mid-drag (no pointerup then): the drag ends when the pinch opens.
      if (this.drag !== null) {
        if ((this.drag.kind === 'ray' || this.drag.kind === 'pinch') && !this.pinching(this.drag.hand)) this.endDrag();
        else if (this.drag.kind === 'tip') {
          // A finger on the page: it scrolls while the fingertip stays on (or just in front of) the page.
          const tip = this.world.player.indexTipSpaces[this.drag.hand].getWorldPosition(this.tmpA);
          const z = this.pageLocal(tip, this.tmpB).z;
          if (z > 0.035 || z < -0.06) this.endDrag();
        }
      }
    } else {
      if (Math.abs(this.velocity) > 5) {
        this.scroll += this.velocity * dt;
        this.velocity *= Math.exp(-dt / FRICTION_S);
      } else this.velocity = 0;
      // Settle back inside the ends.
      if (this.scroll < 0) this.scroll += (0 - this.scroll) * Math.min(1, dt * 12);
      if (this.scroll > max) this.scroll += (max - this.scroll) * Math.min(1, dt * 12);
      if (Math.abs(this.scroll) < 0.5 && this.scroll < 0) this.scroll = 0;
      if (this.scroll > max && this.scroll - max < 0.5) this.scroll = max;
      if (this.dirtySaveAt > 0 && now > this.dirtySaveAt && Math.abs(this.velocity) < 5) {
        this.dirtySaveAt = 0;
        this.persistScroll();
      }
    }
    this.applyScroll();
  }

  // ------------------------------------------------------------ frost

  private fadeShell(target: number): void {
    this.shellFrom = this.shellOpacity;
    this.shellTarget = target;
    this.shellAt = performance.now();
  }

  private updateShell(): void {
    const shell = this.shell;
    if (shell === undefined) return;
    // While a focus timer runs, its own frost already softens the room.
    const focusOn = getBuddyFocusApi()?.snapshot() != null;
    const target = focusOn ? 0 : this.shellTarget;
    if (this.shellTarget !== target && this.shellFrom !== this.shellOpacity) this.fadeShell(this.shellTarget);
    const t = Math.min(1, (performance.now() - this.shellAt) / FADE_MS);
    const k = t * t * (3 - 2 * t);
    const value = this.shellFrom + (target - this.shellFrom) * k;
    if (Math.abs(value - this.shellOpacity) > 1e-3 || (t >= 1 && this.shellOpacity !== target)) {
      this.shellOpacity = t >= 1 ? target : value;
      shell.setOpacity(this.shellOpacity);
    }
  }

  private updateShellWindow(): void {
    const shell = this.shell;
    if (shell === undefined) return;
    this.headPose();
    shell.mesh.position.copy(this.head);
    const dir = this.tmpC.copy(this.center).sub(this.head);
    const dist = Math.max(0.2, dir.length());
    dir.normalize();
    const half = Math.atan(Math.hypot(VIEW_W, VIEW_H + HEADER_H * 2) / 2 / dist) + 0.04;
    shell.setWindow(0, dir, half);
    shell.setWindow(1, null, 0);
  }

  // ------------------------------------------------------------ frame

  update(): void {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.frame += 1;
    if (this.doc === null) {
      if (this.shellOpacity > 0) this.updateShell();
      return;
    }
    const held = this.headerEntity?.hasComponent(Grabbed) === true;
    if (held) {
      if (!this.held) {
        this.held = true;
        this.drag = null;
        this.pushLog('grabbed');
      }
      this.whileHeld();
    } else if (this.held) {
      this.held = false;
      this.onRelease();
    }
    if (!held && this.frame % 3 === 0) this.updateGrabMode();
    this.updateScroll(dt);
    if (this.frame % 2 === 0) this.updateShellWindow();
    this.updateShell();
  }

  private pushLog(event: string, detail?: string): void {
    this.log.push({ at: Date.now(), event, ...(detail !== undefined ? { detail } : {}) });
    if (this.log.length > 60) this.log.shift();
  }

  private installDevHooks(): void {
    const w = window as unknown as { __questty?: Record<string, unknown> };
    w.__questty = {
      ...w.__questty,
      doc: {
        state: () => ({
          open: this.doc === null ? null : { id: this.doc.id, title: this.doc.title, source: this.doc.source },
          scroll: Math.round(this.scroll),
          maxScroll: this.maxScroll(),
          contentPx: this.contentPx,
          canvasPx: this.canvasPx,
          viewPx: VIEW_PX,
          dragging: this.drag?.kind ?? null,
          dragHand: this.drag?.hand ?? null,
          dragV: this.drag === null ? null : [this.drag.startV, this.drag.lastV],
          velocity: Math.round(this.velocity),
          held: this.held,
          grabMode: this.nearMode ? 'near' : 'ray',
          mount: this.mount,
          center: this.center.toArray(),
          normal: new Vector3(0, 0, 1).applyQuaternion(this.quat).toArray(),
          shellOpacity: this.shellOpacity,
          pageVisible: this.page.visible,
          header: this.header?.position.toArray() ?? null,
          close: this.closePanel?.position.toArray() ?? null,
          saved: loadDocView(),
          log: [...this.log],
          anisotropy: this.texture.anisotropy,
        }),
        open: (request: DocRequest) => this.open(request),
        close: () => this.close(),
        draft: (topic: string) => draftOutline(topic),
        setScroll: (px: number) => {
          this.scroll = Math.max(0, Math.min(this.maxScroll(), px));
          this.persistScroll();
        },
        pagePoint: (u: number, v: number) => {
          // World point on the page at (u, v) in -0.5..0.5 of its width/height.
          const p = new Vector3(u * VIEW_W, v * VIEW_H, 0).applyQuaternion(this.quat).add(this.center);
          return p.toArray();
        },
      },
    };
  }
}

type PagePointerEvent = { point?: Vector3; pointerId?: number; target?: unknown };
