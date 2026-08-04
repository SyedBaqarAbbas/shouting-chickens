# Shouting Chickens v0.1.0 Release Notes

**Release Date:** August 4, 2026  
**Version:** `0.1.0`  
**License:** Apache-2.0

---

## Overview

**Shouting Chickens** is a mobile-first, local-first browser platformer where calibrated voice pulses trigger jumps and sustained vocalizations add airborne lift. Built as an installable Progressive Web Application (PWA), the entire game runs locally in the browser with zero cloud dependencies, remote analytics, or tracking.

---

## Key Features

### 1. Voice-Controlled & Fallback Gameplay

- **Calibrated Voice Input:** Voice energy processor with automated 3-stage calibration (Quiet, Comfortable, Strong) mapping voice onset to jump and sustained output to stamina-limited lift.
- **Accessible Fallbacks:** Full keyboard controls (`Space` / `ArrowUp` for jump/lift, `Escape` / `KeyP` for pause, `KeyM` for mute) and full-playfield touch controls.
- **Deterministic Course Generation:** Authored chunk-based courses generated deterministically via seeds (`safe-introduction`, etc.) with bounded gaps, rises, and drops.

### 2. Optional Mirrored Camera & Replay Export (SHO-22)

- **Optional Selfie Camera:** Front camera preview (mirrored) positionable as a non-blocking overlay. Camera remains off by default and stops immediately when disabled or tab is closed.
- **Opt-In Replay & Share Export:** 15-second memory-bounded local replay compositor (720×1280 @ 30 fps) capturing mirrored camera, Phaser canvas, and HUD overlay.
- **Privacy-First Export:** Replay blobs are generated on-device only upon explicit pre-run consent. Supports native Web Share API export, video download, and explicit blob deletion.
- **Static Score-Card Fallback:** On browsers lacking supported video codecs, a static 720×1280 PNG score-card image generator allows instant sharing and downloading without blocking play.

### 3. Progressive Web App (PWA) & Offline Support (SHO-21)

- **Installable PWA:** Full Web App Manifest with original 180px, 192px, 512px, and maskable PWA icons.
- **Offline Reliability:** Precaches exact release-specific source assets via Service Worker. Supports complete offline gameplay from a fresh app launch.
- **Non-Disruptive Updates:** Service Worker updates wait until the active run finishes and reload only after explicit player confirmation.

---

## Privacy & Security Architecture

1. **Local Media Processing:** Raw microphone audio and camera streams are processed exclusively in-memory on the client device using Web Audio API / AudioWorklet and HTML5 Canvas. Media data is **never** transmitted over network connections, logged, or saved to local storage.
2. **Transient Calibration Clips:** Optional 1-second calibration review clips are kept temporarily in memory during setup and discarded immediately upon advancing, retrying, exiting, or closing the tab.
3. **Clean Local Storage:** Player preferences, derived calibration thresholds, and local best scores are saved under `shouting-chickens.player-data.v2`. Corrupt records automatically restore safe defaults. **Reset local game data** purges all `shouting-chickens.*` keys without touching unrelated origin storage.
4. **Security & CSP Hardening:** Subpath-aware base routing, immutable release sealing (`release.json`, `artifact-manifest.json`), zero high-risk dependency vulnerabilities (`npm audit` clean), and Content Security Policy compatibility.

---

## Accessibility & Safety

- **Touch & Mouse Targets:** Minimum `44 × 44 px` interactive touch targets for all primary, secondary, pause, mute, and settings controls.
- **Keyboard & Screen Reader Support:** Full modal dialog focus containment, logical tab navigation order, visible focus indicators, Escape key dialog closing, and ARIA polite status announcements (`role="status"`).
- **Sensory Controls:** Toggleable Reduced Motion (freezes particle trajectories, bobbing, and camera shake), Screen Shake toggle, and instant audio Mute.
- **Dual Visual Signals:** Warnings and indicators combine shapes, symbols, and explicit text; color is never used as the sole indicator.

---

## Browser & System Compatibility

| Platform / Browser               | Support Status | Notes                                                                                    |
| :------------------------------- | :------------- | :--------------------------------------------------------------------------------------- |
| **iOS Safari** (iOS 15+)         | **Supported**  | Full voice calibration, touch fallback, camera overlay, PWA home screen installation     |
| **Android Chrome** (Android 10+) | **Supported**  | Full voice calibration, camera overlay, PWA installation, reference performance recorder |
| **Desktop Chrome** (v100+)       | **Supported**  | Full voice, keyboard, touch, camera overlay, Web Share / download export                 |
| **Desktop Edge** (v100+)         | **Supported**  | Full voice, keyboard, touch, camera overlay, Web Share / download export                 |
| **Desktop Firefox** (v100+)      | **Supported**  | Full voice, keyboard, touch, static score-card fallback if WebM recording unsupported    |
| **Desktop Safari** (v15+)        | **Supported**  | Full voice, keyboard, touch, camera overlay, native Web Share API                        |

---

## Known Limitations

- **Orientation Lock:** Landscape mode on phone viewports intentionally pauses gameplay until returning to portrait orientation.
- **Replay Codecs:** Video replay recording relies on browser `MediaRecorder` support for WebM/MP4 codecs. Unsupported browsers seamlessly fall back to static score-card PNG export.
- **Physical Audio Loopback:** Playing game sound through high-volume external speakers may trigger microphone jump sensitivity on uncalibrated devices; using headphones or proper calibration is recommended.
- **No Cloud Sync:** All game data, best scores, and calibrations remain stored in the local browser instance.

---

## Release Verification & Rollback

- **Quality Gates:** 100% test pass rate across 417 Vitest unit tests, 38 Playwright E2E tests, cross-browser compatibility tests (Chromium, Firefox, WebKit), Lighthouse PWA/Accessibility audits (100/100), and 10-minute CI soak test with zero heap memory leaks.
- **Rollback Runbook:** Rollbacks are released as new immutable commits using `npm run rehearse:rollback` for local manifest rehearsal prior to release deployment.
