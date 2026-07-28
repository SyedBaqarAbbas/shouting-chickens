export const PWA_RELEASE_FILE = "pwa-release.json";
export const SERVICE_WORKER_FILE = "service-worker.js";
export const PAGES_FALLBACK_FILE = "404.html";

export const PWA_PUBLIC_SOURCES = Object.freeze([
  "assets/shouting-chickens-atlas.svg",
  "audio/voice-rms-processor.js",
  "favicon.svg",
  "icons/app-icon-180.png",
  "icons/app-icon-192.png",
  "icons/app-icon-512.png",
  "icons/app-icon-maskable-512.png",
  "legal.css",
  "manifest.webmanifest",
  "privacy/index.html",
  "support/index.html",
]);

const FORBIDDEN_CACHE_PATH =
  /(?:^|\/)(?:api|graphql|reports?|replays?|recordings?|captures?|media|uploads?|test-results|playwright-report)(?:\/|$)/i;
const FORBIDDEN_CACHE_EXTENSION =
  /\.(?:aac|avi|blob|csv|flac|gif|jpeg|jpg|m4a|mov|mp3|mp4|ogg|pdf|trace|tsv|wav|webm|zip)$/i;

export type PwaReleaseManifest = {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly commitSha: string;
  readonly cacheName: string;
  readonly assets: readonly string[];
};

export function createPwaReleaseManifest(
  bundleFiles: Iterable<string>,
  version: string,
  commitSha: string,
): PwaReleaseManifest {
  const bundledSources = [...bundleFiles].filter(
    (file) => file === "index.html" || /^assets\/[0-9A-Za-z_-]+\.(?:css|js)$/.test(file),
  );
  const files = new Set([
    ...bundledSources,
    ...PWA_PUBLIC_SOURCES,
    "index.html",
    PWA_RELEASE_FILE,
    "release.json",
  ]);
  const assets = ["./", ...[...files].sort(codeUnitCompare).map((file) => `./${file}`)];

  for (const asset of assets) {
    assertCacheableAsset(asset);
  }

  return Object.freeze({
    schemaVersion: 1,
    version,
    commitSha,
    cacheName: `shouting-chickens-shell-${safeIdentity(version)}-${safeIdentity(commitSha)}`,
    assets: Object.freeze(assets),
  });
}

export function assertCacheableAsset(asset: string) {
  if (
    asset !== "./" &&
    (!asset.startsWith("./") ||
      asset.includes("\\") ||
      asset.includes("?") ||
      asset.includes("#") ||
      asset.includes(".."))
  ) {
    throw new Error(`PWA precache entry must be a project-relative path: ${asset}`);
  }
  const path = asset === "./" ? "" : asset.slice(2);
  if (
    FORBIDDEN_CACHE_PATH.test(path) ||
    FORBIDDEN_CACHE_EXTENSION.test(path) ||
    /^(?:blob|data|https?):/i.test(asset)
  ) {
    throw new Error(`PWA precache entry is not an application source asset: ${asset}`);
  }
}

export function renderServiceWorker(manifest: PwaReleaseManifest) {
  const releaseId = `${manifest.version}:${manifest.commitSha}`;
  return `/* Generated from the sealed source release. Do not edit. */
"use strict";

const RELEASE_ID = ${JSON.stringify(releaseId)};
const CACHE_NAME = ${JSON.stringify(manifest.cacheName)};
const CACHE_PREFIX = "shouting-chickens-shell-";
const PRECACHE_URLS = ${JSON.stringify(manifest.assets, null, 2)};

self.addEventListener("install", (event) => {
  event.waitUntil(installRelease());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "APPLY_UPDATE") {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (
    request.method !== "GET" ||
    url.origin !== scope.origin ||
    !url.pathname.startsWith(scope.pathname) ||
    isExcludedRequest(url)
  ) {
    return;
  }

  const canonicalUrl = new URL(url.pathname + url.search, scope.origin);
  const directoryIndexUrl =
    request.mode === "navigate" && url.pathname.endsWith("/")
      ? new URL(url.pathname + "index.html", scope.origin)
      : null;
  const matchedAsset = PRECACHE_URLS.find(
    (asset) =>
      new URL(asset, scope).href === canonicalUrl.href ||
      (directoryIndexUrl && new URL(asset, scope).href === directoryIndexUrl.href),
  );
  if (matchedAsset) {
    const cacheKey = new Request(new URL(matchedAsset, scope), {
      credentials: "same-origin",
      headers: request.headers,
      method: "GET",
    });
    event.respondWith(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.match(cacheKey))
        .then((response) => response || fetch(request)),
    );
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.match(new Request(new URL("./index.html", scope))))
        .then((response) => response || fetch(request)),
    );
  }
});

async function installRelease() {
  const cache = await caches.open(CACHE_NAME);
  try {
    for (const asset of PRECACHE_URLS) {
      const canonical = new Request(new URL(asset, self.registration.scope), {
        credentials: "same-origin",
      });
      const source = new URL(canonical.url);
      source.searchParams.set("__sc_release", RELEASE_ID);
      const response = await fetch(source, { cache: "reload", credentials: "same-origin" });
      if (!response.ok || response.type === "opaque") {
        throw new Error("Could not precache " + asset + " (" + response.status + ")");
      }
      await cache.put(canonical, response);
    }
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

function isExcludedRequest(url) {
  const scope = new URL(self.registration.scope);
  const path = url.pathname.slice(scope.pathname.length).toLowerCase();
  return (
    /(?:^|\\/)(?:api|graphql|reports?|replays?|recordings?|captures?|media|uploads?)(?:\\/|$)/.test(path) ||
    /\\.(?:aac|avi|blob|csv|flac|gif|jpeg|jpg|m4a|mov|mp3|mp4|ogg|pdf|trace|tsv|wav|webm|zip)$/.test(path)
  );
}
`;
}

export function renderPagesFallback(basePath: string) {
  const normalizedBasePath = normalizePagesBasePath(basePath);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="robots" content="noindex" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Opening Shouting Chickens…</title>
  </head>
  <body>
    <p>Opening <a href="${normalizedBasePath}">Shouting Chickens</a>…</p>
    <script>
      location.replace(${JSON.stringify(normalizedBasePath)});
    </script>
  </body>
</html>
`;
}

export function injectPagesBase(html: string, basePath: string) {
  const normalizedBasePath = normalizePagesBasePath(basePath);
  if (!html.includes("<head>")) {
    throw new Error("PWA entry document is missing a <head> element");
  }
  return html.replace("<head>", `<head>\n    <base href="${normalizedBasePath}" />`);
}

export function normalizePagesBasePath(value: string | undefined) {
  const candidate = value?.trim() || "/shouting-chickens/";
  const withLeadingSlash = candidate.startsWith("/") ? candidate : `/${candidate}`;
  const normalized = withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
  const segments = normalized.split("/").filter(Boolean);
  if (
    !/^\/(?:[0-9A-Za-z._~-]+\/)*$/.test(normalized) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid GitHub Pages base path: ${candidate}`);
  }
  return normalized;
}

function safeIdentity(value: string) {
  return value.replace(/[^0-9A-Za-z.-]/g, "-");
}

function codeUnitCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
