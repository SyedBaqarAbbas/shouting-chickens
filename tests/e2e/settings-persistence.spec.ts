import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const STORAGE_KEY = "shouting-chickens.player-data.v2";

async function expectNoSeriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).include(".game-phone").analyze();
  expect(
    results.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map((node) => node.target),
      })),
  ).toEqual([]);
}

test("persists safe settings, restores fallback play, and resets only game-owned data", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expectNoSeriousAxeViolations(page);

  await page.getByRole("button", { name: "Use keyboard or touch" }).click();
  const settingsOpener = page.getByRole("button", { name: "Accessibility & settings" });
  await settingsOpener.click();
  const dialog = page.getByRole("dialog", { name: "Accessibility & settings" });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(page.getByRole("heading", { name: "Accessibility & settings" })).toBeFocused();
  await expectNoSeriousAxeViolations(page);

  const closeSettings = page.getByRole("button", { name: "Close settings" });
  await page.keyboard.press("Shift+Tab");
  await expect(closeSettings).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Preferred input" })).toBeFocused();

  await page.getByRole("checkbox", { name: "Prefer camera composition" }).check();
  await page.getByRole("checkbox", { name: "Mute game" }).check();
  await page.getByRole("checkbox", { name: "Reduce motion" }).check();
  await page.getByRole("checkbox", { name: "Screen shake" }).uncheck();
  await expect(page.locator(".experience-root")).toHaveAttribute("data-muted", "true");
  await expect(page.locator(".experience-root")).toHaveAttribute("data-reduced-motion", "true");
  await expect(page.locator(".experience-root")).toHaveAttribute(
    "data-screen-shake-enabled",
    "false",
  );

  await closeSettings.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Preferred input" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(closeSettings).toBeFocused();
  await closeSettings.click();
  await expect(settingsOpener).toBeFocused();

  const stored = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }, STORAGE_KEY);
  expect(stored).toMatchObject({
    calibration: null,
    schemaVersion: 2,
    settings: {
      cameraEnabled: true,
      controlPreference: "keyboard-touch",
      copyVersion: 1,
      muted: true,
      reducedMotion: true,
      screenShakeEnabled: false,
    },
  });
  expect(JSON.stringify(stored)).not.toMatch(/sample|recording|blob:|mediaStream/i);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Ready to run" })).toBeFocused();
  await page.getByRole("button", { name: "Start run" }).click();
  const surface = page.getByTestId("game-surface");
  await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
  await expect(surface).toHaveAttribute("data-muted", "true");
  await expect(surface).toHaveAttribute("data-reduced-motion", "true");
  await expect(surface).toHaveAttribute("data-screen-shake-enabled", "false");
  await surface.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: "touch",
  });
  await expect(surface).toHaveAttribute("data-active-input", "keyboard-touch");
  await surface.dispatchEvent("pointerup", {
    button: 0,
    buttons: 0,
    pointerId: 1,
    pointerType: "touch",
  });
  await page.getByRole("button", { name: "Pause run" }).click();
  await expect(surface).toHaveAttribute("data-simulation-phase", "paused");
  const pausedSettings = page.getByRole("button", { name: "Accessibility & settings" });
  await pausedSettings.click();
  await expect(dialog).toBeVisible();
  await expect(
    page.getByText(/Input preference and calibration can be changed after this run/),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Preferred input" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Calibrate microphone" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Return to paused run" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Take a breath" })).toBeVisible();
  await expect(pausedSettings).toBeFocused();
  await expect(surface).toHaveAttribute("data-simulation-phase", "paused");
  await pausedSettings.click();

  await page.evaluate(() => {
    localStorage.setItem("shouting-chickens.future-owned.v9", "remove");
    localStorage.setItem("another-app.preference", "preserve");
  });
  await page.getByRole("button", { name: "Reset local game data" }).click();
  await page.getByRole("button", { name: "Confirm reset" }).click();
  await expect(
    page.getByRole("heading", { name: "Play with your voice—or without it" }),
  ).toBeFocused();
  await expect(page.getByText(/Local game data cleared/)).toBeVisible();
  expect(
    await page.evaluate(() => ({
      gameKeys: Object.keys(localStorage).filter((key) => key.startsWith("shouting-chickens.")),
      unrelated: localStorage.getItem("another-app.preference"),
    })),
  ).toEqual({
    gameKeys: [],
    unrelated: "preserve",
  });
});

test("persists bests only after a real local results event", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Use keyboard or touch" }).click();
  await page.getByRole("button", { name: "Start run" }).click();
  const surface = page.getByTestId("game-surface");
  await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
  await expect(page.getByRole("heading", { name: "Nice flight" })).toBeFocused({
    timeout: 12_000,
  });

  const completed = await surface.evaluate((element) => ({
    score: Number(element.dataset.score),
    survivalMs: Number(element.dataset.elapsedMs),
  }));
  expect(completed.score).toBeGreaterThan(0);
  const statistics = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) {
      throw new Error("Missing persisted local game data");
    }
    return (JSON.parse(raw) as { statistics: Record<string, number> }).statistics;
  }, STORAGE_KEY);
  expect(statistics).toMatchObject({
    bestScore: completed.score,
    completedRuns: 1,
    longestSurvivalMs: completed.survivalMs,
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Ready to run" })).toBeFocused();
  const savedStats = page.getByRole("definition");
  await expect(savedStats.filter({ hasText: String(completed.score) })).toHaveCount(1);
});

test("recovers corrupt storage and keeps the keyboard path accessible", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "{not-json");
  }, STORAGE_KEY);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");

  await expect(page.getByText(/Saved game data was unreadable/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Use keyboard or touch" })).toBeEnabled();
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
  await expectNoSeriousAxeViolations(page);
});
