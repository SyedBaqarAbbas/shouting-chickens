import { defineConfig, devices } from "@playwright/test";

import { normalizeDeploymentDirectoryUrl } from "./scripts/deployment-url";

const suite = process.env.E2E_SUITE ?? "development";
const productionPreview = process.env.E2E_MODE === "production";
const pagesBasePath = process.env.PAGES_BASE_PATH ?? "/shouting-chickens/";
const ignoreHttpsErrors = process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS === "1";
const localOrigin = "http://127.0.0.1:4173";
const soakDurationMs = Number(process.env.SOAK_DURATION_MS ?? 300_000);
const testDirectories: Record<string, string> = {
  development: "./tests/e2e",
  postdeploy: "./tests/postdeploy",
  pwa: "./tests/pwa",
  release: "./tests/release",
  soak: "./tests/soak",
};
const testDir = testDirectories[suite];

if (!testDir) {
  throw new Error(`Unknown E2E_SUITE: ${suite}`);
}
if (suite === "postdeploy" && !process.env.DEPLOY_URL) {
  throw new Error("DEPLOY_URL is required for the post-deploy suite");
}
if (
  suite === "soak" &&
  (!Number.isFinite(soakDurationMs) ||
    soakDurationMs <= 0 ||
    (process.env.CI && soakDurationMs < 300_000))
) {
  throw new Error("SOAK_DURATION_MS must be finite and at least 300000 in CI");
}

export default defineConfig({
  testDir,
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  fullyParallel: suite !== "soak",
  forbidOnly: Boolean(process.env.CI),
  retries: suite === "soak" || suite === "release" ? 0 : process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  timeout: suite === "soak" ? soakDurationMs + 60_000 : 30_000,
  workers: suite === "soak" || suite === "pwa" ? 1 : undefined,
  use: {
    baseURL:
      suite === "postdeploy"
        ? normalizeDeploymentDirectoryUrl(process.env.DEPLOY_URL!).href
        : productionPreview
          ? `${localOrigin}${pagesBasePath}`
          : localOrigin,
    ignoreHTTPSErrors: ignoreHttpsErrors,
    launchOptions: ignoreHttpsErrors ? { args: ["--ignore-certificate-errors"] } : undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer:
    suite === "postdeploy"
      ? undefined
      : {
          command: productionPreview
            ? "npm run preview:pages"
            : "npm run dev -- --host 127.0.0.1 --port 4173",
          env: {
            ...process.env,
            HOST: "127.0.0.1",
            PAGES_BASE_PATH: pagesBasePath,
            PORT: "4173",
          },
          url: productionPreview ? `${localOrigin}${pagesBasePath}` : localOrigin,
          reuseExistingServer: !process.env.CI && !productionPreview,
        },
});
