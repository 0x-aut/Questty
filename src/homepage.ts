/**
 * Flat-browser homepage (index.html #qh). It is plain HTML/CSS laid over the
 * scene canvas: visible before XR (desktop, phone, Quest Browser) and again when
 * a session ends, hidden while immersive. Its Enter XR buttons call the same
 * world.launchXR() the in-scene panel button uses, so IWSDK's own session flow
 * (and its offerSession "always" policy) is untouched.
 */
import { VisibilityState, type World } from '@iwsdk/core';

type Mode = 'loading' | 'ready' | 'starting' | 'unsupported';

export interface Homepage {
  /** Wire the buttons to the world once it exists. */
  bind(world: World): void;
  /** The world failed to start: show the friendly message instead of a dead button. */
  fail(): void;
}

const EMULATOR_URL =
  'https://chromewebstore.google.com/detail/immersive-web-emulator/cgffilbpcibhmcfbgggfhfolhkfbhmik';

export function mountHomepage(): Homepage {
  const root = document.getElementById('qh');
  const noop: Homepage = { bind: () => undefined, fail: () => undefined };
  if (root == null) return noop;
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-qh-enter]')];
  const labels = [...root.querySelectorAll<HTMLElement>('[data-qh-label]')];
  const noSupport = [...root.querySelectorAll<HTMLElement>('[data-qh-nosupport]')];
  const status = root.querySelector<HTMLElement>('[data-qh-status]');
  const back = document.querySelector<HTMLButtonElement>('[data-qh-back]');
  let world: World | undefined;
  let startTimer = 0;
  let supported: boolean | undefined;

  const setStatus = (text: string) => {
    if (status) status.textContent = text;
  };

  const setMode = (mode: Mode) => {
    for (const b of buttons) b.disabled = mode !== 'ready';
    const text = mode === 'loading' ? 'Loading…' : mode === 'starting' ? 'Starting…' : 'Enter XR';
    for (const l of labels) l.textContent = text;
    const unsupported = mode === 'unsupported';
    for (const b of buttons) b.hidden = unsupported;
    for (const n of noSupport) n.hidden = !unsupported;
    if (unsupported) setStatus('');
  };

  const fillNoSupport = (canPreview: boolean) => {
    for (const n of noSupport) {
      n.className = 'qh-nosupport';
      n.innerHTML =
        `<strong>This browser can't open a mixed reality session.</strong> ` +
        `Open <strong>questty.vercel.app</strong> in Quest Browser on Meta Quest 3 or 3S, ` +
        `or use desktop Chrome with Meta's <a href="${EMULATOR_URL}" target="_blank" rel="noopener">Immersive Web Emulator</a> and reload.` +
        (canPreview ? ` <br /><a href="#" data-qh-preview>Or peek at the 3D scene on this screen →</a>` : '');
      n.querySelector('[data-qh-preview]')?.addEventListener('click', (e) => {
        e.preventDefault();
        showHome(false);
        if (back) back.hidden = false;
      });
    }
  };

  const showHome = (show: boolean) => {
    root.hidden = !show;
    if (show && back) back.hidden = true;
  };
  back?.addEventListener('click', () => showHome(true));

  const enter = () => {
    if (world == null) return;
    setMode('starting');
    setStatus('Opening the immersive session… allow the microphone when asked.');
    try {
      world.launchXR();
    } catch (error) {
      console.error('[home] launchXR failed', error);
    }
    // launchXR reports a refused request only to the console; if we are still
    // flat after a while, give the button back.
    window.clearTimeout(startTimer);
    startTimer = window.setTimeout(() => {
      if (world?.visibilityState.peek() === VisibilityState.NonImmersive) {
        setMode('ready');
        setStatus("The session didn't start. Check the headset prompt, then try Enter XR again.");
      }
    }, 10_000);
  };
  for (const b of buttons) b.addEventListener('click', enter);

  const unsupported = (canPreview: boolean) => {
    supported = false;
    fillNoSupport(canPreview);
    setMode('unsupported');
  };

  setMode('loading');

  return {
    fail() {
      unsupported(false);
    },
    bind(w: World) {
      world = w;
      w.visibilityState.subscribe((v) => {
        const flat = v === VisibilityState.NonImmersive;
        showHome(flat);
        if (flat) {
          window.clearTimeout(startTimer);
          if (supported === true) {
            setMode('ready');
            setStatus('');
          }
        }
      });
      if (!w.xrEnabled || navigator.xr == null) {
        unsupported(true);
        return;
      }
      const mode = (w.xrDefaults?.sessionMode ?? 'immersive-ar') as XRSessionMode;
      navigator.xr
        .isSessionSupported(mode)
        .then((ok) => {
          if (ok) {
            supported = true;
            if (w.visibilityState.peek() === VisibilityState.NonImmersive) setMode('ready');
          } else {
            unsupported(true);
          }
        })
        .catch(() => unsupported(true));
    },
  };
}
