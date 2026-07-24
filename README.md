# Shouting Chickens

A mobile-first browser platformer where a calibrated voice pulse makes a
chicken jump and sustained sound adds airborne lift.

The product is currently in architecture and roadmap planning. See
[implementation-plan.md](implementation-plan.md) for the locked gameplay model,
MVP scope, full browser-product architecture, testing policy, and delivery
roadmap. Delivery is tracked in the
[Shouting Chickens Linear project](https://linear.app/shouting-chickens/project/shouting-chickens-voice-controlled-browser-game-34f6b1b9dc80).

The microphone is the signature controller, with keyboard and touch fallbacks.
The front camera is optional. Raw audio and video stay on-device.

The supplied social-video screenshots are planning references only; production
artwork and branding will be original.

## Local development

Use Node `22.18.0` and npm `10.9.3`.

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

## Handcrafted course contract

The MVP course is a fixed `2,500 px` cycle running at `144 px/s`. Its authored
jump/lift envelope is deliberately narrower than the controller limits:

- gaps are at most `110 px`, with no more than `56 px` of upward step;
- every gap has at least `190 px` of safe approach and `360 px` of landing;
- jump starts at `-470 px/s`, airborne rise is capped at `-560 px/s`, and
  authored lift traces use at most `0.8`;
- the sequence introduces a small water gap, a fall gap, a lift gap, and one
  spike before a safe return to the start.

Score is elapsed survival time at ten points per second. Water, a fall, or the
spike freezes the exact score tick; Space, Arrow Up, or tap starts a completely
reset run.
