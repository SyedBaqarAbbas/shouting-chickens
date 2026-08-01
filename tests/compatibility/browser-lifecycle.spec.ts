import { expect, test } from "@playwright/test";

import {
  installSyntheticMedia,
  setSyntheticVisibility,
  syntheticMediaSnapshot,
} from "../release/media-harness";

test.beforeEach(async ({ page }) => {
  await installSyntheticMedia(page, { camera: "allow", microphone: "allow" });
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("runs, latches background pause, and reports bounded local diagnostics", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    runtimeErrors.push(error.message);
  });

  await page.goto("./");
  await page.getByRole("button", { name: "Use keyboard or touch" }).click();
  await page.getByRole("button", { name: "Start run" }).click();

  const surface = page.getByTestId("game-surface");
  await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
  await expect(surface.locator("canvas")).toHaveCount(1);

  await setSyntheticVisibility(page, "hidden");
  await expect(surface).toHaveAttribute("data-simulation-phase", "paused");
  const frozenTick = await numericAttribute(surface, "data-simulation-tick");
  await page.waitForTimeout(250);
  expect(await numericAttribute(surface, "data-simulation-tick")).toBe(frozenTick);

  await setSyntheticVisibility(page, "visible");
  await expect(page.getByRole("dialog", { name: "Welcome back" })).toBeVisible();
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  expect(await numericAttribute(surface, "data-simulation-tick")).toBe(frozenTick);

  await page.getByRole("button", { name: "Resume run" }).click();
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
  await surface.click({ position: { x: 216, y: 500 } });
  await expect
    .poll(async () => performanceDiagnostics(surface).then((value) => value.inputSamples))
    .toBeGreaterThan(0);

  const performance = await performanceDiagnostics(surface);
  expect(performance.inputToIntentP95Ms).toBeLessThanOrEqual(100);
  expect(performance.frameSamples).toBeGreaterThan(0);

  const diagnostics = await surface.evaluate((element) => {
    const raw = element.getAttribute("data-local-diagnostics");
    if (!raw) {
      throw new Error("Missing local diagnostics");
    }
    return JSON.parse(raw) as Record<string, unknown>;
  });
  expect(diagnostics).toMatchObject({
    schemaVersion: 1,
    run: {
      gameplayVersion: "sho-17-progression-v1",
      seed: "authored-launch",
    },
  });
  expectExactKeys(diagnostics, [
    "capabilities",
    "performance",
    "release",
    "renderer",
    "resources",
    "run",
    "schemaVersion",
  ]);
  expectExactKeys(diagnostics.capabilities, ["gameAudio", "phaserMounted"]);
  expectExactKeys(diagnostics.performance, [
    "frameBudgetMet",
    "frameOverBudgetRatio",
    "frameP50Ms",
    "frameP95Ms",
    "frameSamples",
    "inputBudgetMet",
    "inputSamples",
    "inputToIntentP95Ms",
    "voiceInputBudgetMet",
    "voiceInputSamples",
    "voiceInputToIntentP95Ms",
  ]);
  expectExactKeys(diagnostics.release, ["commit", "version"]);
  expectExactKeys(diagnostics.resources, [
    "activeBodies",
    "activeParticles",
    "activeTimers",
    "audioActiveVoices",
    "audioGraphNodes",
    "eventListeners",
    "inputListeners",
    "pooledObjects",
    "retainedCollectibleIds",
    "retainedCollisionIds",
    "retainedObstacleIds",
    "retainedPrecisionLandingIds",
    "sceneObjects",
  ]);
  expectExactKeys(diagnostics.run, ["gameplayVersion", "seed"]);
  expect(JSON.stringify(diagnostics)).not.toMatch(
    /dbfs|deviceId|normalizedInput|normalizedLevel|peak|raw|rms/i,
  );

  const media = await page.locator(".experience-root").evaluate((element) => {
    const raw = element.getAttribute("data-media-diagnostics");
    if (!raw) {
      throw new Error("Missing media diagnostics");
    }
    return JSON.parse(raw) as {
      resources: {
        activeAudioNodes: number;
        activeTracks: number;
        pendingAudioContexts: number;
      };
    };
  });
  expect(media.resources).toMatchObject({
    activeAudioNodes: 0,
    activeTracks: 0,
    pendingAudioContexts: 0,
  });
  expectExactKeys(media, ["capabilities", "resources", "schemaVersion"]);
  expectExactKeys((media as unknown as Record<string, unknown>).capabilities, [
    "audioContext",
    "audioWorklet",
    "camera",
    "deviceEnumeration",
    "microphone",
  ]);
  expectExactKeys(media.resources, [
    "activeAudioNodes",
    "activeCameraTracks",
    "activeMicrophoneTracks",
    "activeTracks",
    "lifecycleListeners",
    "pendingAudioContexts",
    "sessionSubscribers",
    "trackListeners",
  ]);
  expect((await syntheticMediaSnapshot(page)).audioResumeUserActivation.length).toBeGreaterThan(0);
  expect(runtimeErrors).toEqual([]);
});

async function numericAttribute(
  locator: import("@playwright/test").Locator,
  name: string,
): Promise<number> {
  const raw = await locator.getAttribute(name);
  expect(raw, name).not.toBeNull();
  const value = Number(raw);
  expect(Number.isFinite(value), `${name}: ${raw}`).toBe(true);
  return value;
}

async function performanceDiagnostics(locator: import("@playwright/test").Locator) {
  return locator.evaluate((element) => {
    const raw = element.getAttribute("data-performance-diagnostics");
    if (!raw) {
      throw new Error("Missing performance diagnostics");
    }
    return JSON.parse(raw) as {
      frameSamples: number;
      inputSamples: number;
      inputToIntentP95Ms: number | null;
    };
  });
}

function expectExactKeys(value: unknown, expected: readonly string[]) {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Object.keys(value as Record<string, unknown>).sort()).toEqual([...expected].sort());
}
