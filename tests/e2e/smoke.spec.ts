import { expect, test } from "@playwright/test";

test("boots the React shell and one Phaser canvas", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Shouting Chickens" })).toBeVisible();
  await expect(page.getByText("Game engine ready")).toBeVisible();
  await expect(page.locator("#game-container canvas")).toHaveCount(1);
});
