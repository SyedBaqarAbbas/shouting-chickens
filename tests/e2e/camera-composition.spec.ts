/// <reference lib="dom" />

import { expect, test, type Page } from "@playwright/test";

type SyntheticCameraMode = "allow" | "deny" | "unavailable";

interface CameraHarnessState {
  requests: MediaStreamConstraints[];
  stops: number;
}

async function installSyntheticCamera(page: Page, mode: SyntheticCameraMode) {
  await page.addInitScript((cameraMode) => {
    const harnessWindow = window as typeof window & {
      __cameraHarness?: CameraHarnessState;
    };
    const harness: CameraHarnessState = {
      requests: [],
      stops: 0,
    };
    harnessWindow.__cameraHarness = harness;

    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        harness.requests.push(structuredClone(constraints));

        if (cameraMode === "deny") {
          throw new DOMException("Synthetic permission denial", "NotAllowedError");
        }
        if (cameraMode === "unavailable") {
          throw new DOMException("Synthetic camera unavailable", "NotFoundError");
        }

        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 960;
        const context = canvas.getContext("2d");
        if (!context) {
          throw new DOMException("Synthetic canvas unavailable", "NotReadableError");
        }
        context.fillStyle = "#31576f";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#f4ce64";
        context.beginPath();
        context.arc(210, 280, 120, 0, Math.PI * 2);
        context.fill();

        const stream = canvas.captureStream(5);
        const track = stream.getVideoTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => {
          harness.stops += 1;
          stop();
        };
        return stream;
      },
    });
  }, mode);
}

async function cameraHarness(page: Page): Promise<CameraHarnessState> {
  return page.evaluate(() => {
    const harnessWindow = window as typeof window & {
      __cameraHarness?: CameraHarnessState;
    };
    if (!harnessWindow.__cameraHarness) {
      throw new Error("Synthetic camera harness was not installed");
    }
    return harnessWindow.__cameraHarness;
  });
}

async function expectMountedGame(page: Page) {
  const surface = page.getByTestId("game-surface");
  await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
  await expect(surface.locator("canvas")).toHaveCount(1);
  return surface;
}

test("camera starts disabled and never prompts before the enable gesture", async ({ page }) => {
  await installSyntheticCamera(page, "allow");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expectMountedGame(page);
  await expect(page.getByRole("button", { name: "Camera off · Enable" })).toBeEnabled();
  await expect(page.locator("#camera-status")).toContainText("Camera off");
  await expect(page.getByTestId("camera-video")).toHaveCount(0);
  expect((await cameraHarness(page)).requests).toEqual([]);
});

test("an allowed synthetic camera is cover-fit and only its video is mirrored", async ({
  page,
}) => {
  await installSyntheticCamera(page, "allow");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const surface = await expectMountedGame(page);

  await page.getByRole("button", { name: "Camera off · Enable" }).click();
  await expect(page.locator("#camera-status")).toContainText("Camera on");

  const video = page.getByTestId("camera-video");
  await expect(video).toBeVisible();
  const videoStyle = await video.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      objectFit: style.objectFit,
      transform: style.transform,
    };
  });
  const canvasTransform = await surface
    .locator("canvas")
    .evaluate((canvas) => getComputedStyle(canvas).transform);

  expect(videoStyle.objectFit).toBe("cover");
  expect(videoStyle.transform).not.toBe("none");
  expect(canvasTransform).toBe("none");
  expect(
    await video.evaluate(
      (element) => (element as HTMLVideoElement).srcObject instanceof MediaStream,
    ),
  ).toBe(true);

  const harness = await cameraHarness(page);
  expect(harness.requests).toHaveLength(1);
  expect(harness.requests[0]).toMatchObject({ audio: false });
  expect(harness.requests[0]?.video).not.toBe(false);
});

test("camera denial and unavailability preserve the running game fallback", async ({ page }) => {
  for (const scenario of [
    { mode: "deny", copy: /permission was denied/ },
    { mode: "unavailable", copy: /Camera is unavailable/ },
  ] as const) {
    await installSyntheticCamera(page, scenario.mode);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const surface = await expectMountedGame(page);

    await page.getByRole("button", { name: "Camera off · Enable" }).click();
    await expect(page.locator("#camera-status")).toContainText(scenario.copy);
    await expect(
      page.getByRole("button", {
        name: scenario.mode === "deny" ? "Camera denied · Retry" : "Camera unavailable · Retry",
      }),
    ).toBeEnabled();
    await expect(page.getByTestId("camera-video")).toHaveCount(0);
    await expect(surface).toHaveAttribute("data-simulation-phase", "running");

    const harness = await cameraHarness(page);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({ audio: false });
  }
});

test("turning the camera off stops its video track without restarting play", async ({ page }) => {
  await installSyntheticCamera(page, "allow");
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto("/");
  const surface = await expectMountedGame(page);

  await page.getByRole("button", { name: "Camera off · Enable" }).click();
  await expect(page.getByTestId("camera-video")).toBeVisible();
  await page.getByRole("button", { name: "Camera on · Turn off" }).click();

  await expect(page.locator("#camera-status")).toContainText("Camera stopped");
  await expect(page.getByTestId("camera-video")).toHaveCount(0);
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
  expect((await cameraHarness(page)).stops).toBe(1);
});

for (const viewport of [
  { name: "390 x 844", width: 390, height: 844 },
  { name: "430 x 932", width: 430, height: 932 },
]) {
  test(`keeps camera controls inside the safe portrait frame at ${viewport.name}`, async ({
    page,
  }) => {
    await installSyntheticCamera(page, "allow");
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expectMountedGame(page);

    const phone = page.locator(".game-phone");
    const control = page.locator(".camera-control");
    const heading = page.locator(".game-heading");
    const headingEyebrow = heading.locator(".eyebrow");
    const surface = page.getByTestId("game-surface");
    const phoneBox = await phone.boundingBox();
    const controlBox = await control.boundingBox();
    const headingBox = await heading.boundingBox();
    const eyebrowBox = await headingEyebrow.boundingBox();
    const surfaceBox = await surface.boundingBox();

    expect(phoneBox).not.toBeNull();
    expect(controlBox).not.toBeNull();
    expect(headingBox).not.toBeNull();
    expect(eyebrowBox).not.toBeNull();
    expect(surfaceBox).not.toBeNull();
    expect(controlBox!.x).toBeGreaterThanOrEqual(phoneBox!.x + 9);
    expect(controlBox!.y).toBeGreaterThanOrEqual(phoneBox!.y + 9);
    expect(controlBox!.x + controlBox!.width).toBeLessThanOrEqual(
      phoneBox!.x + phoneBox!.width - 9,
    );
    expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(eyebrowBox!.y - 4);
    const phaserHintTop = surfaceBox!.y + (180 / 768) * surfaceBox!.height;
    expect(headingBox!.y + headingBox!.height).toBeLessThanOrEqual(phaserHintTop);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      "content",
      /viewport-fit=cover/,
    );
  });
}

test("uses one shared landscape pause and restores the portrait composition on resize", async ({
  page,
}) => {
  await installSyntheticCamera(page, "allow");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const surface = await expectMountedGame(page);
  await page.getByRole("button", { name: "Camera off · Enable" }).click();
  await expect(page.getByTestId("camera-video")).toBeVisible();

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByText("Rotate your device to play")).toBeVisible();
  await expect(page.getByRole("button", { name: "Camera on · Turn off" })).toBeHidden();
  await expect(surface).toHaveAttribute("data-simulation-phase", "paused");
  await expect(page.locator(".game-phone")).toHaveAttribute("data-orientation", "landscape");
  await expect.poll(async () => (await cameraHarness(page)).stops).toBe(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("Rotate your device to play")).toBeHidden();
  await expect(page.getByRole("button", { name: "Camera off · Enable" })).toBeVisible();
  await expect(page.getByTestId("camera-video")).toHaveCount(0);
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
});

test("keeps a centered portrait letterbox on desktop", async ({ page }) => {
  await installSyntheticCamera(page, "allow");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expectMountedGame(page);

  const phoneBox = await page.locator(".game-phone").boundingBox();
  expect(phoneBox).not.toBeNull();
  expect(phoneBox!.width).toBeLessThanOrEqual(432);
  expect(phoneBox!.height).toBeLessThanOrEqual(768);
  expect(phoneBox!.width / phoneBox!.height).toBeCloseTo(9 / 16, 2);
  expect(Math.abs(phoneBox!.x + phoneBox!.width / 2 - 720)).toBeLessThan(2);
});
