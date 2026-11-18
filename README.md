# IWSDK App

This project uses `iwsdk.config.json` for declarative scene, asset, component,
XR, and emulator configuration. Application systems remain explicit in
`src/index.ts`.

```sh
npm install
npm run dev
```

Use the Runtime and Editor controls in the managed browser to switch between
the running experience and its authored scene.

## Starter content

The robot and welcome panel are small examples of authored scene content plus
runtime systems. The robot turns toward the player's head and plays a sound
when pressed. To remove the robot, delete its scene node, its `RobotSystem`
registration from `src/index.ts` or `src/index.js`, and its `Robot` registration
from `src/components.ts` or `src/components.js`; you can then delete the unused
robot component and system files. To remove the welcome panel, delete its scene
node and its `PanelSystem` registration from the application entry point.

The robot stands on the second of three numbered stations. The first holds dark
pieces you can grab and move, and the third holds a ring you can spin in place.
The studio props (the plinths and the dark pieces, plus the floor and stage in VR
and Desktop 3D) are built in code in `src/scene-assets/studio.scene-asset.ts` or
`.js`. The VR and Desktop 3D background furniture is built the same way in
`src/scene-assets/decor.scene-asset.ts` or `.js`, so the starter downloads no
extra models. To remove any of them, delete their scene nodes and their entries
in `src/assets.ts` or `src/assets.js`, then delete the files you no longer use.
The station labels are `public/ui/label-*.uikitml`.

The rest of the look is built-in components in the scene, which you can edit in
the editor without code. The soft light on every object is the scene root's
`IBLGradient` (select the Level Root to edit it), and the soft shadows under
each object are `ContactShadow` nodes. In VR and Desktop 3D, the sky is the
scene root's `DomeGradient` (its colors, tilt and dither are also on the Level
Root), and the floor fades into it through the `DomeFade` on the floor node. AR
projects have no sky or floor, so passthrough stays visible, and a
`ShadowCatcher` node grounds the stations.

- Minimal scene walkthrough: https://iwsdk.dev/guides/01b-minimal-scene.html
- XR-enabled projects — IWER emulator controls: https://iwsdk.dev/guides/02-testing-experience.html#iwer-controls



Questty is a mixed reality focus space for Meta Quest. Pinch and speak everything on your mind, and AI turns it into quest cards with XP. Pin them to zones in your real room, then start a focus session: your room softens behind frosted glass, a visual timer counts down, and a quiet AI buddy works alongside you. Breaks are enforced, finishing a quest earns XP, and your room grows as you level up. No typing, no controllers.

### OpenAI setup

Copy `.env.example` to `.env` and set `OPENAI_API_KEY`, or add it to the
deployment platform's server-side environment variables (for example, Vercel
Project Settings). Never use a `VITE_` prefix or commit `.env`: the key is read
only by the server functions in `api/`. `npm run dev` serves those functions
from the Vite dev server (reading `.env`), so voice works locally too.

| Endpoint | Model | Used for |
| --- | --- | --- |
| `POST /api/transcribe` | `gpt-transcribe` (falls back to `gpt-4o-mini-transcribe`) | Speech to text for the mic and push-to-talk |
| `POST /api/quests` | `gpt-6-luna` (Responses API, strict JSON schema) | Turns the transcript into 3-5 quest cards, and the in-focus **Need a nudge** |
| `POST /api/buddy` | `gpt-6-luna` (Responses API, strict JSON schema) | The buddy's commands: validated actions only (move, arrange, find, focus...) |
| `POST /api/live` | `gpt-live-1` (WebRTC, client delegation) | Talk mode: exchanges the browser's SDP offer for an answer on the server |
| `GET /api/*` | none | Tells the app whether that route is configured (else it falls back) |

Optional server variables (all have defaults): `OPENAI_TEXT_MODEL`,
`OPENAI_BUDDY_MODEL`, `OPENAI_QUESTS_MODEL`, `OPENAI_REASONING_EFFORT`
(`none|low|medium|high`, default `low`), `OPENAI_TRANSCRIBE_MODEL`,
`OPENAI_LIVE_MODEL`, `OPENAI_LIVE_VOICE` (default `marin`).

**Web tools (optional):** `FIRECRAWL_API_KEY` lets the buddy search the web
and read a page before it answers ("Get chapter 3 of Pride and Prejudice and
display it so I can read it"). Firecrawl only: search is `POST /v2/search`,
reading a page is `POST /v2/scrape` (markdown, main content only). At most 3
tool calls and ~25 s per request. For books the buddy goes straight to a
per-chapter page: Standard Ebooks first, then Wikisource, Project Gutenberg
last; a scrape that is really a maintenance/error/captcha page counts as a
failure so it tries the next source. Public-domain chapters open as full text
in the reading view, split into pages ("next page"); copyrighted books only get
a short summary. Without the key the buddy behaves exactly as before.

**Vercel:** Project Settings -> Environment Variables -> add `OPENAI_API_KEY`
(Production and Preview), then redeploy. The functions in `api/` run on
Vercel's Node runtime; `api/_openai.ts` is a shared helper (the underscore keeps
it from becoming a route) imported as `./_openai.js`, which resolves to the
`.ts` file in Vite dev and to the compiled file on Vercel.

**Cost guards:** a talk session ends after 60 s without speech or after 5
minutes (gpt-live-1 is billed per minute of session). Without a key every
feature still works offline: the local phrase parser runs buddy commands and
the mic falls back to push-to-talk.

### Voice capture

Pinch the big mic ("What's on your mind?"), say everything on your mind, then
pause (it stops by itself after a short silence) or pinch the mic again.
Recording also stops at 30 seconds. The mic shows each step: it turns coral and
pulses with your voice while listening, then "Got it, writing it down...",
"Turning it into quests..." and how many cards were added.

- **Primary path, every browser (Quest Browser included):** the mic is recorded
  with `MediaRecorder` and sent to `/api/transcribe`. Quest Browser has no Web
  Speech API, so this is what makes voice work on the headset.
- **No key on the server:** the app falls back to the browser's Web Speech API
  where one exists (desktop Chrome or Edge). Where none exists (Quest Browser),
  it says voice is not set up and points to the quick quests.
- **No AI for quests:** if `/api/quests` fails, the transcript is split into
  cards locally (`src/splitQuests.ts`). The quick quest buttons never need AI.

The mic needs a secure context: `https://` (the dev server uses a local
certificate) or `localhost`. On a headset, allow the microphone when Quest
Browser asks; doing it once before entering XR avoids a prompt mid-session.

Built for the Meta VR Start Developer Competition 2026 (Productivity track) with the Immersive Web SDK.

### Moving around

In the desktop XR emulator, click the app viewport to focus it, then use
**W/A/S/D** or the **arrow keys** to walk. In a Quest headset, use the **left
thumbstick** to move and the **right thumbstick** to snap-turn; physical walking
also works within your tracked play space. A hand-only session has no thumbstick:
use a focused keyboard in the emulator, or physically walk in your room.

### First run: an empty room and a small home panel

The room starts empty: no cards appear until you speak, pick **Focus session**
or a **Quick quest**. The home panel is small and sits low to your left, out of
your line of sight. It has the mic, **Focus session** (one card, pinned to the
nearest desk in front of you, with the length picker open) and **Quick quest**
(four ready-made cards that need no AI). After a brain dump it shrinks to a
small pill; pinch the pill to open it again, or the minus button to shrink it
yourself. Leave XR with the headset's own menu. (Dev builds show a room-plane
debug toggle with `?debug=1`.)

The first time cards appear, a short tip floats above them ("Pinch a card and
drag it onto a wall, desk or door"), a ghost pointer shows the motion and the
surfaces you can use glow softly. After your first pin it says "Pinned to the
desk - it stays right here, even after you leave. Pinch Start focus to begin"
and goes away for good (remembered in `localStorage`).

### Cards stay in your room

Cards are saved in `localStorage` (title, XP, the surface they are pinned to and
their pose) and come back after a reload or the next XR session, where you left
them. Each pinned card also gets a **WebXR anchor** with a **persistent handle**
(Quest Browser: `anchor.requestPersistentHandle()`, restored with
`session.restorePersistentAnchor(uuid)`), so it returns to the same real-world
spot even if the headset's origin moved. If the anchor cannot be restored, the
card is put back relative to the room plane it was pinned to (same kind and
label), and failing that at its saved floor-relative pose. Completing a card
removes it and deletes its anchor. A running focus timer resumes on the same
card (stable card ids).

### Placing cards (hands first, seated)

New cards appear in a tidy arc within arm's reach, a little below eye height.
Everything works with hand tracking alone:

- **Near card:** reach out and pinch it to grab it directly.
- **Far card or far surface:** point your hand at the card, pinch, then swing the
  pinch-ray to any wall, desk/table top or door and let go. Cards placed this way
  fly to the spot you point at.
- While you hold a card, every surface you can drop it on shows a faint outline.
  The one it will snap to turns yellow, and a ghost card with "Release to pin to
  Wall/Desk/Door" shows exactly where it will land.
- Cards sit flush on walls and doors, a few millimetres off the surface. On a
  desk they lean back toward you so they are easy to read. Cards on the same
  surface never overlap.
- Let go in mid-air, or while pointing at the floor, and the card floats right
  where you released it. A quick pinch-tap never moves a card.
- A pinned card gets a **Start focus** button. Pinch it with the ray or poke it.

## Focus timer (hands)

- Pinch **Start focus** on a pinned card, then pinch a length: **5m / 15m / 25m /
  45m**. 25 min is the default; a card whose title carries a length ("Deep work
  25m") suggests that length instead.
- A round timer with big mm:ss and a progress ring appears a little below eye
  line, just above the card in view (or beside it if the card is at eye level).
- The focus panel next to the card then has **Complete**, **Pause/Resume**,
  **+5 min**, **End early**, **Blur: Off/Soft/Strong** and **Need a nudge**.
- When the time runs out (or you pinch Complete) a soft chime plays (WebAudio, no
  audio file), the quest is marked done and its XP is awarded. End early stops
  the timer with no XP.
- The timer runs on the wall clock (`Date.now()`), so a backgrounded tab or a
  slow frame never loses time. A running or paused timer is saved in
  `localStorage` and resumes on its card after a reload.

### Softened surroundings during focus

WebXR gives web pages **no access to the passthrough camera image**, so a real
blur of your room is impossible in the browser. Instead Questty puts a frosted,
dimmed shell (about 1.25 m around you) over the room, with clear windows around
the active card and the timer. It fades in over about 1 s, drops to a lighter
frost while paused and fades out when focus ends. Your hands, the timer and the
active card stay sharp; other floating cards are softened too. Pick the strength
with **Blur** on the focus panel; the choice is remembered. The shell is one
transparent draw with no render targets, which keeps it inside the Quest frame
budget (a true blur of the virtual scene would need an extra stereo pass every
frame).

Dev only: `?focusTimeScale=60` speeds the focus clock up (not in production
builds).

Surfaces come from WebXR plane detection: on a Quest in passthrough, your real
room's `wall`, `table` and `door` planes. Without plane detection, a small
virtual room is used instead. Scene nodes can also be tagged with the
`SnapSurface` component.

## Streak flame

A small brass lantern stands on your desk (the detected `table`/`desk` plane
nearest you, in front of you; with no desk it stands in front of you at desk
height). Its candle flame **is your daily streak**.

- **A day counts** when you complete at least one quest or one focus session
  that day, by your local calendar date (midnight where you are, DST-safe).
- **Miss a day** and the flame drops to a low ember for one grace day: finish
  something that day and the streak carries on. Miss the grace day too and it
  resets. A fresh user sees a small pilot flame ("Light it").
- **It grows** a little with the streak (about 0.9x on day 1 to 1.25x from day
  30, clamped so it stays desk-sized) and **changes colour by tier**:

  | Streak     | Tier    | Flame                 |
  |------------|---------|-----------------------|
  | 0          | Pilot   | small, dim orange     |
  | 1-2 days   | Ember   | warm orange           |
  | 3-6 days   | Gold    | yellow-gold           |
  | 7-13 days  | Blue    | blue-white            |
  | 14-29 days | Violet  | violet                |
  | 30+ days   | Emerald | emerald green         |

- The number is engraved on a brass tag on the dish, and a label ("7-day streak -
  Blue") appears when you look at the lantern or hold it.
- **Every completion flares it** (a quick rise, brighter light, a burst of
  embers) with the usual chime. The first completion of a day that continues a
  streak earns a small bonus: +5 XP per streak day beyond the first, max +25.
- **It really lights your desk**: a flickering point light at the flame casts
  shadows (256 px cube map) from the lantern's posts and nearby cards onto a
  shadow-catcher laid over the detected desk, so the shadow shows over
  passthrough, plus a soft warm light pool. The shadow fades with distance like
  a candle's would and stays within ~40 cm of the flame.
- **Pinch it** (ray or direct) to carry it anywhere; let go over a desk and it
  stands flush on it. Where you put it is remembered.
- **Mount it on a wall** the way you pin cards: let go within a hand-span of a
  wall or door, or with the pinch-ray pointing at one (the same snap preview
  shows, "Release to mount on Wall"). It stands upright on a small wooden
  ledge 5.5 cm out from the wall, nudged clear of cards already there, its
  number on a plaque on the ledge. The light then hangs in front of the flame
  so its shadow falls on the wall behind it (the catcher and pool move onto a
  90 cm square of that wall), and cards pinned to that wall keep clear of it.
  It comes back on the same wall after a reload; pinch it back onto the desk
  any time.
- Ask the buddy **"what's my streak?"** (works offline too).

Cost on Quest: the lantern, flame, glow, embers, catcher and pool are a handful
of draws; the point light's shadow is re-rendered only while something moves
(otherwise at ~15 Hz). Saved in `localStorage` under `questty.progress.v1`
(with the streak's `lastDay`) and `questty.flame.v1` (where you put it).

Dev only: `window.__questty.flame` (`state()`, `setStreak(n, 'lit'|'waiting'|'ember'|'out')`,
`flare()`, `lightOn(on, pool)`, `renderStats()`, ...).
