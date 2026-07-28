# Shouting Chickens

A mobile-first browser platformer where a calibrated voice pulse makes a
chicken jump and sustained sound adds stamina-limited airborne lift. The
playable game uses a seeded stream of authored chunks with bounded difficulty,
survival and optional-bonus scoring, restart, optional mirrored camera, and
keyboard/touch fallback.

See [implementation-plan.md](implementation-plan.md) for the locked gameplay
model, full browser-product architecture, testing policy, and delivery roadmap.
Delivery is tracked in the
[Shouting Chickens Linear project](https://linear.app/shouting-chickens/project/shouting-chickens-voice-controlled-browser-game-34f6b1b9dc80).

The microphone is the signature controller, with keyboard and touch fallbacks.
The front camera is optional. Media stays on-device. During calibration, the
game can hold one brief comfortable- or strong-voice clip in memory so the
player can review it; that clip is replaced or discarded when calibration
advances, retries, exits, or the tab closes.

The supplied social-video screenshots are planning references only; production
artwork and branding will be original.

The production build is an installable offline PWA. It precaches only an exact,
release-specific list of application source files. A waiting release remains
inactive during a run and reloads only after the player confirms the visible
update prompt.

## Local development

Use Node `22.19.0` and npm `10.9.3`.

```bash
npm ci
npm run dev
```

Before committing an implementation ticket:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
```

Run `npm run test:e2e` for browser-facing changes and `npm run test:e2e:pwa`
for installability, offline, service-worker update, or Pages-routing changes.

## MVP release verification

The production build carries its package version and full commit SHA, is sealed
with per-file SHA-256 evidence, and is inspected before it can become a Pages
artifact:

```bash
APP_VERSION="$(node -p "require('./package.json').version")"
COMMIT_SHA="$(git rev-parse HEAD)"
export APP_VERSION COMMIT_SHA
npm run build
npm run test:e2e:production
npm run test:e2e:pwa
npm run test:lighthouse
npm run test:soak
```

The soak defaults to five real wall-clock minutes. CI refuses a shorter soak.
SHO-14 automation is Chromium-only; real iOS Safari and Android Chrome evidence
is separately required before the manual Pages publish gate. WebKit/Firefox
automation is deferred to SHO-20.

Use the [release process](docs/release/release-process.md),
[physical-device checklist](docs/release/mvp-release-checklist.md), and
[support matrix](docs/release/support-matrix.md). Use the
[rollback runbook](docs/release/pwa-rollback.md) to validate a known-good
artifact and rehearse recovery without deploying it. The hosted artifact
includes local Privacy and Support pages. The MVP processes microphone and
optional camera input on-device. It does not upload raw media or persist
recordings; calibration playback is transient and remains only in the current
tab.

## Local settings, privacy, and fallback controls

After setup, **Accessibility & settings** stores one versioned
`shouting-chickens.player-data.v2` record in this browser. It contains only
derived calibration thresholds, local best/run statistics, the camera
preference, mute, reduced-motion, screen-shake, preferred-control, and safety
copy versions. It never contains microphone samples, calibration playback,
camera frames, or raw media. Corrupt or unknown data restores safe defaults;
**Reset local game data** removes every `shouting-chickens.*` key without
clearing another app's origin storage.

Every run is playable without a microphone:

- press `Space` or `Arrow Up` for a jump and hold briefly for lift;
- tap or press and hold anywhere on the playfield for the same jump/lift input;
- use the visible Pause, Mute, and Settings controls with keyboard focus or a
  touch target of at least `44 × 44 px`.

Voice players can recalibrate or adjust the derived jump threshold between
`38%` and `72%`. A saved calibration still requires a fresh browser permission
gesture on a new visit. Camera preference never starts the camera
automatically. Bests update only after a valid local run reaches results.

## Generated course and scoring contract

Every run selects from authored, reachability-checked chunks using its seed and
gameplay version; it does not generate arbitrary platform geometry. Difficulty
changes only when a new chunk begins:

- stages begin at chunks `0`, `6`, `14`, `24`, and `36`;
- world speed rises from `144 px/s` to a capped `160 px/s`;
- selected routes stay within a `110 px` maximum gap, `56 px` maximum rise,
  `90 px` maximum drop, and the active minimum landing width;
- introduction chunks have more weight early and advanced chunks gain weight
  later, without bypassing compatible entry/exit contracts;
- airborne lift drains stamina at `40%` per second at full input, while release
  or grounded play recovers it at `80%` per second.

Survival earns ten points per second, each optional feather earns `25`, and the
first landing on a platform no wider than `200 px` earns `10` precision points.
Results report those components plus distance, obstacles, collectibles,
precision landings, and longest lift; the non-identifying run summary also
records the highest stage. Restart resets the course stream, difficulty,
stamina, score, and run statistics to the same seeded initial state.
