import { expect, test, type Page, type Response } from "@playwright/test";

import {
  installSyntheticMedia,
  setSyntheticDbfs,
  setSyntheticMicrophoneMode,
  setSyntheticVisibility,
  syntheticMediaSnapshot,
} from "./media-harness";

const expectedVersion = process.env.APP_VERSION ?? "0.1.0";
const expectedCommit = process.env.COMMIT_SHA ?? "development";

test("the sealed Pages-subpath artifact exposes release, privacy, and support identity", async ({
  page,
  request,
}) => {
  const failedResponses: { status: number; url: string }[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedResponses.push({ status: response.status(), url: response.url() });
    }
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");

  const release = page.locator(".site-release");
  await expect(release).toContainText(`Version ${expectedVersion}`);
  await expect(release).toContainText(`build ${shortCommit(expectedCommit)}`);
  await expect(release.locator("abbr")).toHaveAttribute("title", expectedCommit);

  const releaseResponse = await request.get(new URL("release.json", page.url()).href);
  expect(releaseResponse.ok()).toBe(true);
  expect(await releaseResponse.json()).toEqual({
    schemaVersion: 1,
    version: expectedVersion,
    commitSha: expectedCommit,
  });

  await page.getByRole("link", { name: "Privacy" }).click();
  await expect(page).toHaveURL(/\/shouting-chickens\/privacy\/$/);
  await expect(page.getByRole("heading", { name: "Privacy" })).toBeVisible();
  await expect(page.getByText(/does not perform speech recognition/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Release identity" })).toHaveAttribute(
    "href",
    "../release.json",
  );

  await page.getByRole("link", { name: "Back to Shouting Chickens" }).click();
  await expect(page).toHaveURL(/\/shouting-chickens\/$/);
  await page.getByRole("link", { name: "Support" }).click();
  await expect(page).toHaveURL(/\/shouting-chickens\/support\/$/);
  await expect(page.getByRole("heading", { name: "Support" })).toBeVisible();
  await expect(page.getByText(/not yet installable/i)).toBeVisible();

  expect(failedResponses).toEqual([]);
});

test("real media adapters calibrate voice, drive jump and lift, recover, collide, score, and restart", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await installSyntheticMedia(page, { camera: "deny", microphone: "allow" });
  const workletResponses: Response[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith("/audio/voice-rms-processor.js")) {
      workletResponses.push(response);
    }
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");
  await page.getByRole("button", { name: "Enable microphone" }).click();
  await expect(
    page.getByRole("heading", { name: "Calibrate your comfortable range" }),
  ).toBeFocused();
  await completeValidCalibration(page);

  await expect(page.getByRole("heading", { name: "Ready to run" })).toBeFocused();
  await setSyntheticDbfs(page, -60);
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByRole("heading", { name: "Get ready" })).toBeFocused();
  await expect(page.locator("output.countdown-number")).toHaveText("3");
  const surface = page.getByTestId("game-surface");
  await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
  await expect(surface).toHaveAttribute("data-configured-input", "voice");
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
  await expect(surface).toHaveAttribute("data-player-grounded", "true");
  await expect.poll(() => numericAttribute(surface, "data-input-level")).toBeLessThan(0.15);
  await expect(surface).toHaveAttribute("data-supporting-platform", /.+/);
  const stableResources = await runtimeResources(surface);
  const initialRunGeneration = await numericAttribute(surface, "data-run-generation");
  const initialRestartToken = await numericAttribute(surface, "data-restart-token");

  expect((await syntheticMediaSnapshot(page)).cameraRequests).toBe(0);
  await page.getByRole("button", { name: "Camera off · Enable" }).click();
  await expect(page.locator("#camera-status")).toContainText("permission was denied");
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
  await expect(surface).toHaveAttribute("data-configured-input", "voice");

  const harness = await syntheticMediaSnapshot(page);
  expect(harness.microphoneRequests).toBe(1);
  expect(harness.cameraRequests).toBe(1);
  expect(harness.workletUrls.length).toBeGreaterThan(0);
  for (const url of harness.workletUrls) {
    expect(new URL(url).pathname).toBe("/shouting-chickens/audio/voice-rms-processor.js");
  }
  expect(workletResponses.length).toBeGreaterThan(0);
  expect(workletResponses.every((response) => response.status() === 200)).toBe(true);

  const groundedY = Number(await surface.getAttribute("data-player-y"));
  await setSyntheticDbfs(page, -10);
  await expect.poll(() => numericAttribute(surface, "data-input-level")).toBeGreaterThan(0.8);
  await expect(surface).toHaveAttribute("data-active-input", "voice");
  await expect(surface).toHaveAttribute("data-player-grounded", "false");
  await expect.poll(() => numericAttribute(surface, "data-player-y")).toBeLessThan(groundedY - 5);
  await expect(surface).toHaveAttribute("data-player-animation", "flap");
  await expect.poll(() => numericAttribute(surface, "data-applied-lift")).toBeGreaterThan(0.8);
  const heldAcceleration = await numericAttribute(surface, "data-control-acceleration-y");
  expect(await numericAttribute(surface, "data-input-level")).toBeGreaterThan(0.8);
  await setSyntheticDbfs(page, -60);
  await expect.poll(() => numericAttribute(surface, "data-input-level")).toBeLessThan(0.15);
  await expect.poll(() => numericAttribute(surface, "data-applied-lift")).toBeLessThan(0.15);
  const releasedAcceleration = await numericAttribute(surface, "data-control-acceleration-y");
  expect(heldAcceleration).toBeGreaterThan(0);
  expect(releasedAcceleration).toBeGreaterThan(heldAcceleration + 500);

  await setSyntheticVisibility(page, "hidden");
  await expect(surface).toHaveAttribute("data-simulation-phase", "paused");
  await setSyntheticVisibility(page, "visible");
  await page.getByRole("button", { name: "Resume microphone" }).click();
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByText("Rotate your device to play")).toBeVisible();
  await expect(surface).toHaveAttribute("data-simulation-phase", "paused");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("Rotate your device to play")).toBeHidden();
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");

  await expect(page.getByRole("heading", { name: "Nice flight" })).toBeFocused({
    timeout: 25_000,
  });
  await expect(surface).toHaveAttribute("data-simulation-phase", "dead");
  const elapsedMs = await numericAttribute(surface, "data-elapsed-ms");
  const score = await numericAttribute(surface, "data-score");
  const survivalScore = await numericAttribute(surface, "data-survival-score");
  const collectibleScore = await numericAttribute(surface, "data-collectible-score");
  const precisionScore = await numericAttribute(surface, "data-precision-score");
  expect(elapsedMs).toBeGreaterThan(0);
  expect(score).toBeGreaterThan(0);
  expect(survivalScore).toBe(Math.floor(elapsedMs / 100));
  expect(score).toBe(survivalScore + collectibleScore + precisionScore);
  expect(["water", "fall", "hazard"]).toContain(await surface.getAttribute("data-death-reason"));

  await page.getByRole("button", { name: "Restart run" }).click();
  await expect(surface).toHaveAttribute("data-restart-token", String(initialRestartToken + 1));
  await expect(surface).toHaveAttribute("data-run-generation", String(initialRunGeneration + 1));
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
  expect(await runtimeResources(surface)).toEqual(stableResources);
});

test("permission denial falls back to a playable keyboard and touch run", async ({ page }) => {
  test.setTimeout(30_000);
  await installSyntheticMedia(page, { camera: "deny", microphone: "deny" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");

  await page.getByRole("button", { name: "Enable microphone" }).click();
  await expect(page.getByRole("alert")).toContainText("permission was denied");
  await page.getByRole("button", { name: "Use keyboard or touch" }).click();
  await expect(page.getByRole("heading", { name: "Ready to run" })).toBeFocused();

  await page.getByRole("button", { name: "Start run" }).click();
  const surface = page.getByTestId("game-surface");
  await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
  await expect(surface).toHaveAttribute("data-configured-input", "keyboard-touch");
  await page.keyboard.down("Space");
  await expect(surface).toHaveAttribute("data-active-input", "keyboard-touch");
  await expect.poll(() => numericAttribute(surface, "data-input-level")).toBeGreaterThan(0.9);
  await page.keyboard.up("Space");
  await expect(surface).toHaveAttribute("data-player-grounded", "false");
});

test("permission retry and invalid calibration recover into a valid voice run", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await installSyntheticMedia(page, { camera: "deny", microphone: "deny" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");

  await page.getByRole("button", { name: "Enable microphone" }).click();
  await expect(page.getByRole("alert")).toContainText("permission was denied");
  await setSyntheticMicrophoneMode(page, "allow");
  await page.getByRole("button", { name: "Try microphone again" }).click();
  await expect(
    page.getByRole("heading", { name: "Calibrate your comfortable range" }),
  ).toBeFocused();

  await setSyntheticDbfs(page, -40);
  await page.getByRole("button", { name: "Capture quiet" }).click();
  await expect(page.getByRole("button", { name: "Next: comfortable voice" })).toBeEnabled();
  await setSyntheticDbfs(page, -39);
  await page.getByRole("button", { name: "Next: comfortable voice" }).click();
  await expect(page.getByRole("alert")).toContainText(/too close/i);
  await setSyntheticDbfs(page, -20);
  await page.getByRole("button", { name: "Retry comfortable voice" }).click();
  await expect(page.getByRole("button", { name: "Next: strong voice" })).toBeEnabled();
  await setSyntheticDbfs(page, -5);
  await page.getByRole("button", { name: "Next: strong voice" }).click();
  await expect(page.getByRole("button", { name: "Use this calibration" })).toBeEnabled();
  await page.getByRole("button", { name: "Use this calibration" }).click();
  await expect(page.getByRole("heading", { name: "Ready to run" })).toBeFocused();

  await page.getByRole("button", { name: "Start run" }).click();
  const surface = page.getByTestId("game-surface");
  await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
  await expect(surface).toHaveAttribute("data-configured-input", "voice");
});

async function completeValidCalibration(page: Page) {
  for (const [buttonName, nextName, dbfs] of [
    ["Capture quiet", "Next: comfortable voice", -60],
    ["Next: comfortable voice", "Next: strong voice", -30],
    ["Next: strong voice", null, -10],
  ] as const) {
    await setSyntheticDbfs(page, dbfs);
    await page.getByRole("button", { name: buttonName }).click();
    if (nextName) {
      await expect(page.getByRole("button", { name: nextName })).toBeEnabled();
    }
    if (buttonName === "Next: comfortable voice") {
      await expect(page.getByText(/Playback is unavailable here/)).toBeVisible();
    }
  }
  await expect(page.getByRole("button", { name: "Use this calibration" })).toBeEnabled();
  await page.getByRole("button", { name: "Use this calibration" }).click();
}

async function numericAttribute(locator: ReturnType<Page["locator"]>, attribute: string) {
  const value = await requiredAttribute(locator, attribute);
  const numericValue = Number(value);
  expect(Number.isFinite(numericValue), `${attribute} must be a finite number`).toBe(true);
  return numericValue;
}

async function runtimeResources(surface: ReturnType<Page["locator"]>) {
  return {
    activeBodies: await requiredAttribute(surface, "data-active-bodies"),
    activeTimers: await requiredAttribute(surface, "data-active-timers"),
    collisionZones: await requiredAttribute(surface, "data-collision-zones"),
    inputListeners: await requiredAttribute(surface, "data-input-listeners"),
    pooledObjects: await requiredAttribute(surface, "data-pooled-objects"),
    sceneObjects: await requiredAttribute(surface, "data-scene-objects"),
  };
}

async function requiredAttribute(locator: ReturnType<Page["locator"]>, attribute: string) {
  const value = await locator.getAttribute(attribute);
  expect(value, `${attribute} must be present`).not.toBeNull();
  return value!;
}

function shortCommit(commitSha: string) {
  return commitSha === "development" ? commitSha : commitSha.slice(0, 7);
}
