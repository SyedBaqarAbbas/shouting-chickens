import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";

import { normalizeDeploymentDirectoryUrl } from "../../scripts/deployment-url";

const expectedVersion = requireEnvironment("APP_VERSION");
const expectedCommit = requireEnvironment("COMMIT_SHA");
const expectedArtifactManifestSha = requireEnvironment("ARTIFACT_MANIFEST_SHA");

test("the deployed HTTPS artifact keeps identity, support pages, assets, and fallback play live", async ({
  browser,
  page,
  request,
}) => {
  const deploymentUrl = normalizeDeploymentDirectoryUrl(requireEnvironment("DEPLOY_URL"));
  expect(deploymentUrl.protocol).toBe("https:");
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(deploymentUrl.href, { waitUntil: "networkidle" });
  await expect(page.locator(".site-release")).toContainText(`Version ${expectedVersion}`);
  await expect(page.locator(".site-release abbr")).toHaveAttribute("title", expectedCommit);

  const releaseResponse = await request.get(new URL("release.json", deploymentUrl).href);
  expect(releaseResponse.ok()).toBe(true);
  expect(await releaseResponse.json()).toEqual({
    schemaVersion: 1,
    version: expectedVersion,
    commitSha: expectedCommit,
  });
  for (const relativeUrl of [
    "privacy/",
    "support/",
    "audio/voice-rms-processor.js",
    "manifest.webmanifest",
    "service-worker.js",
  ]) {
    const response = await request.get(new URL(relativeUrl, deploymentUrl).href);
    expect(response.ok(), relativeUrl).toBe(true);
  }

  const pwaResponse = await request.get(new URL("pwa-release.json", deploymentUrl).href);
  expect(pwaResponse.ok()).toBe(true);
  const pwaRelease = (await pwaResponse.json()) as {
    schemaVersion: number;
    version: string;
    commitSha: string;
    cacheName: string;
    assets: string[];
  };
  expect(pwaRelease).toMatchObject({
    schemaVersion: 1,
    version: expectedVersion,
    commitSha: expectedCommit,
  });
  expect(pwaRelease.cacheName).toContain(expectedCommit);
  expect(pwaRelease.assets).toContain("./manifest.webmanifest");
  expect(
    pwaRelease.assets.some((asset) =>
      /^(?:blob|data|https?):|(?:^|\/)(?:api|reports?|replays?|recordings?|media)(?:\/|$)/i.test(
        asset,
      ),
    ),
  ).toBe(false);
  const artifactResponse = await request.get(new URL("artifact-manifest.json", deploymentUrl).href);
  expect(artifactResponse.ok()).toBe(true);
  const artifactBytes = await artifactResponse.body();
  expect(sha256(artifactBytes)).toBe(expectedArtifactManifestSha);
  const artifact = JSON.parse(artifactBytes.toString("utf8")) as {
    schemaVersion: number;
    version: string;
    commitSha: string;
    files: { path: string; bytes: number; sha256: string }[];
  };
  expect(artifact).toMatchObject({
    schemaVersion: 1,
    version: expectedVersion,
    commitSha: expectedCommit,
  });
  expect(artifact.files.length).toBeGreaterThan(0);
  expect(new Set(artifact.files.map((entry) => entry.path)).size).toBe(artifact.files.length);
  // GitHub Pages consumes .nojekyll as a deployment control file and does not serve it.
  for (const entry of artifact.files.filter((entry) => entry.path !== ".nojekyll")) {
    const response = await request.get(new URL(entry.path, deploymentUrl).href);
    expect(response.ok(), entry.path).toBe(true);
    const bytes = await response.body();
    expect(bytes.byteLength, entry.path).toBe(entry.bytes);
    expect(sha256(bytes), entry.path).toBe(entry.sha256);
  }

  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expectInstallableInPersistentChromium(
    deploymentUrl.href,
    Boolean(test.info().project.use.ignoreHTTPSErrors),
  );

  const routingContext = await browser.newContext({
    ignoreHTTPSErrors: Boolean(test.info().project.use.ignoreHTTPSErrors),
    serviceWorkers: "block",
  });
  try {
    const routingPage = await routingContext.newPage();
    await routingPage.goto(new URL("flight/deep-link", deploymentUrl).href);
    await expect(routingPage).toHaveURL(deploymentUrl.href);
    await expect(routingPage.locator(".site-release")).toContainText(`Version ${expectedVersion}`);
  } finally {
    await routingContext.close();
  }

  await page.getByRole("button", { name: "Use keyboard or touch" }).click();
  await page.getByRole("button", { name: "Start run" }).click();
  const surface = page.getByTestId("game-surface");
  await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
  await expect(surface.locator("canvas")).toHaveCount(1);
  expect(errors).toEqual([]);
});

function requireEnvironment(
  name: "APP_VERSION" | "ARTIFACT_MANIFEST_SHA" | "COMMIT_SHA" | "DEPLOY_URL",
) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for post-deploy verification`);
  }
  return value;
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function expectInstallableInPersistentChromium(baseUrl: string, ignoreHTTPSErrors: boolean) {
  const profile = await mkdtemp(resolve(tmpdir(), "shouting-chickens-postdeploy-"));
  const context = await chromium.launchPersistentContext(profile, {
    args: ignoreHTTPSErrors ? ["--ignore-certificate-errors"] : undefined,
    headless: true,
    ignoreHTTPSErrors,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const cdp = await context.newCDPSession(page);
    const appManifest = await cdp.send("Page.getAppManifest");
    expect(appManifest.url).toBe(new URL("manifest.webmanifest", baseUrl).href);
    expect(appManifest.errors).toEqual([]);
    expect((await cdp.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { force: true, recursive: true });
  }
}
