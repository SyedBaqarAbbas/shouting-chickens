import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const VERSION = "0.1.0";
const COMMIT_SHA = "a".repeat(40);
const temporaryDirectories: string[] = [];

describe("release artifact inspection", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it("accepts a sealed, Pages-relative, text-only artifact", async () => {
    const root = await createFixture();
    expect(runScript("seal-build.mjs", root).status).toBe(0);

    const inspection = runScript("inspect-build.mjs", root);
    expect(inspection.status, inspection.stderr).toBe(0);
    expect(inspection.stdout).toContain(`Inspected 11 production files for ${VERSION}`);
  });

  it("rejects payload tampering after the artifact is sealed", async () => {
    const root = await createFixture();
    expect(runScript("seal-build.mjs", root).status).toBe(0);
    await writeFile(resolve(root, "assets/index.js"), "tampered", "utf8");

    expect(runScript("inspect-build.mjs", root).stderr).toContain(
      "Artifact integrity mismatch: assets/index.js",
    );
  });

  for (const scenario of [
    {
      name: "embedded payloads in the original game atlas",
      file: "assets/shouting-chickens-atlas.svg",
      content:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 80"><image href="data:image/png;base64,AAAA"/></svg>',
      error: "Original game atlas is malformed or contains an embedded/copied payload",
    },
    {
      name: "an original game atlas over its load budget",
      file: "assets/shouting-chickens-atlas.svg",
      content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 80">${" ".repeat(
        24 * 1_024,
      )}</svg>`,
      error: "Original game atlas exceeds 24576 bytes",
    },
    {
      name: "test-report paths",
      file: "test-results/results.json",
      content: "{}",
      error: "Unexpected file in production artifact: test-results/results.json",
    },
    {
      name: "high-confidence secrets",
      file: "assets/index.js",
      content: `const token = "ghp_${"A".repeat(30)}"; "${VERSION}"; "${COMMIT_SHA}"; "./audio/voice-rms-processor.js";`,
      error: "Possible secret found in production artifact: assets/index.js",
    },
    {
      name: "embedded media data URLs",
      file: "assets/index.js",
      content: `"${VERSION}"; "${COMMIT_SHA}"; "./audio/voice-rms-processor.js"; "data:image/png;base64,${Buffer.alloc(
        80_000,
        23,
      ).toString("base64")}";`,
      error: "Unapproved embedded image data found in production artifact: assets/index.js",
    },
    {
      name: "parameterized embedded media data URLs",
      file: "assets/index.js",
      content: `"${VERSION}"; "${COMMIT_SHA}"; "./audio/voice-rms-processor.js"; "data:image/png;charset=utf-8;base64,${Buffer.alloc(
        80_000,
        23,
      ).toString("base64")}";`,
      error: "Unapproved embedded image data found in production artifact: assets/index.js",
    },
    {
      name: "percent-encoded SVG data URLs",
      file: "assets/index.js",
      content: `"${VERSION}"; "${COMMIT_SHA}"; "./audio/voice-rms-processor.js"; "data:image/svg+xml;charset=utf-8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg"><rect width="640" height="640"/></svg>`,
      )}";`,
      error: "Unapproved embedded image data found in production artifact: assets/index.js",
    },
    {
      name: "large bare base64 payloads",
      file: "assets/index.js",
      content: `"${VERSION}"; "${COMMIT_SHA}"; "./audio/voice-rms-processor.js"; "${Buffer.alloc(80_000, 23).toString("base64")}";`,
      error: "Large encoded payload found in production artifact: assets/index.js",
    },
    {
      name: "chunked bare base64 payloads",
      file: "assets/index.js",
      content: (() => {
        const encoded = Buffer.alloc(80_000, 23).toString("base64");
        const chunks = encoded.match(/.{1,3000}/g) ?? [];
        return `"${VERSION}"; "${COMMIT_SHA}"; "./audio/voice-rms-processor.js"; [${chunks
          .map((chunk) => JSON.stringify(chunk))
          .join(",")}].join("");`;
      })(),
      error: "Large encoded payload found in production artifact: assets/index.js",
    },
    {
      name: "large media-like payloads split into 128-character bare base64 literals",
      file: "assets/index.js",
      content: referenceImageChunks(128),
      error: "Large encoded payload found in production artifact: assets/index.js",
    },
    {
      name: "small bare PNG literals",
      file: "assets/index.js",
      content: `"${VERSION}"; "${COMMIT_SHA}"; "./audio/voice-rms-processor.js"; "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";`,
      error: "Large encoded payload found in production artifact: assets/index.js",
    },
    {
      name: "temporary AWS credentials",
      file: "assets/index.js",
      content: `"${VERSION}"; "${COMMIT_SHA}"; "./audio/voice-rms-processor.js"; "ASIA${"A".repeat(16)}";`,
      error: "Possible secret found in production artifact: assets/index.js",
    },
    {
      name: "Slack bot credentials",
      file: "assets/index.js",
      content: `"${VERSION}"; "${COMMIT_SHA}"; "./audio/voice-rms-processor.js"; "xoxb-${"A".repeat(24)}";`,
      error: "Possible secret found in production artifact: assets/index.js",
    },
    {
      name: "Stripe live credentials",
      file: "assets/index.js",
      content: `"${VERSION}"; "${COMMIT_SHA}"; "./audio/voice-rms-processor.js"; "sk_live_${"A".repeat(24)}";`,
      error: "Possible secret found in production artifact: assets/index.js",
    },
    {
      name: "OpenAI project credentials",
      file: "assets/index.js",
      content: `"${VERSION}"; "${COMMIT_SHA}"; "./audio/voice-rms-processor.js"; "sk-proj-${"A".repeat(30)}";`,
      error: "Possible secret found in production artifact: assets/index.js",
    },
    {
      name: "root-absolute worklet URLs",
      file: "assets/index.js",
      content: `"${VERSION}"; "${COMMIT_SHA}"; "/audio/voice-rms-processor.js";`,
      error: "root-absolute AudioWorklet URL",
    },
    {
      name: "spaced root-absolute HTML attributes",
      file: "index.html",
      content:
        '<!doctype html><link href="./favicon.svg"><script src = "/assets/index.js"></script>\n',
      error: "Root-absolute URL is not Pages-subpath safe",
    },
  ]) {
    it(`rejects ${scenario.name}`, async () => {
      const root = await createFixture({
        [scenario.file]: scenario.content,
      });
      expect(runScript("seal-build.mjs", root).status).toBe(0);

      expect(runScript("inspect-build.mjs", root).stderr).toContain(scenario.error);
    });
  }

  it("rejects a PNG renamed to an allowed JavaScript asset", async () => {
    const root = await createFixture({
      "assets/index.js": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    });
    expect(runScript("seal-build.mjs", root).status).toBe(0);

    expect(runScript("inspect-build.mjs", root).stderr).toContain(
      "PNG content disguised as release text",
    );
  });
});

async function createFixture(overrides: Record<string, string | Buffer> = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "shouting-chickens-release-"));
  temporaryDirectories.push(root);
  const files: Record<string, string | Buffer> = {
    ".nojekyll": "GitHub Pages marker\n",
    "assets/shouting-chickens-atlas.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 80"></svg>\n',
    "audio/voice-rms-processor.js": 'registerProcessor("voice-rms-processor", class {});\n',
    "favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    "index.html":
      '<!doctype html><link href="./favicon.svg"><script src="./assets/index.js"></script>\n',
    "legal.css": "body { color: white; }\n",
    "privacy/index.html": '<a href="../">Back</a><a href="../release.json">Release</a>\n',
    "release.json": `${JSON.stringify({
      schemaVersion: 1,
      version: VERSION,
      commitSha: COMMIT_SHA,
    })}\n`,
    "support/index.html": '<a href="../">Back</a><a href="../release.json">Release</a>\n',
    "assets/index.js": `"${VERSION}"; "${COMMIT_SHA}"; "./audio/voice-rms-processor.js";\n`,
    ...overrides,
  };

  for (const [file, content] of Object.entries(files)) {
    const destination = resolve(root, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  return root;
}

function referenceImageChunks(chunkSize: number) {
  // Keep raw planning references out of the repository while exercising the
  // same chunk lengths and aggregate size as the known screenshot bypass.
  const encoded = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(80_000, 23),
  ]).toString("base64");
  const chunks = encoded.match(new RegExp(`.{1,${chunkSize}}`, "g")) ?? [];
  return `"${VERSION}"; "${COMMIT_SHA}"; "./audio/voice-rms-processor.js"; [${chunks
    .map((chunk) => JSON.stringify(chunk))
    .join(",")}].join("");`;
}

function runScript(script: string, releaseDirectory: string) {
  return spawnSync(process.execPath, [resolve(process.cwd(), "scripts", script)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      APP_VERSION: VERSION,
      CI: "",
      COMMIT_SHA,
      RELEASE_DIST_DIR: releaseDirectory,
    },
  });
}
