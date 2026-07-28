import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[] = [];

describe("local rollback rehearsal", () => {
  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it("verifies distinct current and known-good immutable artifacts without deploying", async () => {
    const current = await releaseFixture("1.2.0", "a".repeat(40));
    const rollback = await releaseFixture("1.1.0", "b".repeat(40));

    const result = runRehearsal(current, rollback, "b".repeat(40));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Rollback artifact rehearsal passed");
    expect(result.stdout).toContain("this rehearsal never deploys an old artifact directly");
  });

  it("rejects tampered known-good payloads", async () => {
    const current = await releaseFixture("1.2.0", "a".repeat(40));
    const rollback = await releaseFixture("1.1.0", "b".repeat(40));
    await writeFile(resolve(rollback, "index.html"), "tampered", "utf8");

    const result = runRehearsal(current, rollback);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Rollback artifact integrity mismatch: index.html");
  });

  it("rejects rehearsing the active commit as its own rollback", async () => {
    const current = await releaseFixture("1.2.0", "a".repeat(40));
    const rollback = await releaseFixture("1.2.0", "a".repeat(40));

    const result = runRehearsal(current, rollback);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Rollback rehearsal requires different current and known-good commit SHAs",
    );
  });

  it("rejects a sealed artifact whose PWA cache identity does not match its release", async () => {
    const current = await releaseFixture("1.2.0", "a".repeat(40));
    const rollback = await releaseFixture("1.1.0", "b".repeat(40), "shouting-chickens-shell-wrong");

    const result = runRehearsal(current, rollback);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PWA identity mismatch in rollback rehearsal directory");
  });
});

async function releaseFixture(version: string, commitSha: string, cacheNameOverride?: string) {
  const root = await mkdtemp(resolve(tmpdir(), "shouting-chickens-rollback-"));
  cleanup.push(root);
  const cacheName = cacheNameOverride ?? `shouting-chickens-shell-${version}-${commitSha}`;
  const pwaAssets = ["./", "./index.html", "./pwa-release.json", "./release.json"];
  const payloads = {
    "index.html": `<h1>${version}</h1>`,
    "pwa-release.json": `${JSON.stringify({
      schemaVersion: 1,
      version,
      commitSha,
      cacheName,
      assets: pwaAssets,
    })}\n`,
    "release.json": `${JSON.stringify({ schemaVersion: 1, version, commitSha })}\n`,
    "service-worker.js": `const RELEASE_ID = ${JSON.stringify(`${version}:${commitSha}`)};
const CACHE_NAME = ${JSON.stringify(cacheName)};
const PRECACHE_URLS = ${JSON.stringify(pwaAssets, null, 2)};
if (event.data.type === "APPLY_UPDATE") self.skipWaiting();
`,
  };
  for (const [path, content] of Object.entries(payloads)) {
    const destination = resolve(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  const files = await Promise.all(
    Object.keys(payloads)
      .sort()
      .map(async (path) => {
        const bytes = await readFile(resolve(root, path));
        return {
          path,
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }),
  );
  await writeFile(
    resolve(root, "artifact-manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, version, commitSha, files }, null, 2)}\n`,
    "utf8",
  );
  return root;
}

function runRehearsal(current: string, rollback: string, expectedCommit?: string) {
  return spawnSync(process.execPath, [resolve("scripts/rehearse-rollback.mjs")], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CURRENT_DIST_DIR: current,
      ROLLBACK_DIST_DIR: rollback,
      ROLLBACK_EXPECTED_COMMIT: expectedCommit ?? "",
    },
  });
}
