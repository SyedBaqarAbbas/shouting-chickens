import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Locator } from "@playwright/test";

import {
  installSyntheticMedia,
  setSyntheticDbfs,
  syntheticMediaSnapshot,
} from "../release/media-harness";
import {
  HEAP_TREND_LIMIT_BYTES_PER_SAMPLE,
  linearHeapTrendBytesPerSample,
} from "../../src/game/HeapTrend";

const soakDurationMs = Number(process.env.SOAK_DURATION_MS ?? 600_000);
const maxHeapGrowthBytes = 4 * 1_024 * 1_024;

test("runs the sealed game without resource or heap growth for ten wall-clock minutes", async ({
  page,
}) => {
  test.setTimeout(soakDurationMs + 60_000);
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    runtimeErrors.push(error.message);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await installSyntheticMedia(page, { camera: "allow", microphone: "allow" });
  await page.goto("./");
  await page.getByRole("button", { name: "Enable microphone" }).click();
  await completeValidCalibration(page);
  await setSyntheticDbfs(page, -60);
  await page.getByRole("button", { name: "Start run" }).click();

  const surface = page.getByTestId("game-surface");
  await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
  await page.getByRole("button", { name: "Camera off · Enable" }).click();
  await expect(page.locator("#camera-status")).toContainText("Camera on");
  await expect(surface.locator("canvas")).toHaveCount(1);
  const stable = await resources(surface);
  expect(stable.activeBodies).toBe(1);
  expect(stable.activeTimers).toBe(0);
  expect(stable.inputListeners).toBeGreaterThan(0);
  expect(stable.sceneObjects).toBeGreaterThan(0);
  expect(stable.media.activeAudioNodes).toBeGreaterThan(0);
  expect(stable.media.activeCameraTracks).toBe(1);
  expect(stable.media.activeMicrophoneTracks).toBe(1);
  expect(stable.media.activeTracks).toBe(2);
  const startedAt = globalThis.performance.now();
  let restarts = 0;
  const heapSamples: number[] = [];

  while (globalThis.performance.now() - startedAt < soakDurationMs) {
    await expect(surface).toHaveAttribute("data-simulation-phase", "dead", {
      timeout: 12_000,
    });
    const completedRun = await runSnapshot(surface);
    expect(completedRun.collisionId).not.toBe("");
    expect(completedRun.deathReason).not.toBe("");
    expect(completedRun.elapsedMs).toBeGreaterThan(0);
    expect(completedRun.generation).toBeGreaterThan(0);
    expect(completedRun.phase).toBe("dead");
    expect(completedRun.restartToken).toBeGreaterThanOrEqual(0);
    expect(completedRun.survivalScore).toBe(Math.floor(completedRun.elapsedMs / 100));
    expect(completedRun.score).toBe(
      completedRun.survivalScore + completedRun.collectibleScore + completedRun.precisionScore,
    );

    await page.getByRole("button", { name: "Restart run" }).click();
    await expect(surface).toHaveAttribute(
      "data-restart-token",
      String(completedRun.restartToken + 1),
    );
    await expect(surface).toHaveAttribute(
      "data-run-generation",
      String(completedRun.generation + 1),
    );
    const enableCamera = page.getByRole("button", { name: "Camera preferred · Enable" });
    if (await enableCamera.isVisible()) {
      await enableCamera.click();
    }
    await expect(page.locator("#camera-status")).toContainText("Camera on");
    const inputSamplesBeforeVoice = (await performanceDiagnostics(surface)).inputSamples;
    await setSyntheticDbfs(page, -18);
    await expect
      .poll(async () => (await performanceDiagnostics(surface)).inputSamples)
      .toBeGreaterThan(inputSamplesBeforeVoice);
    await setSyntheticDbfs(page, -60);
    const restartedRun = await runSnapshot(surface);
    expect(restartedRun).toMatchObject({
      collisionId: "",
      deathReason: "",
      loopsCompleted: 0,
      phase: "running",
    });
    expect(restartedRun.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(restartedRun.elapsedMs).toBeLessThan(completedRun.elapsedMs);
    expect(restartedRun.generation).toBe(completedRun.generation + 1);
    expect(restartedRun.restartToken).toBe(completedRun.restartToken + 1);
    expect(restartedRun.score).toBeGreaterThanOrEqual(0);
    expect(restartedRun.survivalScore).toBe(Math.floor(restartedRun.elapsedMs / 100));
    expect(restartedRun.score).toBe(
      restartedRun.survivalScore + restartedRun.collectibleScore + restartedRun.precisionScore,
    );
    expect(restartedRun.score).toBeLessThan(completedRun.score);
    await expect(surface.locator("canvas")).toHaveCount(1);
    await expect
      .poll(async () => stableResourceCore(await resources(surface)))
      .toEqual(stableResourceCore(stable));
    const currentResources = await resources(surface);
    expect(currentResources.activeParticles).toBeLessThanOrEqual(24);
    expect(currentResources.audioActiveVoices).toBeLessThanOrEqual(1);
    expect(currentResources.retainedCollectibleIds).toBeLessThanOrEqual(12);
    expect(currentResources.retainedCollisionIds).toBeLessThanOrEqual(1);
    expect(currentResources.retainedObstacleIds).toBeLessThanOrEqual(24);
    expect(currentResources.retainedPrecisionLandingIds).toBeLessThanOrEqual(16);
    const media = await syntheticMediaSnapshot(page);
    expect(media.cameraRequests - media.cameraStops).toBe(1);
    expect(media.microphoneRequests - media.microphoneStops).toBe(1);
    await page.requestGC();
    const heap = await chromiumHeapBytes(surface);
    if (heap !== null) {
      heapSamples.push(heap);
    }
    expect(runtimeErrors).toEqual([]);
    restarts += 1;
  }

  const elapsedWallMs = globalThis.performance.now() - startedAt;
  expect(elapsedWallMs).toBeGreaterThanOrEqual(soakDurationMs);
  expect(restarts).toBeGreaterThanOrEqual(Math.max(2, Math.floor(soakDurationMs / 12_000)));
  expect(runtimeErrors).toEqual([]);
  const performance = await performanceDiagnostics(surface);
  expect(performance.frameSamples).toBeGreaterThan(1_000);
  expect(performance.frameP95Ms).toBeLessThanOrEqual(20);
  expect(performance.inputSamples).toBeGreaterThan(0);
  expect(performance.inputToIntentP95Ms).toBeLessThanOrEqual(100);
  expect(performance.voiceInputSamples).toBe(performance.inputSamples);
  expect(performance.voiceInputToIntentP95Ms).toBeLessThanOrEqual(100);
  expect(heapSamples.length).toBeGreaterThanOrEqual(2);
  let heapGrowthBytes: number | null = null;
  let heapGrowthLimitBytes: number | null = null;
  let heapTrendBytesPerSample: number | null = null;
  if (heapSamples.length >= 2) {
    const sampleWindow = Math.min(5, Math.floor(heapSamples.length / 2));
    const baselineHeap = median(heapSamples.slice(0, sampleWindow));
    const finalHeap = median(heapSamples.slice(-sampleWindow));
    heapGrowthBytes = finalHeap - baselineHeap;
    heapGrowthLimitBytes = Math.max(maxHeapGrowthBytes, baselineHeap * 0.2);
    expect(heapGrowthBytes).toBeLessThanOrEqual(heapGrowthLimitBytes);
  }
  if (heapSamples.length >= 20) {
    heapTrendBytesPerSample = linearHeapTrendBytesPerSample(heapSamples.slice(5));
    expect(heapTrendBytesPerSample).not.toBeNull();
    expect(heapTrendBytesPerSample!).toBeLessThanOrEqual(HEAP_TREND_LIMIT_BYTES_PER_SAMPLE);
  }
  const evidence = {
    elapsedWallMs,
    heapGrowthBytes,
    heapGrowthLimitBytes,
    heapSamples,
    heapTrendBytesPerSample,
    heapTrendLimitBytesPerSample: HEAP_TREND_LIMIT_BYTES_PER_SAMPLE,
    performance,
    requestedWallMs: soakDurationMs,
    restarts,
    stableResources: stable,
  };
  await mkdir(resolve(process.cwd(), ".release-evidence"), { recursive: true });
  await writeFile(
    resolve(process.cwd(), ".release-evidence/restart-soak.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(evidence));
});

async function runSnapshot(surface: Locator) {
  return surface.evaluate((element) => {
    const requiredString = (name: string) => {
      const raw = element.getAttribute(name);
      if (raw === null) {
        throw new Error(`Missing ${name}`);
      }
      return raw;
    };
    const requiredNumber = (name: string) => {
      const raw = requiredString(name);
      if (raw.trim() === "") {
        throw new Error(`Invalid ${name}: empty`);
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid ${name}: ${raw}`);
      }
      return value;
    };

    return {
      collisionId: requiredString("data-collision-id"),
      collectibleScore: requiredNumber("data-collectible-score"),
      deathReason: requiredString("data-death-reason"),
      elapsedMs: requiredNumber("data-elapsed-ms"),
      generation: requiredNumber("data-run-generation"),
      loopsCompleted: requiredNumber("data-loops-completed"),
      phase: requiredString("data-simulation-phase"),
      precisionScore: requiredNumber("data-precision-score"),
      restartToken: requiredNumber("data-restart-token"),
      score: requiredNumber("data-score"),
      survivalScore: requiredNumber("data-survival-score"),
    };
  });
}

async function resources(surface: Locator) {
  const runtime = {
    activeBodies: await requiredNumber(surface, "data-active-bodies"),
    activeParticles: await requiredNumber(surface, "data-active-particles"),
    activeTimers: await requiredNumber(surface, "data-active-timers"),
    audioActiveVoices: await requiredNumber(surface, "data-audio-active-voices"),
    audioGraphNodes: await requiredNumber(surface, "data-audio-graph-nodes"),
    collisionZones: await requiredNumber(surface, "data-collision-zones"),
    eventListeners: await requiredNumber(surface, "data-event-listeners"),
    inputListeners: await requiredNumber(surface, "data-input-listeners"),
    pooledObjects: await requiredNumber(surface, "data-pooled-objects"),
    retainedCollectibleIds: await requiredNumber(surface, "data-retained-collectible-ids"),
    retainedCollisionIds: await requiredNumber(surface, "data-retained-collision-ids"),
    retainedObstacleIds: await requiredNumber(surface, "data-retained-obstacle-ids"),
    retainedPrecisionLandingIds: await requiredNumber(
      surface,
      "data-retained-precision-landing-ids",
    ),
    sceneObjects: await requiredNumber(surface, "data-scene-objects"),
  };
  const media = await surface.locator("..").evaluate((element) => {
    const root = element.closest(".experience-root");
    const raw = root?.getAttribute("data-media-diagnostics");
    if (!raw) {
      throw new Error("Missing media diagnostics");
    }
    return JSON.parse(raw) as {
      resources: {
        activeAudioNodes: number;
        activeCameraTracks: number;
        activeMicrophoneTracks: number;
        activeTracks: number;
        lifecycleListeners: number;
        pendingAudioContexts: number;
        sessionSubscribers: number;
        trackListeners: number;
      };
    };
  });
  return {
    ...runtime,
    media: media.resources,
  };
}

function stableResourceCore(snapshot: Awaited<ReturnType<typeof resources>>) {
  return {
    activeBodies: snapshot.activeBodies,
    activeTimers: snapshot.activeTimers,
    audioGraphNodes: snapshot.audioGraphNodes,
    collisionZones: snapshot.collisionZones,
    eventListeners: snapshot.eventListeners,
    inputListeners: snapshot.inputListeners,
    media: snapshot.media,
    pooledObjects: snapshot.pooledObjects,
    sceneObjects: snapshot.sceneObjects,
  };
}

async function performanceDiagnostics(surface: Locator) {
  return surface.evaluate((element) => {
    const raw = element.getAttribute("data-performance-diagnostics");
    if (!raw) {
      throw new Error("Missing performance diagnostics");
    }
    return JSON.parse(raw) as {
      frameP95Ms: number | null;
      frameSamples: number;
      inputSamples: number;
      inputToIntentP95Ms: number | null;
      voiceInputSamples: number;
      voiceInputToIntentP95Ms: number | null;
    };
  });
}

async function chromiumHeapBytes(surface: Locator) {
  return surface.evaluate(() => {
    const memory = (
      performance as Performance & {
        memory?: { usedJSHeapSize?: number };
      }
    ).memory;
    return Number.isFinite(memory?.usedJSHeapSize) ? memory!.usedJSHeapSize! : null;
  });
}

async function requiredNumber(surface: Locator, name: string) {
  const raw = await surface.getAttribute(name);
  expect(raw, name).not.toBeNull();
  const value = Number(raw);
  expect(Number.isFinite(value), name).toBe(true);
  return value;
}

async function completeValidCalibration(page: import("@playwright/test").Page) {
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
  }
  await expect(page.getByRole("button", { name: "Use this calibration" })).toBeEnabled();
  await page.getByRole("button", { name: "Use this calibration" }).click();
}

function median(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
