# Browser, device, and performance support matrix

The game targets current standalone mobile and desktop browsers over HTTPS. “Target” is not the
same as “verified”: exact physical evidence is recorded separately for each release candidate and
must never be inferred from an emulated browser.

| Surface                           | Product position | Automated evidence                         | Candidate evidence required              |
| --------------------------------- | ---------------- | ------------------------------------------ | ---------------------------------------- |
| iOS Safari on a current iPhone    | Supported        | Playwright WebKit compatibility gate       | Real-device checklist and evidence URL   |
| Android Chrome on a current phone | Supported        | Chromium fake-media and portrait UI gates  | Real-device checklist and evidence URL   |
| Desktop Chrome                    | Supported        | Chromium development/release/compatibility | Manual pass in installed Chrome          |
| Desktop Edge                      | Supported        | Chromium engine compatibility gate         | Manual pass in installed Edge            |
| Desktop Firefox                   | Supported        | Playwright Firefox compatibility gate      | Manual pass in installed Firefox         |
| Desktop Safari                    | Supported        | Playwright WebKit compatibility gate       | Manual pass in installed Safari          |
| Embedded social-media webviews    | Unsupported      | Not tested                                 | Open the URL in standalone Safari/Chrome |

Run the sealed cross-engine gate with `npm run test:e2e:compatibility`. It drives the same
keyboard/touch intent, synthetic visibility latch, explicit gesture resume, Phaser surface, and
privacy-safe diagnostics through Chromium, Firefox, and WebKit. Run `npm run test:e2e:production`
for the Chromium fake-media voice/camera boundary. Neither command constitutes physical-mobile or
installed-desktop evidence.

## Performance reference and budgets

The physical reference phone is the Android device named in the candidate checklist, in portrait
orientation, with Chrome current at the time of release, battery saver disabled, and no remote
debugger attached. Use the query-gated Settings recorder documented in the checklist and record its
unchanged JSON alongside manufacturer/model, OS, browser version, refresh rate, and thermal state.
The same candidate must meet:

- Voice onset to created control intent p95 at or below 100 ms after calibration, using the
  voice-provenance histogram rather than the combined fallback-input histogram.
- Running-frame p95 at or below 20 ms.
- A true 600,000 ms physical capture with bounded app-owned bodies, timers, listeners, pooled
  objects, retained identifiers, audio nodes/voices, and media tracks.
- A true 600,000 ms same-SHA sealed Chromium soak with a bounded post-GC heap trend.

`npm run test:soak` writes coarse evidence to `.release-evidence/restart-soak.json`. The safe local
diagnostic JSON payloads intentionally expose only release identity, seed/gameplay version,
renderer, capabilities, coarse timing buckets, and resource counts. Those payloads contain no
device identifiers, raw audio, dBFS/RMS/normalized voice levels, camera frames, or recordings.

## Known MVP limitations

- Derived calibration, settings, and completed-run bests persist locally in a versioned browser
  record. There is no cloud sync, and corrupt or unknown records restore defaults.
- The release is installable and a previously loaded source shell supports local offline play.
  First load, first install, and every new release still require a network connection.
- A waiting service worker never activates from application code during a run. The update prompt
  appears after the run and reloads only after explicit confirmation.
- There are no accounts, online leaderboards, cloud replays, remote analytics, speech recognition,
  or gameplay backend.
- Camera and microphone support varies with browser permissions, operating-system privacy controls,
  device routing, and embedded-browser restrictions.
- Phone landscape mode intentionally pauses play until portrait orientation returns.
- Camera playback is optional. Denial, unavailability, or interruption uses the original fallback
  background and must not block play.
- Space, Arrow Up, and playfield press/hold remain fully playable fallbacks in every control mode.
  Mute, reduced motion, screen shake, camera preference, manual threshold, recalibration, pause, and
  game-owned data reset are available from the accessible settings dialog.
- AudioWorklet is preferred; an inaudible analyser-based scalar fallback is used where worklets are
  exposed but unavailable.
- The Phaser bundle may still produce a Vite large-chunk warning; runtime frame and resource
  budgets are measured independently.
- Original game cues are bounded by a deterministic low-output feedback model, but speaker-to-mic
  loopback remains a required physical iOS Safari and Android Chrome release check. The procedure
  and asset register are in `docs/assets/original-art-and-audio.md`; automation is not physical
  device evidence.

## Reporting a compatibility issue

Record the release version and short SHA prefix from the footer, the full commit SHA from the Release
identity link on Privacy/Support or `release.json`, exact device and OS, browser version, permission
state, steps to reproduce, expected/actual behavior, and whether keyboard/touch fallback still
works. Do not attach raw microphone or camera media.
