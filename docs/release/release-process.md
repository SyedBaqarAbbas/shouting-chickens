# Gated GitHub Pages release process

The workflow builds once, verifies that exact directory, uploads it as immutable evidence, hands the
same `dist/` directory to GitHub Pages, and verifies every deployed file digest after deployment.
No deploy job rebuilds the application.

## 1. Prepare the candidate

1. Work from `main` with a clean checkout and no untracked secrets or local media.
2. Use Node `22.19.0` and npm `10.9.3`.
3. Run `npm ci` and the complete gate in
   [mvp-release-checklist.md](mvp-release-checklist.md).
4. Build with the package version and full commit SHA:

   ```bash
   APP_VERSION="$(node -p "require('./package.json').version")"
   COMMIT_SHA="$(git rev-parse HEAD)"
   export APP_VERSION COMMIT_SHA
   npm run build
   ```

The build emits:

- `release.json` with version and commit identity;
- `artifact-manifest.json` with byte length and SHA-256 for every other production file;
- `pwa-release.json` with the release-specific cache name and exact source-shell paths;
- an install manifest, original 180/192/512/maskable icons, and a waiting service worker;
- a Pages `404.html` that restores the configured project subpath on direct reload;
- a Pages-base-aware entry point, favicon, privacy page, support page, and AudioWorklet URL;
- `.nojekyll`, so Pages does not transform the tested artifact.

`scripts/inspect-build.mjs` allowlists production paths, rejects symlinks, source maps, unapproved
raw or embedded media, test/report/reference paths, binary media signatures, large/obfuscated
base64 payloads, the three planning-reference screenshot fingerprints, unapproved root-absolute
URLs, and high-confidence credential patterns. The one approved absolute URL is the build-time
validated `<base>` matching `PAGES_BASE_PATH`; it keeps cached shell assets inside the service-worker
scope when an offline deep-link URL is preserved. The pinned Phaser package's six exact hash-and-size
PNG fallbacks are the only embedded-image exception. Its adversarial Vitest suite proves tamper,
renamed media, encoded media, secret, unexpected-path, and Pages-subpath failures. This is a release
guard, not a substitute for reviewing source changes or rotating an exposed credential.

The PWA inspection additionally requires every icon's actual PNG dimensions, the install manifest's
scope/start/display/theme/background/purpose metadata, an exact source-only precache list, embedded
release identity, and a worker with one install-time cache write path. Media, replays, reports,
object URLs, API-like paths, and cross-origin requests are never runtime-cached.

## 2. Collect real-device evidence

Complete [mvp-release-checklist.md](mvp-release-checklist.md) on physical iOS Safari and Android
Chrome against the exact candidate URL and SHA. Store separate durable HTTPS text records. Desktop
emulation and Chromium automation cannot satisfy these rows.

The physical devices need a trusted secure-context URL before the production Pages gate can open.
Use this candidate sequence without rebuilding:

1. Let a non-publishing workflow run finish and download its
   `mvp-<version>-<full-sha>` artifact, or use the locally sealed `dist/` produced from that exact
   SHA.
2. Serve that directory with `PAGES_BASE_PATH=/shouting-chickens/ npm run preview:pages`.
3. Expose the local server through an access-controlled, trusted-certificate HTTPS tunnel, or upload
   the directory unchanged to an approved temporary static candidate host. Preserve the
   `/shouting-chickens/` path. Do not use a plain HTTP LAN URL: it is not a browser media secure
   context.
4. Run the post-deploy integrity test against the candidate URL:

   ```bash
   DEPLOY_URL=https://candidate.example/shouting-chickens/ \
   APP_VERSION=0.1.0 \
   COMMIT_SHA=<full-sha> \
   ARTIFACT_MANIFEST_SHA=<manifest-sha256> \
   npm run test:postdeploy
   ```

5. Complete both physical checklists against that URL, record the exact version/SHA/manifest hash,
   then remove the temporary candidate host or tunnel.

The candidate host may transport only the already sealed public files. It must not inject scripts,
rewrite responses, proxy microphone/camera media, or receive raw calibration data. Verify the
manifest before and after hosting. The final workflow rebuilds the same source SHA deterministically
and refuses deployment unless its artifact-manifest SHA exactly equals the physically tested
candidate SHA.

Do not publish if either device fails a required flow. Fix the issue on a new commit and repeat the
candidate build and both device checks.

## 3. Publish through the protected workflow

GitHub Pages is configured for **GitHub Actions**, HTTPS is enforced, and the protected
`github-pages` environment requires a reviewer for `main`. These are repository controls, not
workflow side effects; `configure-pages` intentionally does not auto-enable a missing site. The
repository workflow itself has read-only permissions except:

- the deploy job receives `pages: write` and `id-token: write`, configures the existing site, and
  deploys;
- all third-party actions are pinned to full commit SHAs;
- deployment runs only from a manual `main` dispatch with `publish=true`;
- the selected SHA must equal the current remote `main` tip;
- separate HTTPS iOS and Android evidence URLs are mandatory.

Pushes to `main` run the complete quality job but intentionally do not auto-deploy. Automatic
promotion would bypass the physical-device evidence values and protected-environment review required
for this media-capable game. Static workflow-policy tests ensure deploy still depends on the complete
quality job and postdeploy still depends on both quality and deploy.

Dispatch after evidence is complete:

```bash
gh workflow run ci.yml \
  --ref main \
  -f publish=true \
  -f ios_evidence_url=https://example.invalid/ios-evidence \
  -f android_evidence_url=https://example.invalid/android-evidence \
  -f candidate_manifest_sha=<physically-tested-manifest-sha256>
```

Replace the example URLs with the real records. The quality job runs clean install, audit, formatting,
lint, typecheck, unit/integration tests, the ordinary E2E suite, sealed Pages-subpath acceptance,
installability/offline/deferred-update acceptance, Lighthouse, and a true five-minute restart soak.
Only then does it:

1. upload `mvp-<version>-<full-sha>` as the immutable tested artifact;
2. upload Lighthouse/soak evidence separately;
3. upload the same `dist/` directory as the Pages artifact.

The deploy job consumes that Pages artifact. The post-deploy job requires HTTPS, matches visible and
JSON version/SHA, matches the expected artifact-manifest SHA, downloads every declared file,
recomputes every byte length/SHA-256, validates installability/PWA metadata and direct reload, opens
privacy/support/worklet paths, and starts a fallback run.

## 4. Review the result

Keep the workflow run URL, deployment URL, version, full commit SHA, manifest SHA, iOS evidence URL,
Android evidence URL, Lighthouse summary, soak JSON, and post-deploy result in the SHO-14 handoff.
Physical results must remain explicitly separate from Chromium automation.

## Rollback

Follow the [PWA rollback runbook](pwa-rollback.md). Rehearse the sealed current and known-good
artifacts locally, revert the bad source on `main`, run automated and physical acceptance against the
new revert commit, then dispatch a new versioned release. Do not manually replace Pages files or
redeploy an unverified old directory.
