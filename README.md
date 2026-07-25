# Shouting Chickens

A mobile-first browser platformer where a calibrated voice pulse makes a
chicken jump and sustained sound adds airborne lift. The playable MVP includes
a handcrafted looping course, elapsed-time score, restart, optional mirrored
camera, and keyboard/touch fallback.

See [implementation-plan.md](implementation-plan.md) for the locked gameplay
model, full browser-product architecture, testing policy, and delivery roadmap.
Delivery is tracked in the
[Shouting Chickens Linear project](https://linear.app/shouting-chickens/project/shouting-chickens-voice-controlled-browser-game-34f6b1b9dc80).

The microphone is the signature controller, with keyboard and touch fallbacks.
The front camera is optional. Raw audio and video stay on-device.

The supplied social-video screenshots are planning references only; production
artwork and branding will be original.

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

Run `npm run test:e2e` for browser-facing changes.

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
npm run test:lighthouse
npm run test:soak
```

The soak defaults to five real wall-clock minutes. CI refuses a shorter soak.
SHO-14 automation is Chromium-only; real iOS Safari and Android Chrome evidence
is separately required before the manual Pages publish gate. WebKit/Firefox
automation is deferred to SHO-20.

Use the [release process](docs/release/release-process.md),
[physical-device checklist](docs/release/mvp-release-checklist.md), and
[support matrix](docs/release/support-matrix.md). The hosted artifact includes
local Privacy and Support pages. The MVP processes microphone and optional
camera input on-device and does not upload or save raw media.

## Handcrafted course contract

The MVP course is a fixed `2,500 px` cycle running at `144 px/s`. Its authored
jump/lift envelope is deliberately narrower than the controller limits:

- gaps are at most `110 px`, with no more than `56 px` of upward step;
- every gap has at least `190 px` of safe approach and `360 px` of landing;
- jump starts at `-470 px/s`, airborne rise is capped at `-560 px/s`, and
  authored lift traces use at most `0.8`;
- lift acceleration is `900 px/s²` against `1,180 px/s²` gravity, so even a
  continuously held maximum lift eventually descends;
- the sequence introduces a small water gap, a fall gap, a lift gap, and one
  spike before a safe return to the start.

Score is elapsed survival time at ten points per second. Water, a fall, or the
spike freezes the exact score tick; Space, Arrow Up, or tap starts a completely
reset run.
