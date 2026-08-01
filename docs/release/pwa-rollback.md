# PWA rollback and recovery runbook

GitHub Pages releases are immutable, and browsers may already hold a versioned application cache.
A rollback is therefore a new, fully gated release from a new commit—not a manual overwrite and not
an unverified redeploy of an old artifact.

## Before a release

Keep the workflow URL, deployed URL, full commit SHA, application version, artifact-manifest SHA,
PWA cache name, physical-device evidence URLs, and installed-desktop evidence URL. The artifact named
`mvp-<version>-<full-sha>` is immutable evidence for that source revision.

## Local artifact rehearsal

Download and extract both the current artifact and the intended known-good artifact without editing
either directory. Verify both sealed manifests and rehearse the selection:

```bash
CURRENT_DIST_DIR=/absolute/path/to/current \
ROLLBACK_DIST_DIR=/absolute/path/to/known-good \
ROLLBACK_EXPECTED_COMMIT=<known-good-full-sha> \
npm run rehearse:rollback
```

The command recomputes every declared byte length and SHA-256, verifies the release-specific PWA
cache/source-shell/service-worker identity, rejects a tampered or self-referential rollback, prints
the known-good manifest digest, and performs no network or deployment action. Its Vitest coverage
exercises a successful rehearsal, tamper rejection, same-commit rejection, and inconsistent PWA
identity rejection.

## Recover production

1. Stop release promotion and record the failing release identity and symptom.
2. Revert the faulty source change on `main` in a new commit. Do not reset, rewrite history, or
   edit the downloaded artifact.
3. Confirm the resulting behavior matches the known-good release, then run every local and CI gate,
   including installability, offline reload, deferred update, production acceptance, Lighthouse,
   soak, physical iOS/Android checks, and the installed desktop-browser matrix.
4. Dispatch the release workflow from the current `main` tip with `publish=true`, separate HTTPS
   iOS/Android/desktop evidence URLs, and the newly tested candidate manifest SHA.
5. Require the protected `github-pages` environment approval. The deploy job consumes only the
   artifact produced by its prerequisite quality job.
6. Run the automated postdeploy integrity/PWA smoke, then confirm an already-open client offers the
   new rollback release only after its active run ends.

## Why an old artifact is not directly redeployed

The known-good artifact proves what behavior to restore, but its old physical evidence and dependency
state are not automatically current. Reverting source and releasing a new immutable commit preserves
audit history, reruns security and compatibility gates, and gives the service worker a distinct cache
identity. If any current gate fails, rollback remains blocked until the failure is resolved.
