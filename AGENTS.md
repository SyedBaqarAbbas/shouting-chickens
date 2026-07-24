# Agent contribution rules

These instructions apply to every agent working in this repository.

## Work ownership

- Work from one Linear issue at a time.
- Use an isolated branch or worktree named from the Linear issue, for example
  `sho-12-calibrated-voice-input`.
- Do not begin implementation while the issue has unresolved blocker relations.
- Record the initial `git status --short` and preserve all unrelated user or
  agent changes.
- Do not modify, amend, rebase, discard, or commit another agent's work.

## Scope and staging

- Make only the changes required by the owned issue and its acceptance criteria.
- Keep generated output, experiments, local media, and debugging artifacts out
  of source directories.
- Stage explicit paths with `git add <path>`. Do not use `git add .` or another
  blanket staging command when unrelated or untracked files are present.
- Review `git diff --cached` and `git status --short` before every commit.
- Intentional lockfiles, tests, fixtures, migrations, source assets, and
  snapshots belong in the commit. Caches, reports, recordings, screenshots,
  build output, dependencies, and secrets do not.

## Verification

- Run focused tests while developing.
- Before committing a completed issue, run:

```text
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
git diff --check
```

- Run `npm run test:e2e` when the issue changes user flows, browser media,
  Phaser integration, responsive behavior, persistence, PWA behavior, or
  replay.
- Never update a failing snapshot or weaken a test without explaining why in
  the issue handoff.

## Commits and handoff

- Every implementation agent must commit all and only its completed issue work
  before handoff. Leave no scoped changes uncommitted.
- Review-only agents must not create empty commits.
- Use a meaningful imperative subject with the Linear identifier:

```text
feat(input): add calibrated voice intents (SHO-8)
fix(game): prevent landing jump retrigger (SHO-34)
test(media): cover camera denial fallback (SHO-41)
```

- The handoff must include:
  - Commit SHA
  - Files or behavior changed
  - Exact commands run and their results
  - Manual checks performed
  - Remaining risks or follow-up work

## Privacy and assets

- Never commit raw microphone or camera recordings, exported replays, real
  calibration samples, access tokens, credentials, or local environment files.
- Do not copy people, watermarks, logos, or artwork from the product-reference
  screenshots into the game.
- Add only original, licensed, or attribution-compatible assets and document
  their source.
- Do not log raw or normalized voice levels in production.
