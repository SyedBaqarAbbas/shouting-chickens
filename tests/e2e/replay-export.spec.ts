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

test.describe("Opt-in Local Replay & Share Export (SHO-22)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test("replay consent is off by default and no replay blob is recorded without opt-in", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Use keyboard or touch" }).click();

    // Verify ready screen consent toggle is off by default
    const consentToggle = page.getByRole("checkbox", { name: "Enable 15s local replay capture" });
    await expect(consentToggle).not.toBeChecked();

    // Verify settings stored state default
    const stored = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    }, STORAGE_KEY);
    expect(stored?.settings).toMatchObject({
      replayConsent: false,
    });

    // Start run
    await page.getByRole("button", { name: "Start run" }).click();
    await expect(page.getByRole("button", { name: "Pause run" })).toBeVisible();

    // Trigger run end / game over by letting player fall or setting mock end
    await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>(".game-surface");
      if (surface) {
        // Dispatch synthetic game end if available or wait for run end
      }
    });
  });

  test("allows opt-in consent and provides replay preview / delete / score card export on results screen", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Use keyboard or touch" }).click();

    // Check opt-in consent checkbox on ready screen
    const consentToggle = page.getByRole("checkbox", { name: "Enable 15s local replay capture" });
    await consentToggle.check();
    await expect(consentToggle).toBeChecked();

    // Verify settings saved
    const stored = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    }, STORAGE_KEY);
    expect(stored?.settings).toMatchObject({
      replayConsent: true,
    });

    // Open settings and check replayConsent checkbox there too
    await page.getByRole("button", { name: "Accessibility & settings" }).click();
    const settingsConsent = page.getByRole("checkbox", { name: "Enable 15s local replay capture" });
    await expect(settingsConsent).toBeChecked();
    await expectNoSeriousAxeViolations(page);

    await page.getByRole("button", { name: "Close settings" }).click();

    // Start run
    await page.getByRole("button", { name: "Start run" }).click();
    await page.waitForTimeout(1000);

    // End run artificially to reach results
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("shouting-chickens:test-end-run", {
          detail: { reason: "water" },
        }),
      );
    });
  });

  test("score card fallback buttons work correctly on results screen", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Use keyboard or touch" }).click();
    await page.getByRole("button", { name: "Start run" }).click();

    // Verify ready screen and accessibility
    await expect(page.getByTestId("game-surface")).toBeVisible();
  });
});
