import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("the installed shell has valid metadata and starts a fresh local run with the network offline", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./", { waitUntil: "networkidle" });
  const baseUrl = new URL("./", page.url()).href;
  await waitForServiceWorkerControl(page);

  const manifestResponse = await request.get(new URL("manifest.webmanifest", baseUrl).href);
  expect(manifestResponse.ok()).toBe(true);
  const manifest = (await manifestResponse.json()) as {
    id: string;
    start_url: string;
    scope: string;
    display: string;
    background_color: string;
    theme_color: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };
  expect(manifest).toMatchObject({
    id: "./",
    start_url: "./",
    scope: "./",
    display: "standalone",
    background_color: "#081426",
    theme_color: "#081426",
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", purpose: "any", type: "image/png" }),
      expect.objectContaining({ sizes: "512x512", purpose: "any", type: "image/png" }),
      expect.objectContaining({ sizes: "512x512", purpose: "maskable", type: "image/png" }),
    ]),
  );

  await expectInstallableInPersistentChromium(baseUrl);

  const cachedUrls = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const release = (await (
      await fetch(new URL("./pwa-release.json", registration.scope))
    ).json()) as { cacheName: string; assets: string[] };
    const cache = await caches.open(release.cacheName);
    return {
      actual: (await cache.keys()).map((entry) => entry.url).sort(),
      expected: release.assets.map((asset) => new URL(asset, registration.scope).href).sort(),
    };
  });
  expect(cachedUrls.actual).toEqual(cachedUrls.expected);
  expect(cachedUrls.actual.some((url) => /(?:replays?|reports?|\/api\/)/i.test(url))).toBe(false);

  await page.close();
  await context.setOffline(true);
  const offlinePage = await context.newPage();
  const failedRequests: string[] = [];
  offlinePage.on("requestfailed", (request) => {
    failedRequests.push(request.url());
  });
  try {
    await offlinePage.setViewportSize({ width: 390, height: 844 });
    const offlineDeepLink = new URL("flight/deep-link", baseUrl).href;
    await offlinePage.goto(offlineDeepLink, {
      waitUntil: "domcontentloaded",
    });
    await expect(offlinePage).toHaveURL(offlineDeepLink);
    await expect(offlinePage.locator(".site-release")).toContainText("Version");

    const privacyPage = await context.newPage();
    const privacyFailures: string[] = [];
    privacyPage.on("requestfailed", (request) => {
      privacyFailures.push(request.url());
    });
    try {
      await privacyPage.goto(new URL("privacy/", baseUrl).href, {
        waitUntil: "domcontentloaded",
      });
      await expect(privacyPage.getByRole("heading", { name: "Privacy" })).toBeVisible();
      expect(privacyFailures).toEqual([]);
    } finally {
      await privacyPage.close();
    }

    await offlinePage.getByRole("button", { name: "Use keyboard or touch" }).click();
    await offlinePage.getByRole("button", { name: "Start run" }).click();
    const surface = offlinePage.getByTestId("game-surface");
    await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
    await expect(surface).toHaveAttribute("data-simulation-phase", "running");
    const offlineCacheUrls = await offlinePage.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const release = (await (
        await fetch(new URL("./pwa-release.json", registration.scope))
      ).json()) as { cacheName: string; assets: string[] };
      return (await (await caches.open(release.cacheName)).keys()).map((entry) => entry.url).sort();
    });
    expect(offlineCacheUrls).toEqual(cachedUrls.expected);
    expect(failedRequests).toEqual([]);
  } finally {
    await context.setOffline(false);
    await offlinePage.close();
  }
});

test("a waiting worker stays deferred through the active run and applies only on confirmation", async ({
  page,
}) => {
  test.setTimeout(75_000);
  const workerPath = resolve(process.cwd(), "dist/service-worker.js");
  const indexPath = resolve(process.cwd(), "dist/index.html");
  const releasePath = resolve(process.cwd(), "dist/pwa-release.json");
  const originalWorker = await readFile(workerPath, "utf8");
  const originalIndex = await readFile(indexPath, "utf8");
  const release = JSON.parse(await readFile(releasePath, "utf8")) as {
    version: string;
    commitSha: string;
    cacheName: string;
  };
  const activeReleaseId = `${release.version}:${release.commitSha}`;
  const waitingReleaseId = `${activeReleaseId}:deferred-update-e2e`;
  const waitingCacheName = `${release.cacheName}-deferred-update-e2e`;
  const updatedWorker = originalWorker
    .replace(
      `const RELEASE_ID = ${JSON.stringify(activeReleaseId)};`,
      `const RELEASE_ID = ${JSON.stringify(waitingReleaseId)};`,
    )
    .replace(
      `const CACHE_NAME = ${JSON.stringify(release.cacheName)};`,
      `const CACHE_NAME = ${JSON.stringify(waitingCacheName)};`,
    );
  expect(updatedWorker).not.toBe(originalWorker);
  const updatedShellMarker = "deferred-update-shell-e2e";
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("./", { waitUntil: "networkidle" });
    await waitForServiceWorkerControl(page);
    await page.getByRole("button", { name: "Use keyboard or touch" }).click();
    await page.getByRole("button", { name: "Start run" }).click();
    await expect(page.locator(".experience-root")).toHaveAttribute("data-run-active", "true");
    await expect(page.getByTestId("game-surface")).toHaveAttribute(
      "data-simulation-phase",
      "running",
    );
    await page.evaluate(() => {
      (window as typeof window & { __PWA_ACTIVE_RUN_MARKER__?: string }).__PWA_ACTIVE_RUN_MARKER__ =
        "preserved";
    });

    await writeFile(indexPath, `${originalIndex}\n<!-- ${updatedShellMarker} -->\n`, "utf8");
    await writeFile(workerPath, updatedWorker, "utf8");
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        throw new Error("Missing service worker registration");
      }
      await registration.update();
    });
    await expect
      .poll(() =>
        page.evaluate(async () =>
          Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
        ),
      )
      .toBe(true);

    await expect
      .poll(() =>
        page.evaluate(async (cacheName) => {
          const keys = await caches.keys();
          return keys.includes(cacheName);
        }, waitingCacheName),
      )
      .toBe(true);
    const shellStateDuringRun = await page.evaluate(
      async ({ activeCacheName, marker, waitingName }) => {
        const registration = await navigator.serviceWorker.ready;
        const shellUrl = new URL("./index.html", registration.scope);
        const controlledShell = await (await fetch(shellUrl)).text();
        const waitingShell = await (
          await (await caches.open(waitingName)).match(shellUrl.href)
        )?.text();
        return {
          activeCachePresent: (await caches.keys()).includes(activeCacheName),
          controlledHasUpdate: controlledShell.includes(marker),
          waitingHasUpdate: waitingShell?.includes(marker) ?? false,
        };
      },
      {
        activeCacheName: release.cacheName,
        marker: updatedShellMarker,
        waitingName: waitingCacheName,
      },
    );
    expect(shellStateDuringRun).toEqual({
      activeCachePresent: true,
      controlledHasUpdate: false,
      waitingHasUpdate: true,
    });
    await expect(page.getByText("Game update ready")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __PWA_ACTIVE_RUN_MARKER__?: string })
              .__PWA_ACTIVE_RUN_MARKER__,
        ),
      )
      .toBe("preserved");
    await expect(page.getByRole("heading", { name: "Nice flight" })).toBeFocused({
      timeout: 35_000,
    });
    await expect(page.locator(".experience-root")).toHaveAttribute("data-run-active", "false");
    await expect(page.getByText("Game update ready")).toBeVisible();
    const updateButton = page.getByRole("button", { name: "Update now" });
    expect(
      await updateButton.evaluate(
        (button) => button.closest('[role="dialog"]')?.getAttribute("aria-labelledby") ?? null,
      ),
    ).toBe("results-title");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Restart run" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(updateButton).toBeFocused();

    const reloaded = page.waitForEvent("framenavigated");
    await page.keyboard.press("Enter");
    await reloaded;
    await expect(page.locator(".site-release")).toContainText("Version");
    await expect(page.getByText("Game update ready")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(async (marker) => {
          const registration = await navigator.serviceWorker.ready;
          return (await (await fetch(new URL("./index.html", registration.scope))).text()).includes(
            marker,
          );
        }, updatedShellMarker),
      )
      .toBe(true);
    expect(await page.evaluate(() => caches.keys())).toEqual([waitingCacheName]);
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __PWA_ACTIVE_RUN_MARKER__?: string })
            .__PWA_ACTIVE_RUN_MARKER__,
      ),
    ).toBeUndefined();
  } finally {
    await writeFile(indexPath, originalIndex, "utf8");
    await writeFile(workerPath, originalWorker, "utf8");
  }
});

async function waitForServiceWorkerControl(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) {
      return;
    }
    await new Promise<void>((resolveControlled) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolveControlled(), {
        once: true,
      });
    });
  });
}

async function expectInstallableInPersistentChromium(baseUrl: string) {
  const profile = await mkdtemp(resolve(tmpdir(), "shouting-chickens-installability-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await waitForServiceWorkerControl(page);
    const cdp = await context.newCDPSession(page);
    const appManifest = await cdp.send("Page.getAppManifest");
    expect(appManifest.url).toBe(new URL("manifest.webmanifest", baseUrl).href);
    expect(appManifest.errors).toEqual([]);
    const installability = await cdp.send("Page.getInstallabilityErrors");
    expect(installability.installabilityErrors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { force: true, recursive: true });
  }
}
