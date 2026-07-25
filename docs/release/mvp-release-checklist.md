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
- [ ] Grant microphone access and complete quiet, comfortable, and strong calibration without
      painful shouting.
- [ ] Confirm one voice onset jumps, held comfortable sound adds bounded lift, and silence releases
      lift.
- [ ] Deny/revoke microphone access, retry, and complete a keyboard/touch fallback run.
- [ ] Confirm camera remains off until enabled; test both allow and deny paths.
- [ ] With camera allowed, confirm the displayed selfie video is mirrored and the game is not.
- [ ] Background and restore Safari; use the resume action and continue the same run.
- [ ] Rotate to landscape and back; confirm pause, readable guidance, and resume.
- [ ] Reach collision/results, verify score/survival, restart, and verify a clean run.
- [ ] Open Privacy and Support and return to the game.
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

Run the same twelve checks listed for iOS Safari. Record Android-specific permission wording,
audio-routing behavior, and any vendor battery/background restrictions.

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
