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

  it("accepts a sealed, installable, Pages-relative PWA artifact", async () => {
    const root = await createFixture();
    expect(runScript("seal-build.mjs", root).status).toBe(0);

    const inspection = runScript("inspect-build.mjs", root);
    expect(inspection.status, inspection.stderr).toBe(0);
    expect(inspection.stdout).toContain(`Inspected 18 production files for ${VERSION}`);
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

  it("rejects a replay added to the PWA precache", async () => {
    const release = pwaRelease();
    const root = await createFixture({
      "pwa-release.json": `${JSON.stringify({
        ...release,
        assets: [...release.assets, "./replays/run.json"],
      })}\n`,
    });
    expect(runScript("seal-build.mjs", root).status).toBe(0);

    expect(runScript("inspect-build.mjs", root).stderr).toContain(
      "PWA precache entry is not an application source asset: ./replays/run.json",
    );
  });

  it("rejects an incorrectly sized install icon", async () => {
    const root = await createFixture({
      "icons/app-icon-192.png": pngHeader(191),
    });
    expect(runScript("seal-build.mjs", root).status).toBe(0);

    expect(runScript("inspect-build.mjs", root).stderr).toContain(
      "icons/app-icon-192.png must be an exact 192x192 PNG app icon",
    );
  });

  it("rejects a manifest without the maskable install icon", async () => {
    const manifest = installManifest();
    const root = await createFixture({
      "manifest.webmanifest": `${JSON.stringify({
        ...manifest,
        icons: manifest.icons.filter((icon) => icon.purpose !== "maskable"),
      })}\n`,
    });
    expect(runScript("seal-build.mjs", root).status).toBe(0);

    expect(runScript("inspect-build.mjs", root).stderr).toContain(
      "manifest.webmanifest is missing installable icon ./icons/app-icon-maskable-512.png (maskable)",
    );
  });

  it("rejects unapproved install icons outside the sealed application shell", async () => {
    const manifest = installManifest();
    const root = await createFixture({
      "manifest.webmanifest": `${JSON.stringify({
        ...manifest,
        icons: [
          ...manifest.icons,
          {
            src: "https://example.test/unsealed.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
        ],
      })}\n`,
    });
    expect(runScript("seal-build.mjs", root).status).toBe(0);

    expect(runScript("inspect-build.mjs", root).stderr).toContain(
      "manifest.webmanifest must enumerate only the approved install icons",
    );
  });

  it("rejects a worker that can activate without the explicit update message", async () => {
    const root = await createFixture({
      "service-worker.js": "self.skipWaiting(); cache.put();\n",
    });
    expect(runScript("seal-build.mjs", root).status).toBe(0);

    expect(runScript("inspect-build.mjs", root).stderr).toContain(
      "service-worker.js does not embed the exact PWA release identity and source shell",
    );
  });
});

async function createFixture(overrides: Record<string, string | Buffer> = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "shouting-chickens-release-"));
  temporaryDirectories.push(root);
  const files: Record<string, string | Buffer> = {
    ".nojekyll": "GitHub Pages marker\n",
    "404.html":
      '<!doctype html><a href="/shouting-chickens/">Open</a><script>location.replace("/shouting-chickens/")</script>\n',
    "audio/voice-rms-processor.js": 'registerProcessor("voice-rms-processor", class {});\n',
    "favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    "icons/app-icon-180.png": pngHeader(180),
    "icons/app-icon-192.png": pngHeader(192),
    "icons/app-icon-512.png": pngHeader(512),
    "icons/app-icon-maskable-512.png": pngHeader(512),
    "index.html":
      '<!doctype html><base href="/shouting-chickens/" /><meta name="theme-color"><link rel="manifest" href="./manifest.webmanifest"><link rel="apple-touch-icon" sizes="180x180" href="./icons/app-icon-180.png"><link href="./favicon.svg"><script src="./assets/index.js"></script>\n',
    "legal.css": "body { color: white; }\n",
    "manifest.webmanifest": `${JSON.stringify(installManifest())}\n`,
    "privacy/index.html": '<a href="../">Back</a><a href="../release.json">Release</a>\n',
    "pwa-release.json": `${JSON.stringify(pwaRelease())}\n`,
    "release.json": `${JSON.stringify({
      schemaVersion: 1,
      version: VERSION,
      commitSha: COMMIT_SHA,
    })}\n`,
    "service-worker.js": fixtureServiceWorker(),
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

function installManifest() {
  return {
    id: "./",
    name: "Shouting Chickens",
    short_name: "Chickens",
    description: "A local voice-controlled game.",
    lang: "en",
    dir: "ltr",
    start_url: "./",
    scope: "./",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#081426",
    theme_color: "#081426",
    categories: ["games"],
    icons: [
      {
        src: "./icons/app-icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "./icons/app-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "./icons/app-icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

function pwaRelease() {
  const assets = [
    "assets/index.js",
    "audio/voice-rms-processor.js",
    "favicon.svg",
    "icons/app-icon-180.png",
    "icons/app-icon-192.png",
    "icons/app-icon-512.png",
    "icons/app-icon-maskable-512.png",
    "index.html",
    "legal.css",
    "manifest.webmanifest",
    "privacy/index.html",
    "pwa-release.json",
    "release.json",
    "support/index.html",
  ]
    .sort()
    .map((file) => `./${file}`);
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    cacheName: `shouting-chickens-shell-${VERSION}-${COMMIT_SHA}`,
    assets: ["./", ...assets],
  };
}

function fixtureServiceWorker() {
  const release = pwaRelease();
  return `const RELEASE_ID = ${JSON.stringify(`${VERSION}:${COMMIT_SHA}`)};
const CACHE_NAME = ${JSON.stringify(release.cacheName)};
const PRECACHE_URLS = ${JSON.stringify(release.assets, null, 2)};
if (event.data.type === "APPLY_UPDATE") self.skipWaiting();
cache.put(request, response);
`;
}

function pngHeader(size: number) {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(size, 16);
  bytes.writeUInt32BE(size, 20);
  return bytes;
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
