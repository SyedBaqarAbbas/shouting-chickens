import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Locator } from "@playwright/test";

const soakDurationMs = Number(process.env.SOAK_DURATION_MS ?? 300_000);

test("restarts the sealed MVP without resource growth for at least five wall-clock minutes", async ({
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
  await page.goto("./");
  await page.getByRole("button", { name: "Use keyboard or touch" }).click();
  await page.getByRole("button", { name: "Start run" }).click();

  const surface = page.getByTestId("game-surface");
  await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
  await expect(surface.locator("canvas")).toHaveCount(1);
  const stable = await resources(surface);
  expect(stable.activeBodies).toBe(1);
  expect(stable.activeTimers).toBe(0);
  expect(stable.inputListeners).toBeGreaterThan(0);
  expect(stable.sceneObjects).toBeGreaterThan(0);
  const startedAt = Date.now();
  let restarts = 0;

  while (Date.now() - startedAt < soakDurationMs) {
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
    expect(completedRun.score).toBe(Math.floor(completedRun.elapsedMs / 100));

    await page.getByRole("button", { name: "Restart run" }).click();
    await expect(surface).toHaveAttribute(
      "data-restart-token",
      String(completedRun.restartToken + 1),
    );
    await expect(surface).toHaveAttribute(
      "data-run-generation",
      String(completedRun.generation + 1),
    );
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
    expect(restartedRun.score).toBe(Math.floor(restartedRun.elapsedMs / 100));
    expect(restartedRun.score).toBeLessThan(completedRun.score);
    await expect(surface.locator("canvas")).toHaveCount(1);
    expect(await resources(surface)).toEqual(stable);
    expect(runtimeErrors).toEqual([]);
    restarts += 1;
  }

  const elapsedWallMs = Date.now() - startedAt;
  expect(elapsedWallMs).toBeGreaterThanOrEqual(soakDurationMs);
  expect(restarts).toBeGreaterThanOrEqual(Math.max(2, Math.floor(soakDurationMs / 12_000)));
  expect(runtimeErrors).toEqual([]);
  const evidence = {
    elapsedWallMs,
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
      deathReason: requiredString("data-death-reason"),
      elapsedMs: requiredNumber("data-elapsed-ms"),
      generation: requiredNumber("data-run-generation"),
      loopsCompleted: requiredNumber("data-loops-completed"),
      phase: requiredString("data-simulation-phase"),
      restartToken: requiredNumber("data-restart-token"),
      score: requiredNumber("data-score"),
    };
  });
}

async function resources(surface: Locator) {
  return {
    activeBodies: await requiredNumber(surface, "data-active-bodies"),
    activeTimers: await requiredNumber(surface, "data-active-timers"),
    collisionZones: await requiredNumber(surface, "data-collision-zones"),
    inputListeners: await requiredNumber(surface, "data-input-listeners"),
    pooledObjects: await requiredNumber(surface, "data-pooled-objects"),
    sceneObjects: await requiredNumber(surface, "data-scene-objects"),
  };
}

async function requiredNumber(surface: Locator, name: string) {
  const raw = await surface.getAttribute(name);
  expect(raw, name).not.toBeNull();
  const value = Number(raw);
  expect(Number.isFinite(value), name).toBe(true);
  return value;
}
