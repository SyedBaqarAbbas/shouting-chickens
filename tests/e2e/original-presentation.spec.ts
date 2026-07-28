import { expect, test, type Locator, type Page } from "@playwright/test";

const PRESENTATION_SNAPSHOT_TICK = 12;

function captureBrowserFailures(page: Page) {
  const failures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      failures.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    failures.push(
      `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown error"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failures.push(`response: ${response.status()} ${response.url()}`);
    }
  });
  return failures;
}

async function installDeterministicPause(page: Page, targetTick: number) {
  await page.addInitScript((tick) => {
    window.addEventListener(
      "DOMContentLoaded",
      () => {
        const observer = new MutationObserver(() => {
          const surface = document.querySelector('[data-testid="game-surface"]');
          const pause = document.querySelector<HTMLButtonElement>('button[aria-label="Pause run"]');
          if (
            surface &&
            pause &&
            Number(surface.getAttribute("data-simulation-tick") ?? "-1") >= tick
          ) {
            pause.click();
            observer.disconnect();
          }
        });
        observer.observe(document.documentElement, {
          attributeFilter: ["data-simulation-tick"],
          attributes: true,
          childList: true,
          subtree: true,
        });
      },
      { once: true },
    );
  }, targetTick);
}

async function mountFallbackRun(page: Page, pauseAtTick?: number) {
  if (pauseAtTick !== undefined) {
    await installDeterministicPause(page, pauseAtTick);
  }
  await page.goto("/");
  const fallback = page.getByRole("button", { name: "Use keyboard or touch" });
  if (await fallback.isVisible().catch(() => false)) {
    await fallback.click();
  }
  const start = page.getByRole("button", { name: "Start run" });
  if (await start.isVisible().catch(() => false)) {
    await start.click();
  }

  const surface = page.getByTestId("game-surface");
  await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
  await expect(surface.locator("canvas")).toHaveCount(1);
  if (pauseAtTick !== undefined) {
    await expect(surface).toHaveAttribute("data-simulation-phase", "paused");
    await expect(surface).toHaveAttribute("data-simulation-tick", String(pauseAtTick));
  }
  return surface;
}

async function expectWorldBandSnapshot(page: Page, surface: Locator, name: string) {
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  await page.addStyleTag({
    content: ".bootstrap-note { visibility: hidden !important; }",
  });
  const top = Math.round(box!.y + box!.height * 0.53);
  const screenshot = await page.screenshot({
    animations: "disabled",
    caret: "hide",
    clip: {
      x: Math.round(box!.x),
      y: top,
      width: Math.floor(box!.width),
      height: Math.floor(box!.y + box!.height - top),
    },
  });
  expect(screenshot).toMatchSnapshot(name, {
    maxDiffPixelRatio: 0.02,
  });
}

for (const viewport of [
  { name: "phone", width: 390, height: 844 },
  { name: "compact-phone", width: 320, height: 568 },
  { name: "desktop", width: 1_280, height: 900 },
]) {
  test(`keeps the original vector presentation readable at the ${viewport.name} viewport`, async ({
    page,
  }) => {
    const browserFailures = captureBrowserFailures(page);
    await page.setViewportSize(viewport);
    const surface = await mountFallbackRun(page, PRESENTATION_SNAPSHOT_TICK);
    await page.addStyleTag({
      content: ".flow-card--modal { visibility: hidden !important; }",
    });

    await expect(surface).toHaveAttribute("data-art-atlas-frames", "16");
    await expect(surface).toHaveAttribute("data-art-atlas-source", "svg-atlas");
    await expect(surface).toHaveAttribute("data-invalid-visible-art-objects", "0");
    await expect(surface).toHaveAttribute("data-pooled-objects", "86");
    await expect(surface).toHaveAttribute(
      "data-chicken-art-frame",
      /chicken-(?:idle|run-a|run-b|jump|flap-a|flap-b|death)/,
    );
    await expect(surface).toHaveAttribute("data-rendered-warnings", /[1-9]\d*/);
    await expect(surface).toHaveAttribute("data-rendered-collectibles", /[1-9]\d*/);
    await expect(surface).toHaveAttribute("data-rendered-moving-hazards", /[1-9]\d*/);
    await expect(surface).toHaveAttribute(
      "data-active-warning-copy",
      /↔ MOVING SPIKE.+↓ RELEASE.+↥ HOLD LIFT.+•• PULSE.+! SPIKES/,
    );

    await expectWorldBandSnapshot(page, surface, `original-presentation-${viewport.name}.png`);
    expect(browserFailures).toEqual([]);
  });
}

test("renders every original art role in the bounded text-only SVG atlas", async ({ page }) => {
  const browserFailures = captureBrowserFailures(page);
  await page.setViewportSize({ width: 1_280, height: 160 });
  await page.goto("assets/shouting-chickens-atlas.svg");
  const atlas = page.locator("svg");

  await expect(atlas).toHaveAttribute("viewBox", "0 0 1280 80");
  await expect(page.locator("svg > g")).toHaveCount(16);
  await expect(atlas).toHaveScreenshot("original-game-atlas.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
  expect(browserFailures).toEqual([]);
});

test("mutes all cues and disables moving feedback when reduced motion is requested", async ({
  page,
}) => {
  const browserFailures = captureBrowserFailures(page);
  await installDeterministicPause(page, PRESENTATION_SNAPSHOT_TICK);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Use keyboard or touch" }).click();
  await page.getByRole("button", { name: "Accessibility & settings" }).click();
  await page.getByRole("checkbox", { name: "Mute game" }).check();
  await page.getByRole("checkbox", { name: "Reduce motion" }).check();
  await page.getByRole("checkbox", { name: "Screen shake" }).uncheck();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Start run" }).click();

  const surface = page.getByTestId("game-surface");
  await expect(surface).toHaveAttribute("data-simulation-phase", "paused");
  await expect(surface).toHaveAttribute("data-simulation-tick", String(PRESENTATION_SNAPSHOT_TICK));
  await expect(surface).toHaveAttribute("data-muted", "true");
  await expect(surface).toHaveAttribute("data-reduced-motion", "true");
  await expect(surface).toHaveAttribute("data-screen-shake-enabled", "false");
  await expect(surface).toHaveAttribute("data-active-particles", "0");
  await expect(surface).toHaveAttribute("data-player-animation", "idle");
  await expect(surface).toHaveAttribute("data-chicken-art-frame", "chicken-idle");
  await page.waitForTimeout(350);
  await expect(surface).toHaveAttribute("data-chicken-art-frame", "chicken-idle");
  await expect(surface).toHaveAttribute("data-active-particles", "0");
  await expect(surface).toHaveAttribute("data-audio-cue-count", "0");
  await expect(surface).toHaveAttribute("data-last-audio-cue", "");

  await page.getByRole("button", { name: "Resume run" }).click();
  await expect(surface).toHaveAttribute("data-simulation-phase", "dead", { timeout: 10_000 });
  await expect(surface).toHaveAttribute("data-active-particles", "0");
  await expect(surface).toHaveAttribute("data-audio-cue-count", "0");
  await expect(surface).toHaveAttribute("data-last-audio-cue", "");
  expect(browserFailures).toEqual([]);
});

test("plays bounded unmuted cues and reuses the fixed particle pool", async ({ page }) => {
  const browserFailures = captureBrowserFailures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const surface = await mountFallbackRun(page);

  await surface.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: "touch",
  });
  await page.waitForTimeout(80);
  await surface.dispatchEvent("pointerup", {
    button: 0,
    buttons: 0,
    pointerId: 1,
    pointerType: "touch",
  });

  await expect(surface).toHaveAttribute("data-audio-state", "ready");
  await expect
    .poll(async () => Number(await surface.getAttribute("data-audio-cue-count")))
    .toBeGreaterThan(0);
  await expect(surface).toHaveAttribute("data-last-audio-cue", /jump|flap|land/);

  await expect(surface).toHaveAttribute("data-simulation-phase", "dead", { timeout: 10_000 });
  await expect
    .poll(async () => Number(await surface.getAttribute("data-active-particles")), {
      timeout: 1_000,
    })
    .toBeGreaterThan(0);
  await expect(surface).toHaveAttribute("data-last-audio-cue", "hazard");
  await expect(surface).toHaveAttribute("data-pooled-objects", "86");
  await expect
    .poll(async () => Number(await surface.getAttribute("data-active-particles")), {
      timeout: 2_000,
    })
    .toBe(0);
  await expect(surface).toHaveAttribute("data-pooled-objects", "86");
  expect(browserFailures).toEqual([]);
});

test("recovers with generated vector primitives when the SVG atlas cannot load", async ({
  page,
}) => {
  const browserFailures = captureBrowserFailures(page);
  await page.route("**/assets/shouting-chickens-atlas.svg", (route) => route.abort("failed"));
  await page.setViewportSize({ width: 390, height: 844 });
  const surface = await mountFallbackRun(page, PRESENTATION_SNAPSHOT_TICK);
  await page.addStyleTag({
    content: ".flow-card--modal { visibility: hidden !important; }",
  });

  await expect(surface).toHaveAttribute("data-art-atlas-source", "generated-fallback");
  await expect(surface).toHaveAttribute("data-art-atlas-frames", "16");
  await expect(surface).toHaveAttribute("data-invalid-visible-art-objects", "0");
  await expect(surface).toHaveAttribute(
    "data-chicken-art-frame",
    /chicken-(?:idle|run-a|run-b|jump|flap-a|flap-b|death)/,
  );
  await expect(surface.locator("canvas")).toBeVisible();
  await expectWorldBandSnapshot(page, surface, "original-generated-fallback-phone.png");
  expect(browserFailures.length).toBeGreaterThan(0);
  expect(
    browserFailures.every(
      (failure) =>
        failure === "console: Failed to load resource: net::ERR_FAILED" ||
        (/^requestfailed: .+\/assets\/shouting-chickens-atlas\.svg net::ERR_FAILED$/.test(
          failure,
        ) &&
          !failure.includes("favicon")),
    ),
  ).toBe(true);
});
