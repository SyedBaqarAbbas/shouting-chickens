# MVP release evidence checklist

This checklist separates automated browser evidence from physical-device evidence. Do not mark a
physical row complete from desktop emulation, Playwright device descriptors, screenshots, or an
agent statement.

## Release candidate identity

Record these values before any physical test:

| Field                        | Value |
| ---------------------------- | ----- |
| Version                      |       |
| Full 40-character commit SHA |       |
| HTTPS candidate URL          |       |
| Artifact-manifest SHA-256    |       |
| Test date in UTC             |       |
| Tester                       |       |

The visible footer must match the version and seven-character SHA prefix. Verify the full
40-character SHA in `release.json` and `artifact-manifest.json`.

## Automated release gates

Run from a clean checkout with Node `22.19.0` and npm `10.9.3`:

```text
npm ci
npm audit --audit-level=low
npm run format:check
npm run lint
npm run typecheck
npm run test
APP_VERSION=0.1.0 COMMIT_SHA=<full-sha> npm run build
npm run test:e2e
APP_VERSION=0.1.0 COMMIT_SHA=<full-sha> npm run test:e2e:production
APP_VERSION=0.1.0 COMMIT_SHA=<full-sha> npm run test:e2e:pwa
npm run test:lighthouse
npm run test:soak
git diff --check
```

`npm run test:soak` defaults to `300000` wall-clock milliseconds. CI rejects a shorter configured
duration. A local accelerated run is useful while developing but is not release evidence.

Expected generated evidence stays outside the deployable `dist/` directory:

- `.lighthouse/lhr.json` and `.lighthouse/summary.json`
- `.release-evidence/restart-soak.json`
- Playwright traces/screenshots only when a browser test fails

## Physical iOS Safari

Status at repository handoff: **not run**. Complete on a real iPhone or iPad in standalone Safari.

| Field                    | Value |
| ------------------------ | ----- |
| Device model             |       |
| iOS/iPadOS version       |       |
| Safari version           |       |
| Evidence URL             |       |
| Result: pass/fail        |       |
| Limitation/issue links   |       |
| Tester and UTC timestamp |       |

Verify every item:

- [ ] Open the exact HTTPS release URL, match the visible version/short SHA prefix, and match the
      full SHA in `release.json`.
- [ ] Confirm microphone is not requested before the enable gesture.
- [ ] Grant microphone access; confirm the microphone icon and live meter respond before capture;
      complete the visibly timed quiet, comfortable, and strong steps without painful shouting;
      review each available voice clip; retry one invalid step without losing prior steps; then use
      the explicit confirmation action.
- [ ] Confirm one voice onset jumps, held comfortable sound adds bounded lift, and silence releases
      lift.
- [ ] Deny/revoke microphone access, retry, and complete a keyboard/touch fallback run.
- [ ] Confirm camera remains off until enabled; test both allow and deny paths.
- [ ] With camera allowed, confirm the displayed selfie video is mirrored and the game is not.
- [ ] Background and restore Safari; use the resume action and continue the same run.
- [ ] Rotate to landscape and back; confirm pause, readable guidance, and resume.
- [ ] Reach collision/results, verify score/survival, restart, and verify a clean run.
- [ ] Open Privacy and Support and return to the game.
- [ ] Add the release to the Home Screen, close the browser tab, launch the installed app, then
      enable airplane mode and complete a keyboard/touch run from a fresh installed-app launch.
- [ ] With the device online again, leave an older release open, publish the tested candidate, and
      confirm its update waits through an active run, appears afterward, and reloads only after
      explicit confirmation.
- [ ] Close the tab and confirm browser microphone/camera indicators stop.

## Physical Android Chrome

Status at repository handoff: **not run**. Complete on a real Android phone in standalone Chrome.

| Field                    | Value |
| ------------------------ | ----- |
| Device model             |       |
| Android version          |       |
| Chrome version           |       |
| Evidence URL             |       |
| Result: pass/fail        |       |
| Limitation/issue links   |       |
| Tester and UTC timestamp |       |

Run the same fourteen checks listed for iOS Safari. Record Android-specific permission wording,
audio-routing behavior, and any vendor battery/background restrictions.

## Settings and accessibility release review

Run on both physical targets and the desktop release candidate:

- [ ] Complete a run with only keyboard, then one with playfield press-and-hold; confirm Pause,
      Mute, Settings, and camera controls have at least `44 × 44 px` touch targets.
- [ ] Traverse onboarding, settings, pause, and results with Tab/Shift+Tab; confirm visible focus,
      logical order, contained modal focus, Escape/Close behavior, and focus restoration.
- [ ] Review headings, control names, status announcements, and text-plus-color feedback with a
      screen reader; run axe with no serious or critical violations.
- [ ] Toggle mute, reduced motion, screen shake, and camera preference; confirm state applies
      immediately and survives reload without automatically requesting camera access.
- [ ] Recalibrate and adjust the derived voice threshold only within `38%–72%`; confirm no raw
      sample, playback URL, or media data appears in browser storage.
- [ ] Complete a valid run and verify bests persist; cancel/quit an invalid run and verify it cannot
      update bests.
- [ ] Corrupt/replace the versioned local record and confirm safe recovery; reset local data and
      confirm all `shouting-chickens.*` keys clear while unrelated origin storage remains.

## Evidence handling

- Attach separate text evidence records for iOS and Android to SHO-14 or another durable HTTPS
  location. The publish workflow requires both URLs and refuses one shared URL.
- Include the device/browser versions, candidate URL, full commit SHA, each check result, and issue
  links for failures.
- Do not commit microphone recordings, camera video, faces, credentials, browser profiles, or raw
  calibration samples. Prefer a signed text checklist. If external visual evidence is necessary,
  obtain consent, minimize personal data, and keep it outside the repository.
- A failed required physical check blocks publishing. Fix it on a new commit, rebuild, and repeat
  both automated and physical evidence against the new SHA.
