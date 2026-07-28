import { describe, expect, it } from "vitest";

import {
  assertCacheableAsset,
  createPwaReleaseManifest,
  injectPagesBase,
  normalizePagesBasePath,
  renderPagesFallback,
  renderServiceWorker,
} from "./pwa-build";

describe("PWA release generation", () => {
  it("creates a deterministic, release-specific source-only precache", () => {
    const release = createPwaReleaseManifest(
      ["assets/z.js", "assets/a.css", "index.html"],
      "1.2.3",
      "a".repeat(40),
    );

    expect(release.cacheName).toBe(`shouting-chickens-shell-1.2.3-${"a".repeat(40)}`);
    expect(release.assets[0]).toBe("./");
    expect(release.assets).toContain("./assets/a.css");
    expect(release.assets).toContain("./audio/voice-rms-processor.js");
    expect(release.assets).toContain("./manifest.webmanifest");
    expect(release.assets).not.toContain("./artifact-manifest.json");
    expect(release.assets).not.toContain("./service-worker.js");
    expect(new Set(release.assets).size).toBe(release.assets.length);
    expect(release.assets.slice(1)).toEqual([...release.assets.slice(1)].sort());
  });

  it.each([
    "https://example.test/app.js",
    "blob:https://example.test/id",
    "./api/session",
    "./graphql",
    "./replays/run.json",
    "./reports/a.csv",
    "./media/voice.wav",
    "./assets/../secret.txt",
    "/root.js",
  ])("rejects non-source precache entry %s", (asset) => {
    expect(() => assertCacheableAsset(asset)).toThrow(/PWA precache entry/);
  });

  it("renders a waiting service worker with explicit activation and no runtime cache writes", () => {
    const release = createPwaReleaseManifest(["assets/index.js"], "1.2.3", "abc1234");
    const worker = renderServiceWorker(release);

    expect(worker).toContain('event.data.type === "APPLY_UPDATE"');
    expect(worker).toContain("self.skipWaiting()");
    expect(worker).not.toContain('skipWaiting();\n});\n\nself.addEventListener("activate"');
    expect(worker.match(/cache\.put/g)).toHaveLength(1);
    expect(worker).toContain("url.origin !== scope.origin");
    expect(worker).toContain("isExcludedRequest(url)");
    expect(worker).toContain(JSON.stringify("./assets/index.js"));
  });

  it("normalizes and emits a Pages direct-reload fallback", () => {
    expect(normalizePagesBasePath("shouting-chickens")).toBe("/shouting-chickens/");
    const fallback = renderPagesFallback("/shouting-chickens/");
    expect(fallback).toContain('location.replace("/shouting-chickens/")');
    expect(fallback).toContain('href="/shouting-chickens/"');
  });

  it("injects a configurable absolute document base for preserved deep-link shells", () => {
    expect(injectPagesBase("<html><head></head></html>", "/games/chickens")).toContain(
      '<base href="/games/chickens/" />',
    );
    expect(injectPagesBase("<html><head></head></html>", "/")).toContain('<base href="/" />');
  });

  it.each([
    "/shouting-chickens/?preview=true",
    "/shouting-chickens/#fragment",
    "/shouting-chickens/<script>/",
    "/../shouting-chickens/",
    "/./shouting-chickens/",
    String.raw`\\shouting-chickens\\`,
  ])("rejects an unsafe Pages base path %s", (basePath) => {
    expect(() => normalizePagesBasePath(basePath)).toThrow(/Invalid GitHub Pages base path/);
  });
});
