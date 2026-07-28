import { expect, test } from "@playwright/test";

async function expectMountedWorld(page: import("@playwright/test").Page) {
  const fallback = page.getByRole("button", { name: "Use keyboard or touch" });
  const start = page.getByRole("button", { name: "Start run" });
  if ((await page.getByTestId("game-surface").count()) === 0) {
    await expect(fallback.or(start)).toBeVisible();
    if (await fallback.isVisible().catch(() => false)) {
      await fallback.click();
    }
    await start.click();
  }

  const surface = page.getByTestId("game-surface");

  await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
  await expect(surface).toHaveAttribute("data-logical-width", "432");
  await expect(surface).toHaveAttribute("data-logical-height", "768");
  await expect(surface.locator("canvas")).toHaveCount(1);

  return surface;
}

for (const viewport of [
  { name: "phone", width: 390, height: 844 },
  { name: "compact phone", width: 320, height: 568 },
  { name: "short phone", width: 390, height: 568 },
  { name: "desktop", width: 1280, height: 900 },
]) {
  test(`keeps one centered portrait world at the ${viewport.name} viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");

    const surface = await expectMountedWorld(page);
    await expect(page.getByRole("heading", { name: "Shouting Chickens" })).toBeVisible();
    await expect(page.getByText("Keyboard + touch ready")).toBeVisible();
    const controls = [
      page.getByRole("button", { name: "Pause run" }),
      page.getByRole("button", { name: "Mute game" }),
      page.getByRole("button", { name: "Settings" }),
      page.locator(".camera-toggle"),
    ];
    for (const control of controls) {
      await expect(control).toBeVisible();
    }
    const box = await surface.boundingBox();
    const controlBoxes = await Promise.all(controls.map((control) => control.boundingBox()));

    expect(box).not.toBeNull();
    for (const controlBox of controlBoxes) {
      expect(controlBox).not.toBeNull();
      const resolvedControlBox = controlBox!;
      expect(resolvedControlBox.height).toBeGreaterThanOrEqual(44);
      expect(resolvedControlBox.width).toBeGreaterThanOrEqual(44);
      expect(resolvedControlBox.x).toBeGreaterThanOrEqual(box!.x);
      expect(resolvedControlBox.x + resolvedControlBox.width).toBeLessThanOrEqual(
        box!.x + box!.width,
      );
      expect(resolvedControlBox.y).toBeGreaterThanOrEqual(box!.y);
      expect(resolvedControlBox.y + resolvedControlBox.height).toBeLessThanOrEqual(
        box!.y + box!.height,
      );
    }
    for (let first = 0; first < controlBoxes.length; first += 1) {
      for (let second = first + 1; second < controlBoxes.length; second += 1) {
        const firstBox = controlBoxes[first]!;
        const secondBox = controlBoxes[second]!;
        const controlsOverlap =
          firstBox.x < secondBox.x + secondBox.width &&
          firstBox.x + firstBox.width > secondBox.x &&
          firstBox.y < secondBox.y + secondBox.height &&
          firstBox.y + firstBox.height > secondBox.y;
        expect(controlsOverlap).toBe(false);
      }
    }
    expect(box!.width / box!.height).toBeCloseTo(432 / 768, 2);
    expect(box!.width).toBeLessThanOrEqual(432);
    expect(box!.height).toBeLessThanOrEqual(768);
    expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(2);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test("retains the portrait playfield across a phone resize", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  const surface = await expectMountedWorld(page);

  await page.setViewportSize({ width: 430, height: 932 });
  await expect(surface).toHaveAttribute("data-orientation", "portrait");

  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width / box!.height).toBeCloseTo(432 / 768, 2);
  await expect(surface.locator("canvas")).toHaveCount(1);
});

test("does not accumulate real Phaser canvases across repeated boots", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });

  for (let boot = 0; boot < 3; boot += 1) {
    await page.goto("/");
    const surface = await expectMountedWorld(page);
    await expect(surface).toHaveAttribute("data-active-bodies", "1");
    await expect(page.locator("canvas")).toHaveCount(1);
    await page.goto("about:blank");
    await expect(page.locator("canvas")).toHaveCount(0);
  }
});

test("ends a run once and completely restarts the seeded authored course", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const surface = await expectMountedWorld(page);
  const stableResources = {
    bodies: await surface.getAttribute("data-active-bodies"),
    timers: await surface.getAttribute("data-active-timers"),
    pools: await surface.getAttribute("data-pooled-objects"),
    collisions: await surface.getAttribute("data-collision-zones"),
    sceneObjects: await surface.getAttribute("data-scene-objects"),
    inputListeners: await surface.getAttribute("data-input-listeners"),
  };

  expect(stableResources).toMatchObject({
    bodies: "1",
    timers: "0",
    pools: "86",
    collisions: "10",
    inputListeners: "5",
  });
  expect(Number(stableResources.sceneObjects)).toBeGreaterThan(0);
  let stableEnded: Record<string, string | number | null> | undefined;

  for (let run = 0; run < 3; run += 1) {
    await expect(surface).toHaveAttribute("data-simulation-phase", "dead", {
      timeout: 10_000,
    });
    await expect(surface).toHaveAttribute("data-death-reason", "hazard");
    await expect(surface).toHaveAttribute("data-collision-id", "0:spike-straight:spike");
    await expect(surface).toHaveAttribute("data-current-chunk-id", "spike-straight");
    await expect(surface).toHaveAttribute("data-failed-run-seed", "authored-launch");
    await expect(surface).toHaveAttribute(
      "data-failed-run-gameplay-version",
      "sho-17-progression-v1",
    );

    const ended = await surface.evaluate((element) => ({
      activeChunkIds: element.getAttribute("data-active-chunk-ids"),
      collectedCollectibles: Number(element.getAttribute("data-collected-collectibles")),
      collectibleScore: Number(element.getAttribute("data-collectible-score")),
      collisionId: element.getAttribute("data-collision-id"),
      currentChunkId: element.getAttribute("data-current-chunk-id"),
      deathReason: element.getAttribute("data-death-reason"),
      difficultyStage: Number(element.getAttribute("data-difficulty-stage")),
      elapsedMs: Number(element.getAttribute("data-elapsed-ms")),
      liftStamina: Number(element.getAttribute("data-lift-stamina")),
      longestLiftMs: Number(element.getAttribute("data-longest-lift-ms")),
      obstaclesCleared: Number(element.getAttribute("data-obstacles-cleared")),
      precisionLandings: Number(element.getAttribute("data-precision-landings")),
      precisionScore: Number(element.getAttribute("data-precision-score")),
      score: Number(element.getAttribute("data-score")),
      survivalScore: Number(element.getAttribute("data-survival-score")),
      worldSpeed: Number(element.getAttribute("data-world-speed")),
    }));
    stableEnded ??= ended;
    expect(ended).toEqual(stableEnded);
    expect(ended).toMatchObject({
      activeChunkIds:
        "spike-straight,lift-terraces,stepping-rise,precision-islands-intro,meadow-hop,quiet-tunnel-intro",
      collectedCollectibles: 0,
      collectibleScore: 0,
      collisionId: "0:spike-straight:spike",
      currentChunkId: "spike-straight",
      deathReason: "hazard",
      difficultyStage: 1,
      liftStamina: 1,
      longestLiftMs: 0,
      obstaclesCleared: 0,
      precisionLandings: 0,
      precisionScore: 0,
      worldSpeed: 144,
    });
    expect(ended.elapsedMs).toBeGreaterThan(0);
    expect(ended.score).toBe(ended.survivalScore + ended.collectibleScore + ended.precisionScore);
    expect(ended.survivalScore).toBe(Math.floor(ended.elapsedMs / 100));
    expect(ended.difficultyStage).toBeGreaterThanOrEqual(1);
    expect(ended.difficultyStage).toBeLessThanOrEqual(5);
    expect(ended.worldSpeed).toBeLessThanOrEqual(160);
    expect(ended.liftStamina).toBeGreaterThanOrEqual(0);
    expect(ended.liftStamina).toBeLessThanOrEqual(1);
    expect(ended.obstaclesCleared).toBe(0);
    expect(ended.precisionLandings).toBeGreaterThanOrEqual(0);
    expect(ended.longestLiftMs).toBeGreaterThanOrEqual(0);

    await expect(page.getByRole("heading", { name: "Nice flight" })).toBeFocused();
    const resultValue = (label: string) =>
      page.locator(".results-grid > div").filter({ hasText: label }).locator("dd");
    await expect(resultValue("Total score")).toHaveText(String(ended.score));
    await expect(resultValue("Survival points")).toHaveText(String(ended.survivalScore));
    await expect(resultValue("Collectible bonus")).toHaveText(String(ended.collectibleScore));
    await expect(resultValue("Precision bonus")).toHaveText(String(ended.precisionScore));
    await expect(resultValue("Obstacles cleared")).toHaveText(String(ended.obstaclesCleared));
    await expect(resultValue("Longest lift")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Restart run" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(surface).toHaveAttribute("data-simulation-phase", "running");
    await expect(surface).toHaveAttribute("data-death-reason", "");
    await expect(surface).toHaveAttribute("data-collision-id", "");
    await expect(surface).toHaveAttribute("data-loops-completed", "0");
    await expect(surface).toHaveAttribute("data-collectible-score", "0");
    await expect(surface).toHaveAttribute("data-precision-score", "0");
    await expect(surface).toHaveAttribute("data-lift-stamina", "1.000");
    await expect(surface).toHaveAttribute("data-difficulty-stage", "1");
    await expect(surface).toHaveAttribute("data-world-speed", "144.000");
    await expect(surface).toHaveAttribute("data-obstacles-cleared", "0");
    await expect(surface).toHaveAttribute("data-precision-landings", "0");
    await expect(surface).toHaveAttribute("data-longest-lift-ms", "0");
    await expect(surface).not.toHaveAttribute("data-failed-run-seed");
    await expect(surface).not.toHaveAttribute("data-failed-run-gameplay-version");
    expect({
      bodies: await surface.getAttribute("data-active-bodies"),
      timers: await surface.getAttribute("data-active-timers"),
      pools: await surface.getAttribute("data-pooled-objects"),
      collisions: await surface.getAttribute("data-collision-zones"),
      sceneObjects: await surface.getAttribute("data-scene-objects"),
      inputListeners: await surface.getAttribute("data-input-listeners"),
    }).toEqual(stableResources);
  }
});

test("mounts the exact weighted safe-introduction course and resets its warnings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const surface = await expectMountedWorld(page);
  await page.getByRole("button", { name: "Pause run" }).click();
  await expect(surface).toHaveAttribute("data-simulation-phase", "paused");

  const initial = {
    challengeStage: await surface.getAttribute("data-current-chunk-challenge-stage"),
    chunks: await surface.getAttribute("data-active-chunk-ids"),
    difficultyStage: Number(await surface.getAttribute("data-difficulty-stage")),
    movementPhases: await surface.getAttribute("data-moving-hazard-phases"),
    pools: await surface.getAttribute("data-pooled-objects"),
    renderedCollectibles: Number(await surface.getAttribute("data-rendered-collectibles")),
    renderedMovingHazards: Number(await surface.getAttribute("data-rendered-moving-hazards")),
    renderedQuietZones: Number(await surface.getAttribute("data-rendered-quiet-zones")),
    renderedWarnings: Number(await surface.getAttribute("data-rendered-warnings")),
    warningCount: Number(await surface.getAttribute("data-active-warning-count")),
    warnings: await surface.getAttribute("data-active-warning-copy"),
    worldSpeed: Number(await surface.getAttribute("data-world-speed")),
  };

  expect(initial).toMatchObject({
    challengeStage: "introduction",
    chunks:
      "spike-straight,lift-terraces,stepping-rise,precision-islands-intro,meadow-hop,quiet-tunnel-intro",
    difficultyStage: 1,
    movementPhases: "",
    pools: "86",
    renderedMovingHazards: 0,
    worldSpeed: 144,
  });
  expect(initial.warnings).toContain("RELEASE");
  expect(initial.warnings).toContain("HOLD LIFT");
  expect(initial.warnings).toContain("PULSE");
  expect(initial.warningCount).toBe(4);
  expect(initial.renderedWarnings).toBe(4);
  expect(initial.renderedQuietZones).toBeGreaterThanOrEqual(1);
  expect(initial.renderedCollectibles).toBeGreaterThanOrEqual(1);

  await page.getByRole("button", { name: "Resume run" }).click();
  await expect(surface).toHaveAttribute("data-simulation-phase", "dead", {
    timeout: 10_000,
  });
  await expect(page.getByRole("heading", { name: "Nice flight" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Restart run" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Pause run" }).click();
  await expect(surface).toHaveAttribute("data-simulation-phase", "paused");

  expect({
    challengeStage: await surface.getAttribute("data-current-chunk-challenge-stage"),
    chunks: await surface.getAttribute("data-active-chunk-ids"),
    difficultyStage: Number(await surface.getAttribute("data-difficulty-stage")),
    movementPhases: await surface.getAttribute("data-moving-hazard-phases"),
    pools: await surface.getAttribute("data-pooled-objects"),
    renderedCollectibles: Number(await surface.getAttribute("data-rendered-collectibles")),
    renderedMovingHazards: Number(await surface.getAttribute("data-rendered-moving-hazards")),
    renderedQuietZones: Number(await surface.getAttribute("data-rendered-quiet-zones")),
    renderedWarnings: Number(await surface.getAttribute("data-rendered-warnings")),
    warningCount: Number(await surface.getAttribute("data-active-warning-count")),
    warnings: await surface.getAttribute("data-active-warning-copy"),
    worldSpeed: Number(await surface.getAttribute("data-world-speed")),
  }).toEqual(initial);
});

test("pauses behind a rotate message in compact landscape", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const surface = await expectMountedWorld(page);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByText("Rotate your device to play")).toBeVisible();
  await expect(surface).toHaveAttribute("data-orientation", "landscape");
  await expect(surface).toHaveAttribute("data-simulation-phase", "paused");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("Rotate your device to play")).toBeHidden();
  await expect(surface).toHaveAttribute("data-orientation", "portrait");
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
});

test.describe("high-density display", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
  });

  test("caps the Phaser backing canvas at device pixel ratio 2", async ({ page }) => {
    await page.goto("/");
    const surface = await expectMountedWorld(page);
    await expect(surface).toHaveAttribute("data-render-resolution", "2");

    const canvasSize = await surface.locator("canvas").evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      return {
        width: canvas.width,
        height: canvas.height,
      };
    });

    expect(canvasSize).toEqual({ width: 864, height: 1536 });
  });
});
