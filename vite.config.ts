import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

import {
  PAGES_FALLBACK_FILE,
  PWA_RELEASE_FILE,
  SERVICE_WORKER_FILE,
  createPwaReleaseManifest,
  injectPagesBase,
  normalizePagesBasePath,
  renderPagesFallback,
  renderServiceWorker,
} from "./scripts/pwa-build";

type PackageMetadata = {
  version: string;
};

const packageMetadata = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as PackageMetadata;
const appVersion = process.env.APP_VERSION?.trim() || packageMetadata.version;
const commitSha = process.env.COMMIT_SHA?.trim() || "development";
const pagesBasePath = normalizePagesBasePath(process.env.PAGES_BASE_PATH);

export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __COMMIT_SHA__: JSON.stringify(commitSha),
  },
  plugins: [
    react(),
    {
      name: "pages-document-base",
      apply: "build",
      transformIndexHtml(html) {
        return injectPagesBase(html, pagesBasePath);
      },
    },
    {
      name: "sealed-pwa-release",
      generateBundle(_options, bundle) {
        this.emitFile({
          type: "asset",
          fileName: "release.json",
          source: `${JSON.stringify(
            {
              schemaVersion: 1,
              version: appVersion,
              commitSha,
            },
            null,
            2,
          )}\n`,
        });
        const pwaRelease = createPwaReleaseManifest(
          [...Object.keys(bundle), "release.json", PWA_RELEASE_FILE],
          appVersion,
          commitSha,
        );
        this.emitFile({
          type: "asset",
          fileName: PWA_RELEASE_FILE,
          source: `${JSON.stringify(pwaRelease, null, 2)}\n`,
        });
        this.emitFile({
          type: "asset",
          fileName: SERVICE_WORKER_FILE,
          source: renderServiceWorker(pwaRelease),
        });
        this.emitFile({
          type: "asset",
          fileName: PAGES_FALLBACK_FILE,
          source: renderPagesFallback(pagesBasePath),
        });
      },
    },
  ],
  test: {
    environment: "jsdom",
    exclude: [
      "tests/e2e/**",
      "tests/postdeploy/**",
      "tests/pwa/**",
      "tests/release/**",
      "tests/soak/**",
      "node_modules/**",
      "dist/**",
    ],
    setupFiles: "./src/test/setup.ts",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
