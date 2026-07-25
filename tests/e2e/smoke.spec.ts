import { expect, test } from "@playwright/test";

async function expectMountedWorld(page: import("@playwright/test").Page) {
  const fallback = page.getByRole("button", { name: "Use keyboard or touch" });
  if (await fallback.isVisible().catch(() => false)) {
    await fallback.click();
    await page.getByRole("button", { name: "Start run" }).click();
  } else if ((await page.getByTestId("game-surface").count()) === 0) {
    await fallback.waitFor();
    await fallback.click();
    await page.getByRole("button", { name: "Start run" }).click();
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
    const pauseControl = page.getByRole("button", { name: "Pause run" });
    const cameraControl = page.getByRole("button", { name: "Camera off · Enable" });
    await expect(pauseControl).toBeVisible();
    await expect(cameraControl).toBeVisible();
    const box = await surface.boundingBox();
    const pauseBox = await pauseControl.boundingBox();
    const cameraBox = await cameraControl.boundingBox();

    expect(box).not.toBeNull();
    expect(pauseBox).not.toBeNull();
    expect(cameraBox).not.toBeNull();
    expect(pauseBox!.height).toBeGreaterThanOrEqual(44);
    expect(pauseBox!.width).toBeGreaterThanOrEqual(44);
    expect(cameraBox!.height).toBeGreaterThanOrEqual(44);
    expect(cameraBox!.width).toBeGreaterThanOrEqual(44);
    for (const controlBox of [pauseBox!, cameraBox!]) {
      expect(controlBox.x).toBeGreaterThanOrEqual(box!.x);
      expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(box!.x + box!.width);
      expect(controlBox.y).toBeGreaterThanOrEqual(box!.y);
      expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(box!.y + box!.height);
    }
    const controlsOverlap =
      pauseBox!.x < cameraBox!.x + cameraBox!.width &&
      pauseBox!.x + pauseBox!.width > cameraBox!.x &&
      pauseBox!.y < cameraBox!.y + cameraBox!.height &&
      pauseBox!.y + pauseBox!.height > cameraBox!.y;
    expect(controlsOverlap).toBe(false);
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

test("ends a run once and completely restarts the fixed course", async ({ page }) => {
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
    pools: "14",
    collisions: "5",
    inputListeners: "5",
  });
  expect(Number(stableResources.sceneObjects)).toBeGreaterThan(0);

  for (let run = 0; run < 3; run += 1) {
    await expect(surface).toHaveAttribute("data-simulation-phase", "dead", {
      timeout: 10_000,
    });
    await expect(surface).toHaveAttribute("data-death-reason", "water");
    await expect(surface).toHaveAttribute("data-collision-id", "small-gap-water");

    const ended = await surface.evaluate((element) => ({
      elapsedMs: Number(element.getAttribute("data-elapsed-ms")),
      score: Number(element.getAttribute("data-score")),
    }));
    expect(ended.elapsedMs).toBeGreaterThan(0);
    expect(ended.score).toBe(Math.floor(ended.elapsedMs / 100));

    await expect(page.getByRole("heading", { name: "Nice flight" })).toBeFocused();
    await page.getByRole("button", { name: "Restart run" }).click();
    await expect(surface).toHaveAttribute("data-simulation-phase", "running");
    await expect(surface).toHaveAttribute("data-death-reason", "");
    await expect(surface).toHaveAttribute("data-collision-id", "");
    await expect(surface).toHaveAttribute("data-loops-completed", "0");
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
