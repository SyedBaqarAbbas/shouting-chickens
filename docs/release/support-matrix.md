# MVP support matrix and known limitations

The MVP targets current standalone mobile browsers over HTTPS. “Target” is not the same as
“verified”: physical evidence is recorded separately for each release candidate.

| Surface                           | MVP position                                 | SHO-14 automated evidence                 | Release evidence required                |
| --------------------------------- | -------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| iOS Safari on a current iPhone    | Target                                       | Chromium cannot prove Safari behavior     | Real-device checklist and evidence URL   |
| Android Chrome on a current phone | Target                                       | Chromium media adapters and portrait UI   | Real-device checklist and evidence URL   |
| Desktop Chrome                    | Supported for keyboard/touch and development | Full Chromium unit/integration/E2E suites | Automated release gates                  |
| Playwright WebKit                 | Future compatibility gate                    | Not run by SHO-14                         | Deferred to SHO-20                       |
| Playwright Firefox                | Future compatibility gate                    | Not run by SHO-14                         | Deferred to SHO-20                       |
| Edge and desktop Safari           | Best effort, not an MVP release target       | Not run by SHO-14                         | Report problems with exact versions      |
| Embedded social-media webviews    | Unsupported                                  | Not tested                                | Open the URL in standalone Safari/Chrome |

SHO-14 automation is intentionally Chromium-only. It validates the real browser media-session,
calibration, AudioWorklet URL, input, Phaser, recovery, responsive, release, and fallback boundaries
under Chromium. It does not constitute an iOS Safari, Android hardware, WebKit, or Firefox pass.
SHO-20 owns the broader automated cross-browser and performance matrix.

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
- The Phaser bundle is intentionally unoptimized for the MVP and currently produces a Vite
  large-chunk warning. Bundle/performance budgets are expanded in SHO-20.
- Original game cues are bounded by a deterministic low-output feedback model, but speaker-to-mic
  loopback remains a required physical iOS Safari and Android Chrome release check. The procedure
  and asset register are in `docs/assets/original-art-and-audio.md`; automation is not physical
  device evidence.

## Reporting a compatibility issue

Record the release version and short SHA prefix from the footer, the full commit SHA from the Release
identity link on Privacy/Support or `release.json`, exact device and OS, browser version, permission
state, steps to reproduce, expected/actual behavior, and whether keyboard/touch fallback still
works. Do not attach raw microphone or camera media.
