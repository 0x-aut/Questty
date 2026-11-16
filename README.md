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
| `POST /api/transcribe` | `gpt-4o-mini-transcribe` | Speech to text for the mic button |
| `GET /api/transcribe` | none | Tells the app whether server transcription is configured |
| `POST /api/quests` | `gpt-4o-mini` | Turns the transcript into 3-5 quest cards, and the in-focus **Need a nudge** |

### Voice capture

Tap **Speak a quest**, say your tasks, then pause (it stops by itself after a
short silence) or tap **Done talking**. Recording also stops at 30 seconds.
The button and the status pill show each step: Starting mic, Listening,
Transcribing, Making quests, then how many cards were added.

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
