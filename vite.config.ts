import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

type PackageMetadata = {
  version: string;
};

const packageMetadata = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as PackageMetadata;
const appVersion = process.env.APP_VERSION?.trim() || packageMetadata.version;
const commitSha = process.env.COMMIT_SHA?.trim() || "development";

export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __COMMIT_SHA__: JSON.stringify(commitSha),
  },
  plugins: [
    react(),
    {
      name: "release-manifest",
      generateBundle() {
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
      },
    },
  ],
  test: {
    environment: "jsdom",
    exclude: [
      "tests/e2e/**",
      "tests/postdeploy/**",
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
