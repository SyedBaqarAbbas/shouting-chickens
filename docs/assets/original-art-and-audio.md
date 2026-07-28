# Original art and audio register

All production art and sound in this feature was created for this repository. The vector paths,
palette, silhouettes, layouts, motion, and oscillator envelopes were authored from a blank canvas;
they were not traced, sampled, or extracted from product-reference media. The repository `LICENSE`
(Apache-2.0) applies to every item below.

No person, social-media mark, watermark, third-party logo, recorded voice, music, or raw microphone
sample is present. The runtime loads one text-only SVG atlas and synthesizes short sound cues with
the Web Audio oscillator API, so there are no raster or recorded-audio payloads.

## Vector atlas component register

Source: `public/assets/shouting-chickens-atlas.svg`

| Frame            | Original component and use                                      | License    |
| ---------------- | --------------------------------------------------------------- | ---------- |
| `chicken-idle`   | Upright gold bird with cream wing and teal sash                 | Apache-2.0 |
| `chicken-run-a`  | Forward-leaning first running stride                            | Apache-2.0 |
| `chicken-run-b`  | Alternating second running stride                               | Apache-2.0 |
| `chicken-jump`   | Tall airborne silhouette with tucked feet                       | Apache-2.0 |
| `chicken-flap-a` | Raised-wing lift silhouette                                     | Apache-2.0 |
| `chicken-flap-b` | Lowered-wing lift silhouette                                    | Apache-2.0 |
| `chicken-death`  | Sideways bird with crossed eye and water droplet                | Apache-2.0 |
| `feather`        | Cream-and-teal curved collectible with gold sparkle             | Apache-2.0 |
| `spike`          | Navy rock-spike cluster on a coral base                         | Apache-2.0 |
| `moving-hazard`  | Coral animated hazard with eyes, motion marks, and dark base    | Apache-2.0 |
| `microphone`     | Rounded teal microphone with gold input sparkle                 | Apache-2.0 |
| `warning`        | Gold triangular alert with dark exclamation mark and coral rule | Apache-2.0 |
| `grass`          | Seamless gold-and-teal platform-top tile                        | Apache-2.0 |
| `platform`       | Seamless warm clay block tile with original seam pattern        | Apache-2.0 |
| `water`          | Seamless sky-blue wave tile with white crest                    | Apache-2.0 |
| `spark`          | Eight-point gold effect particle                                | Apache-2.0 |

The atlas has 16 fixed `80 × 80` cells in a `1280 × 80` SVG. It must remain at or below 24 KiB.
Release inspection validates its dimensions, rejects embedded image payloads, and includes its byte
size and SHA-256 in the sealed artifact manifest. Runtime pools contain a fixed 14 effect sprites;
effects never allocate per collision or collection.

If that single SVG request fails, `src/game/createGame.ts` draws an original Canvas 2D fallback for
all 16 frame roles and registers the same frame names. The fallback is Apache-2.0 repository code,
contains no remote or encoded payload, and keeps play available. Runtime diagnostics distinguish
`svg-atlas` from `generated-fallback` and report any visible object bound to a missing or unintended
frame.

## Generated presentation register

| Component                | Source                   | Original use                                      | License    |
| ------------------------ | ------------------------ | ------------------------------------------------- | ---------- |
| Procedural backdrop      | `src/game/createGame.ts` | Night sky, soft light shapes, and layered hills   | Apache-2.0 |
| Atlas failure renderer   | `src/game/createGame.ts` | Canvas primitives covering all 16 atlas roles     | Apache-2.0 |
| Fixed particle animation | `src/game/createGame.ts` | Pooled collection and impact sparkle trajectories | Apache-2.0 |

## Synthesized audio register

Source: `src/game/presentation/GameAudioDirector.ts`

| Cue       | Original synthesis design   | Maximum duration | Peak output gain |
| --------- | --------------------------- | ---------------- | ---------------- |
| `jump`    | Rising sine chirp           | 118 ms           | 0.026            |
| `flap`    | Falling triangle tick       | 82 ms            | 0.018            |
| `land`    | Short low sine knock        | 64 ms            | 0.016            |
| `feather` | Rising high sine glint      | 146 ms           | 0.024            |
| `hazard`  | Falling low sawtooth impact | 174 ms           | 0.032            |

Mute gates both existing and future oscillator output. Cues are derived from one-shot deterministic
simulation transitions, so an unchanged animation does not retrigger a sound. When multiple events
share one simulation tick, the director selects exactly one cue in this order: hazard, feather,
land, then jump or flap. A newly selected cue stops and disconnects the prior voice before it is
connected, and a run reset disposes any in-flight voice without closing the reusable graph. Every
voice feeds a shared hard limiter capped at `±0.032`, followed by a mute gain that is only `0` or
`1`; the final aggregate mix therefore cannot exceed the single-cue output ceiling. AudioContext
creation is lazy, context failure is silent and non-blocking, and teardown disconnects the graph
and closes the context.

## Accessibility and feedback safeguards

- Warnings combine an outlined triangular icon, a symbol, and explicit text. Color is never the
  only warning signal.
- Reduced motion freezes alternate animation frames, water movement, feather bobbing, moving-hazard
  accent rotation, particles, and camera shake. Collision text and static outlines remain.
- The deterministic feedback guardrail constrains every cue to 180 ms, permits only one active
  voice, and hard-limits the final aggregate output to 0.032 peak gain. It then models an
  intentionally conservative 0.2 speaker-to-microphone coupling. Because cue overlap is preempted,
  the maximum single-cue normalized energy is also the maximum aggregate modeled energy and must
  remain at or below 0.09.

That model is a regression guardrail, not physical-device evidence. Before a release is called
device-verified, run speaker-to-microphone loopback checks on a current iPhone/Safari and Android
phone/Chrome at 25%, 50%, and 100% media volume. Confirm idle game audio never produces a jump or
lift intent, then repeat jump, feather, and hazard cues while the microphone controller is active.
Record only pass/fail, device/OS/browser, volume, and release identity—never raw recordings or
levels. This physical iOS/Android check remains explicitly unresolved until hardware QA records it.
