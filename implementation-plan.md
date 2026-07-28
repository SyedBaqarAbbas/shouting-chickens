# Shouting Chickens implementation plan

## Product summary

Shouting Chickens is a portrait-first browser platformer where a calibrated
microphone acts as an analogue controller:

- The chicken automatically runs at a fixed horizontal speed.
- A short increase in voice level triggers one jump.
- Sustained sound while airborne adds bounded lift.
- Silence lets gravity bring the chicken down.

The first release is a deterministic, local-only MVP. The complete browser
product adds procedural content, progression, original audiovisual polish,
local persistence, PWA installation, and opt-in local replay sharing.

The reference screenshots establish the composition and gameplay feel only.
Their people, TikTok branding, watermark, and artwork are not product assets.

## Locked product decisions

| Decision            | Selected direction                                              |
| ------------------- | --------------------------------------------------------------- |
| Control model       | Rising voice pulse triggers a jump; sustained sound adds lift   |
| Horizontal movement | Fixed-speed auto-run; voice affects only vertical movement      |
| Primary platform    | Mobile portrait, with a centered desktop presentation           |
| Camera              | Optional mirrored front-camera background                       |
| Fallback input      | Keyboard and touch use the same gameplay intent interface       |
| MVP score           | Elapsed survival time                                           |
| Full product        | Installable local-first PWA with local scores and replay export |
| Backend             | None                                                            |
| Media privacy       | Raw audio and video remain on-device                            |
| Artwork             | Original assets only                                            |

Explicitly out of scope for the initial product:

- Accounts, cloud saves, and online leaderboards
- Multiplayer
- Uploaded or hosted replays
- Speech recognition or transcription
- Remote analytics
- User-generated levels
- Guaranteed support for embedded social-media webviews

## Success criteria

### MVP

A first-time player can:

1. Open the game over HTTPS on a supported phone.
2. Grant microphone access after a clear user gesture.
3. Complete quiet, comfortable, and safely loud calibration.
4. Play a handcrafted looping course with pulse-to-jump and sustained lift.
5. See microphone feedback, survival time, game-over state, and restart.
6. Enable or decline the optional camera without affecting gameplay.
7. Use keyboard or touch controls when voice input is unavailable or unwanted.

MVP release gates:

- The jump fires once per voice onset and never continuously while held.
- Landing after a sustained sound does not create a false jump.
- Camera denial does not block microphone play.
- Permission denial, missing devices, invalid calibration, resize, orientation,
  backgrounding, and restart all have recoverable states.
- The game completes the automated quality gates and real-device smoke tests.

### Full browser product

The complete local-first product additionally provides:

- Seeded procedural runs built from verified authored chunks
- Difficulty progression, lift stamina, obstacles, and collectibles
- Versioned settings, calibration profiles, and local best scores
- Original chicken animation, platforms, water, hazards, audio, and effects
- Installable/offline PWA behavior
- Explicitly opt-in, local replay export with graceful browser fallbacks
- Release-grade privacy, accessibility, performance, and compatibility checks

## Architecture

### Technology baseline

- Vite
- React
- TypeScript with strict mode
- Phaser 4.2.1 with Arcade Physics
- Web Audio API with an `AudioWorklet` processor and `AnalyserNode` fallback
- Media Capture and Streams API
- Vitest and React Testing Library
- Playwright
- npm with a committed lockfile

Pin the Node and npm versions used by CI and local development. Pin Phaser and
all direct dependencies in `package-lock.json`; automated dependency updates
must pass the complete quality gate before merge.

### Module ownership

```text
src/
├── app/       React lifecycle, permissions, calibration, menus, results
├── core/      Pure rules, state machines, scoring, clocks, seeded randomness
├── game/      Phaser scenes, physics, rendering, pools, in-run visual HUD
├── input/     Media capture, signal processing, calibration, input adapters
├── platform/  Camera, persistence, PWA, recording, sharing, diagnostics
└── content/   Chunk templates, hazards, collectibles, difficulty configuration
```

Ownership rules:

- React owns application navigation and non-game UI.
- Phaser owns the fixed-step simulation, collisions, game rendering, and the
  visual HUD that must appear in replay captures.
- `core` imports no React, Phaser, or browser APIs.
- Browser APIs sit behind adapters so tests can replace media, storage, clocks,
  and randomness.
- React does not receive audio or game state every frame. Phaser reads the
  latest control intent directly and emits throttled snapshots or lifecycle
  events.

### Runtime composition

```text
React application shell
├── Permission and calibration UI
├── Settings, pause, and results UI
├── Accessible status layer
├── Optional mirrored <video> background
└── Transparent Phaser canvas
    ├── Fixed-step game simulation
    ├── World and pooled objects
    └── Timer, microphone meter, and hazard warnings
```

The logical playfield is `432 × 768`. Phaser uses fit scaling inside a
`100dvh` container, respects safe-area insets, caps device pixel ratio at `2`,
centers the portrait frame on desktop, and pauses behind a rotate prompt in
landscape.

### Core interfaces

```ts
export type SignalQuality = "good" | "weak" | "clipped";

export type VoiceFrame = {
  atMs: number;
  rawDb: number;
  normalizedLevel: number;
  onset: boolean;
  signalQuality: SignalQuality;
};

export type ControlIntent = {
  atMs: number;
  jumpPressed: boolean;
  lift: number; // 0..1
};

export interface InputSource {
  start(): Promise<void>;
  latest(): ControlIntent;
  stop(): void;
}

export type CalibrationProfile = {
  schemaVersion: 1;
  noiseFloorDb: number;
  normalDb: number;
  loudDb: number;
  jumpEnterLevel: number;
  jumpExitLevel: number;
  liftStartLevel: number;
};

export type RunOptions = {
  seed: string;
  calibration: CalibrationProfile | null;
  gameplayVersion: string;
};

export type GameEvent =
  | { type: "snapshot"; value: GameSnapshot }
  | { type: "ended"; value: RunSummary }
  | { type: "fatal-error"; error: RuntimeError };

export interface GameRuntime {
  mount(container: HTMLElement): Promise<void>;
  startRun(options: RunOptions): void;
  pause(): void;
  resume(): void;
  restart(): void;
  destroy(): void;
  subscribe(listener: (event: GameEvent) => void): () => void;
}

export type ChunkTemplate = {
  id: string;
  width: number;
  minimumDifficulty: number;
  maximumDifficulty: number;
  entry: TraversalAnchor;
  exit: TraversalAnchor;
  platforms: PlatformSpec[];
  hazards: HazardSpec[];
  collectibles: CollectibleSpec[];
};
```

Keyboard, touch, synthetic test traces, and microphone input all produce the
same `ControlIntent`. Gameplay code must not branch on which input source is
active.

### Application lifecycle

```text
boot
  → unsupported | permission
  → calibration
  → ready
  → countdown
  → playing
  → paused/backgrounded | game over
  → resume prompt | restart | quit
```

Lifecycle requirements:

- Request microphone access only after a clear user gesture.
- Request camera access separately and only when the player enables it.
- Treat browser media constraints as preferences; inspect actual track settings.
- Pause simulation and expensive rendering when the document is hidden.
- Resume a suspended `AudioContext` only after another user gesture.
- Pause and offer retry/fallback when an active input device disappears.
- Stop every `MediaStreamTrack`, disconnect audio nodes, close the audio
  context, remove listeners, destroy Phaser, and revoke object URLs on exit.

### Voice signal pipeline

```text
Microphone stream
  → RMS samples
  → dBFS conversion
  → calibration normalization
  → fast attack / slow release smoothing
  → hysteresis and onset detection
  → ControlIntent
  → fixed-step simulation
```

Implementation rules:

- Never connect microphone input to speakers.
- Prefer mono input with echo cancellation and noise suppression enabled and
  automatic gain control disabled, while tolerating browsers that ignore these
  constraints.
- Compute RMS in an AudioWorklet and post only scalar frames to the main thread.
  Use an AnalyserNode adapter when AudioWorklet is unavailable.
- Use percentile samples rather than maxima for calibration.
- Reject calibration when the quiet-to-normal or normal-to-loud range is too
  narrow and explain how to retry without encouraging painful shouting.
- Normalize to `0..1`, then apply faster attack and slower release smoothing.
- Detect jump onset every audio frame, independent of whether the chicken is
  grounded. Grounded state decides whether the queued edge can be consumed.
- Apply jump hysteresis and a cooldown so a held sound cannot retrigger.
- Map the remaining airborne level to bounded lift; the MVP has no unlimited
  flight state.
- Persist only the derived calibration profile, never PCM or raw samples.

### Game simulation

- Use a fixed 60 Hz simulation step with variable-rate rendering.
- Keep the chicken in a stable horizontal screen region while the world scrolls.
- Use a seeded PRNG for all gameplay-affecting choices.
- Pool platforms, hazards, collectibles, and effects.
- Keep collision, score, and run-reset rules deterministic.
- For the MVP, play a fixed sequence of handcrafted chunks that loops.
- For the full game, select authored chunks by difficulty and compatible
  entry/exit traversal contracts. Do not generate arbitrary platform geometry.

MVP content:

- Wide starting platform
- Small and medium gaps
- Water/fall death plane
- One readable spike hazard
- Safe landing space after each new mechanic
- Original placeholder chicken with idle, run, jump, flap, and death states

Full-game content:

- Quiet tunnel that punishes excessive lift
- Sustained-lift gap
- Precision islands requiring separate voice pulses
- Moving platform or moving hazard
- Collectible feather path
- Lift stamina and recovery
- Bounded difficulty curve for speed, gap width, and landing width

The first full-game balance profile is intentionally fixed and replayable:

| Stage | Begins at chunk | World speed | Maximum gap | Maximum rise/drop | Minimum landing |
| ----- | --------------- | ----------- | ----------- | ----------------- | --------------- |
| 1     | 0               | 144 px/s    | 100 px      | 56 / 90 px        | 160 px          |
| 2     | 6               | 148 px/s    | 110 px      | 56 / 90 px        | 120 px          |
| 3     | 14              | 152 px/s    | 110 px      | 56 / 90 px        | 120 px          |
| 4     | 24              | 156 px/s    | 110 px      | 56 / 90 px        | 120 px          |
| 5     | 36              | 160 px/s    | 110 px      | 56 / 90 px        | 120 px          |

- A stage changes only when a new authored chunk begins. The generator gives
  introduction chunks more weight early and advanced chunks more weight later,
  while rejecting geometry outside the active traversal envelope.
- Airborne lift drains stamina at 40% per second at full input and released or
  grounded lift recovers it at 80% per second. Empty stamina suppresses lift,
  but raw held input still fails quiet-zone rules and tunnel ceilings remain
  solid.
- Survival earns 10 points per second. Each feather adds 25 points and the
  first landing on a platform no wider than 200 px adds 10 precision points.
  Results show every component separately.

## Privacy, security, and media

- Audio and video stay on the device and are never transmitted.
- Do not log raw or normalized voice samples.
- Show visible microphone/camera state and provide a camera-off control.
- The fallback background is original artwork, not a captured social video.
- All visual assets used by the compositor are self-hosted to avoid a
  cross-origin-tainted canvas.
- Use HTTPS in every deployed environment.
- Apply a restrictive content security policy compatible with the selected
  static host.
- Review third-party dependencies and licenses before release.

Replay is post-MVP:

- Recording is off by default and requires explicit consent before a run.
- A `720 × 1280`, 30 fps compositor draws the optional mirrored video, Phaser
  canvas, and in-run HUD.
- Retain only the final 15 seconds in memory for the results screen.
- Exclude microphone audio by default; including it requires a separate choice.
- Select a supported codec with `MediaRecorder.isTypeSupported`.
- Offer preview, delete, Web Share, and download.
- When recording is unsupported, export a static score card instead.
- Never upload or automatically persist replay blobs.

## Persistence and PWA behavior

Use versioned local storage for:

- Calibration profile
- Camera, mute, reduced-motion, and control preferences
- Local best scores and run statistics
- Last accepted privacy/permission explanation version

Every stored schema has a migration and a corrupt-data fallback. A reset action
clears all game-owned local data without affecting unrelated site storage.

The service worker:

- Precaches only versioned application assets.
- Never caches camera, microphone, replay, or object-URL data.
- Does not activate an update in the middle of a run.
- Provides an explicit refresh/update prompt after a run ends.
- Supports reload and basic play after the app shell has been cached.

The default deployment target is GitHub Pages over HTTPS. The production
workflow runs all gates before deploying an immutable build from `main`.

## Accessibility and mobile UX

- Voice is the signature input, not the only input.
- Keyboard and touch controls map to the same jump/lift intent.
- Permission, calibration, settings, pause, and results remain semantic DOM.
- Microphone feedback uses text/numbers in addition to color.
- All controls have visible focus and usable touch targets.
- Provide mute, reduced motion, and screen-shake controls.
- Do not require painful shouting; calibration copy explicitly says so.
- Pause on backgrounding and provide a visible resume action.
- Respect safe areas and dynamic viewport height.
- Treat recent iOS Safari and Android Chrome releases as primary.
- Treat current desktop Chrome, Edge, Firefox, and Safari as secondary.
- Embedded social-media webviews are best-effort and may direct users to their
  system browser when media capabilities are restricted.

## Testing strategy

### Unit tests

Test pure modules with injected time and deterministic data:

- RMS and dBFS conversion
- Quiet/normal/loud percentile calibration
- Invalid and clipped calibration
- Normalization and clamping
- Attack/release smoothing
- Hysteresis
- Jump onset and cooldown
- Held-input lift behavior
- Landing without a false jump
- State transitions and complete run reset
- Scoring
- Seeded chunk selection
- Chunk entry/exit compatibility
- Persistence migrations and corrupt-data recovery

### Component and integration tests

- Permission allow, deny, retry, and unavailable states
- Camera denial with successful microphone play
- Weak/clipped signal feedback
- Calibration completion and recalibration
- React-to-Phaser commands and Phaser-to-React events
- Pause, background, resume, quit, and cleanup
- Game over, restart, and listener/body/media leak checks
- Settings and reset-data behavior

### End-to-end tests

Use an injected deterministic input adapter for cross-browser gameplay tests and
a Chromium fake-media test for the actual browser permission/media boundary.

Cover:

- First-run onboarding
- Microphone denied, then fallback controls
- Camera disabled and camera denied
- Valid and invalid calibration
- One pulse/one jump
- Held sound/lift
- Collision, game over, and restart
- Portrait sizes, resize, and landscape prompt
- Hidden-tab pause and resume
- PWA offline reload and deferred update
- Replay opt-in, camera-off export, codec fallback, and deletion

Run Playwright against Chromium, WebKit, and Firefox where the test adapter is
used. Real media acceptance still requires physical iOS and Android devices.

### Continuous integration

Required pull-request gates:

```text
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:e2e
git diff --check
```

Upload test traces and reports only as CI artifacts; do not commit them.

### Release budgets

- Input-to-intent p95 at or below 100 ms after calibration
- Frame-time p95 at or below 20 ms on the documented reference phone
- No unbounded Phaser object, listener, audio-node, or media-track growth in a
  ten-minute scripted run
- No open critical or high privacy, security, accessibility, or gameplay bugs

## Agent contribution rules

The repository-level rules live in `AGENTS.md`. In summary:

- One Linear issue per isolated branch/worktree and one implementation owner.
- Do not start work while the issue has unresolved blocker relations.
- Inspect the initial worktree state and preserve unrelated changes.
- Stage explicit paths; never use blanket staging in a dirty worktree.
- Inspect the staged diff and run the required checks before committing.
- Every implementation agent commits all and only its completed ticket work.
- Review-only agents do not create empty commits.
- Commit subjects include the Linear identifier, for example:
  `feat(input): add calibrated voice intents (SHO-8)`.
- Handoff includes the commit SHA, commands run, results, and remaining risks.
- Never commit secrets, raw media, generated captures, caches, reports, build
  output, or another agent's work.

## Delivery roadmap

Linear project:
**[Shouting Chickens — Voice-Controlled Browser Game](https://linear.app/shouting-chickens/project/shouting-chickens-voice-controlled-browser-game-34f6b1b9dc80)**

Project priority: **High**

### 1 — Foundation & Vertical Slice

| Key | Linear | Ticket                                                               | Priority | Blocked by   |
| --- | ------ | -------------------------------------------------------------------- | -------- | ------------ |
| F1  | SHO-5  | Bootstrap the web app, repository scripts, and CI gates              | High     | —            |
| F2  | SHO-6  | Define runtime ports and deterministic test seams                    | High     | SHO-5        |
| F3  | SHO-7  | Implement microphone and optional-camera media lifecycle             | High     | SHO-5        |
| F4  | SHO-8  | Implement calibrated pulse-and-lift voice processing                 | High     | SHO-6, SHO-7 |
| F5  | SHO-9  | Build the responsive Phaser world and scripted-input chicken physics | High     | SHO-5, SHO-6 |

### 2 — Playable MVP

| Key | Linear | Ticket                                                               | Priority | Blocked by             |
| --- | ------ | -------------------------------------------------------------------- | -------- | ---------------------- |
| M1  | SHO-10 | Connect `ControlIntent` to jump and airborne lift                    | High     | SHO-8, SHO-9           |
| M2  | SHO-11 | Build the handcrafted looping course and core run lifecycle          | High     | SHO-10                 |
| M3  | SHO-12 | Build permission, calibration, HUD, fallback-control, and results UX | High     | SHO-7, SHO-8, SHO-11   |
| M4  | SHO-13 | Add optional mirrored camera and portrait composition                | High     | SHO-7, SHO-9           |
| M5  | SHO-14 | Validate and publish the playable MVP                                | High     | SHO-11, SHO-12, SHO-13 |

### 3 — Full Game Beta

| Key | Linear | Ticket                                                                        | Priority | Blocked by             |
| --- | ------ | ----------------------------------------------------------------------------- | -------- | ---------------------- |
| B1  | SHO-15 | Build seeded authored-chunk generation and reachability validation            | High     | SHO-14                 |
| B2  | SHO-16 | Add voice-aware obstacles and collectibles                                    | Medium   | SHO-10, SHO-15         |
| B3  | SHO-17 | Add difficulty progression, lift stamina, and scoring depth                   | Medium   | SHO-15, SHO-16         |
| B4  | SHO-18 | Create original chicken/platform art, animation, audio, and hazard feedback   | Medium   | SHO-11, SHO-16         |
| B5  | SHO-19 | Add versioned local settings, calibration, scores, and accessibility controls | High     | SHO-12, SHO-14         |
| B6  | SHO-20 | Harden browser lifecycle, compatibility, and performance                      | High     | SHO-17, SHO-18, SHO-19 |

### 4 — PWA Launch

| Key | Linear | Ticket                                                               | Priority | Blocked by             |
| --- | ------ | -------------------------------------------------------------------- | -------- | ---------------------- |
| P1  | SHO-21 | Ship the installable offline PWA and production Pages workflow       | High     | SHO-14, SHO-19         |
| P2  | SHO-22 | Add opt-in local replay and share export                             | Medium   | SHO-13, SHO-19, SHO-20 |
| P3  | SHO-23 | Complete privacy, security, accessibility, and production release QA | High     | SHO-20, SHO-21, SHO-22 |

## Linear issue contract

Every roadmap issue contains:

1. **Outcome** — the user or system result, not an implementation activity.
2. **Scope** — the owned behavior and relevant boundaries.
3. **Acceptance criteria** — observable completion conditions.
4. **Test evidence** — automated and manual checks required.
5. **Dependencies** — both blocked-by and blocks lists.
6. **Out of scope** — tempting adjacent work that stays separate.
7. **Agent handoff** — required commit SHA and verification results.

Dependencies must exist both in the issue description and as Linear blocker
relations. Priority `1` (Urgent) is reserved for active incidents or release
blockers, not planned roadmap work.

## Milestone exit criteria

### 1 — Foundation & Vertical Slice

- Clean install, lint, typecheck, tests, and production build succeed.
- Synthetic input can drive a deterministic Phaser run.
- Microphone and camera lifecycles are isolated behind adapters.
- A real calibrated onset produces one tested control intent.

### 2 — Playable MVP

- A player can complete onboarding and a full run on physical iOS and Android.
- Voice pulse, lift, collision, score, restart, optional camera, and fallback
  controls work.
- Permission, calibration, resize, orientation, and background failures recover.
- The HTTPS MVP build is published.

### 3 — Full Game Beta

- Every procedural chunk declares and passes traversal compatibility checks.
- Difficulty, stamina, content, settings, and local persistence are integrated.
- Original assets replace planning placeholders.
- Browser, lifecycle, performance, and accessibility budgets pass.

### 4 — PWA Launch

- Offline install/update behavior passes.
- Replay is opt-in, local-only, bounded, and gracefully unsupported.
- Privacy/security review is complete.
- No critical or high defects remain.
- Production deployment and rollback are verified.

## Main risks and mitigations

| Risk                                            | Mitigation                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Microphones and browser processing vary widely  | Three-stage calibration, signal-quality checks, manual threshold adjustment, physical-device matrix |
| Game audio retriggers the voice controller      | Low-volume design, echo cancellation preference, mute control, regression tests                     |
| Main-thread load adds input latency             | AudioWorklet scalar processing, fixed-step simulation, pooled objects, performance budgets          |
| Camera denial blocks the game                   | Request it separately and always provide an original fallback background                            |
| Browser suspension corrupts a run               | Explicit visibility/audio-context state machine and gesture-based resume                            |
| Procedural chunks become impossible             | Authored chunks, entry/exit contracts, seeded tests, compatibility validation                       |
| Replay causes thermal or memory pressure        | Post-MVP, 720p/30 fps cap, 15-second in-memory limit, capability fallback                           |
| Reference content creates rights/privacy issues | Keep screenshots uncommitted and create original production assets                                  |
