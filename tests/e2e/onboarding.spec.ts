/// <reference lib="dom" />

import { expect, test, type Page } from "@playwright/test";

type SyntheticMicrophoneState = {
  createdUrls: string[];
  dbfs: number;
  pauses: number;
  plays: number;
  recorderStarts: number;
  recorderStops: number;
  requests: number;
  revokedUrls: string[];
  stops: number;
};

async function installDeniedMicrophone(page: Page) {
  await page.addInitScript(() => {
    class DeniedAudioContext extends EventTarget {
      state: AudioContextState = "running";

      async close() {
        this.state = "closed";
      }

      async resume() {
        this.state = "running";
      }

      async suspend() {
        this.state = "suspended";
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: DeniedAudioContext,
    });

    let requests = 0;
    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        if (constraints.audio === false) {
          throw new DOMException("No synthetic camera", "NotFoundError");
        }

        requests += 1;
        (window as typeof window & { __micDenialRequests?: number }).__micDenialRequests = requests;
        throw new DOMException(
          requests === 1 ? "Synthetic denial" : "Synthetic unavailable",
          requests === 1 ? "NotAllowedError" : "NotFoundError",
        );
      },
    });
  });
}

async function installSyntheticMicrophone(page: Page) {
  await page.addInitScript(() => {
    const harness: SyntheticMicrophoneState = {
      createdUrls: [],
      dbfs: -60,
      pauses: 0,
      plays: 0,
      recorderStarts: 0,
      recorderStops: 0,
      requests: 0,
      revokedUrls: [],
      stops: 0,
    };
    (
      window as typeof window & { __syntheticMicrophone?: SyntheticMicrophoneState }
    ).__syntheticMicrophone = harness;

    class SyntheticTrack extends EventTarget {
      enabled = true;
      muted = false;
      readyState: MediaStreamTrackState = "live";
      readonly kind = "audio";

      stop() {
        this.readyState = "ended";
        harness.stops += 1;
      }

      getSettings(): MediaTrackSettings {
        return {
          autoGainControl: false,
          channelCount: 1,
          deviceId: "synthetic-microphone",
          echoCancellation: true,
          noiseSuppression: true,
        };
      }
    }

    class SyntheticStream {
      readonly track = new SyntheticTrack();

      getTracks() {
        return [this.track];
      }

      getAudioTracks() {
        return [this.track];
      }

      getVideoTracks() {
        return [];
      }
    }

    class SyntheticMediaRecorder extends EventTarget {
      readonly mimeType = "audio/webm";
      state: RecordingState = "inactive";

      constructor(readonly stream: SyntheticStream) {
        super();
      }

      start() {
        this.state = "recording";
        harness.recorderStarts += 1;
      }

      stop() {
        if (this.state === "inactive") {
          return;
        }
        this.state = "inactive";
        harness.recorderStops += 1;
        queueMicrotask(() => {
          const dataEvent = new Event("dataavailable") as Event & { data: Blob };
          Object.defineProperty(dataEvent, "data", {
            value: new Blob(["synthetic calibration voice"], { type: this.mimeType }),
          });
          this.dispatchEvent(dataEvent);
          this.dispatchEvent(new Event("stop"));
        });
      }
    }

    class SyntheticNode {
      connect() {}
      disconnect() {}
    }

    class SyntheticAnalyser extends SyntheticNode {
      fftSize = 256;
      smoothingTimeConstant = 0;

      getFloatTimeDomainData(buffer: Float32Array) {
        buffer.fill(10 ** (harness.dbfs / 20));
      }
    }

    class SyntheticAudioContext extends EventTarget {
      state: AudioContextState = "running";

      createMediaStreamSource() {
        return new SyntheticNode();
      }

      createAnalyser() {
        return new SyntheticAnalyser();
      }

      async resume() {
        this.state = "running";
        this.dispatchEvent(new Event("statechange"));
      }

      async suspend() {
        this.state = "suspended";
        this.dispatchEvent(new Event("statechange"));
      }

      async close() {
        this.state = "closed";
        this.dispatchEvent(new Event("statechange"));
      }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: SyntheticAudioContext,
    });
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: SyntheticMediaRecorder,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => {
        const url = `blob:synthetic-calibration-${harness.createdUrls.length + 1}`;
        harness.createdUrls.push(url);
        return url;
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: (url: string) => {
        harness.revokedUrls.push(url);
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value() {
        harness.plays += 1;
        return Promise.resolve();
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value() {
        harness.pauses += 1;
      },
    });

    const mediaDevices = {
      addEventListener() {},
      async enumerateDevices() {
        return [];
      },
      async getUserMedia(constraints: MediaStreamConstraints) {
        if (constraints.audio === false) {
          throw new DOMException("No synthetic camera", "NotFoundError");
        }
        harness.requests += 1;
        return new SyntheticStream();
      },
      removeEventListener() {},
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });
  });
}

async function setSyntheticDb(page: Page, dbfs: number) {
  await page.evaluate((nextDb) => {
    const harnessWindow = window as typeof window & {
      __syntheticMicrophone?: SyntheticMicrophoneState;
    };
    const harness = harnessWindow.__syntheticMicrophone;
    if (!harness) {
      throw new Error("Synthetic microphone was not installed");
    }
    harness.dbfs = nextDb;
  }, dbfs);
}

async function syntheticMicrophoneSnapshot(page: Page): Promise<SyntheticMicrophoneState> {
  return page.evaluate(() => {
    const harness = (window as typeof window & { __syntheticMicrophone?: SyntheticMicrophoneState })
      .__syntheticMicrophone;
    if (!harness) {
      throw new Error("Synthetic microphone was not installed");
    }
    return structuredClone(harness);
  });
}

test("first run is keyboard reachable and fallback reaches pause, results, and restart", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const heading = page.getByRole("heading", { name: "Play with your voice—or without it" });
  await expect(heading).toBeFocused();
  await expect(page.getByText(/never need to scream/i)).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Enable microphone" })).toBeFocused();
  await page.keyboard.press("Tab");
  const fallback = page.getByRole("button", { name: "Use keyboard or touch" });
  await expect(fallback).toBeFocused();

  for (const button of [page.getByRole("button", { name: "Enable microphone" }), fallback]) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }

  await fallback.click();
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByText("3")).toBeVisible();
  const surface = page.getByTestId("game-surface");
  await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
  await expect(surface).toHaveAttribute("data-configured-input", "keyboard-touch");

  await page.getByRole("button", { name: "Pause run" }).click();
  await expect(page.getByRole("heading", { name: "Take a breath" })).toBeFocused();
  await expect(surface).toHaveAttribute("data-simulation-phase", "paused");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Accessibility & settings" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Resume run" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
  await expect(page.getByRole("button", { name: "Pause run" })).toBeFocused();

  await expect(page.getByRole("heading", { name: "Nice flight" })).toBeFocused({
    timeout: 12_000,
  });
  await page.keyboard.press("Space");
  await expect(surface).toHaveAttribute("data-simulation-phase", "dead");
  const completedRun = await surface.evaluate((element) => ({
    elapsedMs: Number(element.getAttribute("data-elapsed-ms")),
    generation: Number(element.getAttribute("data-run-generation")),
    restartToken: Number(element.getAttribute("data-restart-token")),
    score: Number(element.getAttribute("data-score")),
  }));
  expect(completedRun.elapsedMs).toBeGreaterThan(0);
  expect(completedRun.generation).toBeGreaterThan(0);
  expect(completedRun.restartToken).toBeGreaterThanOrEqual(0);
  expect(completedRun.score).toBe(Math.floor(completedRun.elapsedMs / 100));

  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Accessibility & settings" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Restart run" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(surface).toHaveAttribute(
    "data-restart-token",
    String(completedRun.restartToken + 1),
  );
  await expect(surface).toHaveAttribute("data-run-generation", String(completedRun.generation + 1));
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
  const restartedRun = await surface.evaluate((element) => ({
    collisionId: element.getAttribute("data-collision-id"),
    deathReason: element.getAttribute("data-death-reason"),
    elapsedMs: Number(element.getAttribute("data-elapsed-ms")),
    loopsCompleted: Number(element.getAttribute("data-loops-completed")),
    phase: element.getAttribute("data-simulation-phase"),
    score: Number(element.getAttribute("data-score")),
  }));
  expect(restartedRun).toMatchObject({
    collisionId: "",
    deathReason: "",
    loopsCompleted: 0,
    phase: "running",
  });
  expect(restartedRun.elapsedMs).toBeLessThan(completedRun.elapsedMs);
  expect(restartedRun.score).toBe(Math.floor(restartedRun.elapsedMs / 100));
  expect(restartedRun.score).toBeLessThan(completedRun.score);
});

test("permission denial can be retried before choosing fallback", async ({ page }) => {
  await installDeniedMicrophone(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.getByRole("button", { name: "Enable microphone" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __micDenialRequests?: number }).__micDenialRequests,
      ),
    )
    .toBe(1);
  await expect(page.getByRole("alert")).toContainText("permission was denied");
  await page.getByRole("button", { name: "Try microphone again" }).click();
  await expect(page.getByRole("alert")).toContainText("No usable microphone");
  expect(
    await page.evaluate(
      () => (window as typeof window & { __micDenialRequests?: number }).__micDenialRequests,
    ),
  ).toBe(2);

  await page.getByRole("button", { name: "Use keyboard or touch" }).click();
  await expect(page.getByRole("heading", { name: "Ready to run" })).toBeFocused();
  await expect(page.getByText("Keyboard + touch ready")).toBeVisible();
});

test("a rejected runtime mount leaves the semantic recovery action clickable", async ({ page }) => {
  await page.addInitScript(() => {
    const scope = window as typeof window & {
      __SHOUTING_CHICKENS_TEST_PROPS__?: Record<string, unknown>;
    };
    scope.__SHOUTING_CHICKENS_TEST_PROPS__ = {
      countdownStepMs: 5,
      createRuntime: () => {
        let listener:
          | ((event: {
              error: {
                code: string;
                message: string;
                recoverable: boolean;
              };
              type: "fatal-error";
            }) => void)
          | null = null;
        return {
          destroy() {},
          async mount() {
            listener?.({
              error: {
                code: "render-failed",
                message: "Synthetic browser mount failure",
                recoverable: true,
              },
              type: "fatal-error",
            });
            throw new Error("Synthetic browser mount rejection");
          },
          pause() {},
          restart() {},
          resume() {},
          setActiveInput() {},
          startRun() {},
          subscribe(nextListener: typeof listener) {
            listener = nextListener;
            return () => {
              listener = null;
            };
          },
        };
      },
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Use keyboard or touch" }).click();
  await page.getByRole("button", { name: "Start run" }).click();

  await expect(page.getByRole("heading", { name: "The course could not start" })).toBeVisible();
  await expect(page.getByText("Synthetic browser mount failure")).toBeVisible();
  const recovery = page.getByRole("button", { name: "Return to ready screen" });
  await expect(recovery).toBeEnabled();
  await recovery.click();
  await expect(page.getByRole("heading", { name: "Ready to run" })).toBeFocused();
});

test("synthetic scalar input retries only invalid stages and drives the Phaser meter", async ({
  page,
}) => {
  await installSyntheticMicrophone(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Enable microphone" }).click();
  await expect(
    page.getByRole("heading", { name: "Calibrate your comfortable range" }),
  ).toBeFocused();
  const liveMeter = page.getByRole("meter", { name: "Live microphone activity" });
  await expect(liveMeter).toBeVisible();

  await setSyntheticDb(page, -40);
  await expect.poll(async () => Number(await liveMeter.getAttribute("value"))).toBeGreaterThan(0.5);
  await page.getByRole("button", { name: "Capture quiet" }).click();
  await expect(page.getByRole("button", { name: /Recording/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next: comfortable voice" })).toBeEnabled();
  await setSyntheticDb(page, -39);
  await page.getByRole("button", { name: "Next: comfortable voice" }).click();
  await expect(page.getByRole("alert")).toContainText(/too close/i);
  await setSyntheticDb(page, -20);
  await page.getByRole("button", { name: "Retry comfortable voice" }).click();
  await expect(page.getByRole("button", { name: "Next: strong voice" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Play recorded voice" })).toBeEnabled();
  await setSyntheticDb(page, -18);
  await page.getByRole("button", { name: "Next: strong voice" }).click();
  await expect(page.getByRole("alert")).toContainText(/too close/i);
  await setSyntheticDb(page, -5);
  await page.getByRole("button", { name: "Retry strong voice" }).click();
  await expect(page.getByRole("button", { name: "Use this calibration" })).toBeEnabled();
  await page.getByRole("button", { name: "Use this calibration" }).click();
  await expect(page.getByRole("heading", { name: "Ready to run" })).toBeFocused();
  await expect(page.getByText(/Microphone \+ fallback controls/)).toBeVisible();
  await page.getByRole("button", { name: "Test your voice" }).click();
  await expect(page.getByRole("button", { name: "Stop voice test" })).toBeVisible();
  await expect(page.getByText(/Signal quality: Good/)).toBeVisible();
  await page.getByRole("button", { name: "Stop voice test" }).click();

  await page.getByRole("button", { name: "Start run" }).click();
  const surface = page.getByTestId("game-surface");
  await expect(surface).toHaveAttribute("data-runtime-state", "mounted");
  await expect(surface).toHaveAttribute("data-configured-input", "voice");
  await setSyntheticDb(page, -40);
  await expect
    .poll(async () => Number(await surface.getAttribute("data-input-level")))
    .toBeLessThan(0.05);
  await expect(surface).toHaveAttribute("data-active-input", "voice");

  await page.keyboard.down("Space");
  await expect(surface).toHaveAttribute("data-active-input", "keyboard-touch");
  await expect
    .poll(async () => Number(await surface.getAttribute("data-input-level")))
    .toBeGreaterThan(0.9);
  await page.keyboard.up("Space");

  await setSyntheticDb(page, -10);
  await expect
    .poll(async () => Number(await surface.getAttribute("data-input-level")))
    .toBeGreaterThan(0.5);

  await setSyntheticDb(page, -120);
  await expect(page.getByRole("heading", { name: "Nice flight" })).toBeFocused({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Restart run" }).click();
  await expect(surface).toHaveAttribute("data-simulation-phase", "running");
});

test("calibration playback reuses one stream and cleans up on advance and fallback", async ({
  page,
}) => {
  await installSyntheticMicrophone(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Enable microphone" }).click();
  await expect(
    page.getByRole("heading", { name: "Calibrate your comfortable range" }),
  ).toBeFocused();

  await setSyntheticDb(page, -60);
  await page.getByRole("button", { name: "Capture quiet" }).click();
  await expect(page.getByRole("button", { name: "Next: comfortable voice" })).toBeEnabled();

  // Reproduce human reaction time: the stage begins on room tone and the
  // player's comfortable voice arrives after the button click.
  await page.getByRole("button", { name: "Next: comfortable voice" }).click();
  await page.waitForTimeout(350);
  await expect(page.getByRole("button", { name: /Recording/ })).toBeDisabled();
  await setSyntheticDb(page, -30);
  await expect(page.getByRole("button", { name: "Next: strong voice" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Play recorded voice" })).toBeEnabled();

  await page.getByRole("button", { name: "Play recorded voice" }).click();
  await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
  await page.getByRole("button", { name: "Next: strong voice" }).click();
  await expect
    .poll(async () => (await syntheticMicrophoneSnapshot(page)).revokedUrls)
    .toContain("blob:synthetic-calibration-1");

  await page.waitForTimeout(300);
  await expect(page.getByRole("button", { name: /Recording/ })).toBeDisabled();
  await setSyntheticDb(page, -10);
  await expect(page.getByRole("button", { name: "Use this calibration" })).toBeEnabled();
  await page.getByRole("button", { name: "Play recorded voice" }).click();
  await expect(page.getByRole("button", { name: "Stop playback" })).toBeVisible();
  await page.getByRole("button", { name: "Use keyboard or touch" }).click();
  await expect(page.getByRole("heading", { name: "Ready to run" })).toBeFocused();

  await expect
    .poll(async () => (await syntheticMicrophoneSnapshot(page)).revokedUrls)
    .toEqual(["blob:synthetic-calibration-1", "blob:synthetic-calibration-2"]);
  const harness = await syntheticMicrophoneSnapshot(page);
  expect(harness.requests).toBe(1);
  expect(harness.recorderStarts).toBe(2);
  expect(harness.recorderStops).toBe(2);
  expect(harness.plays).toBe(2);
  expect(harness.pauses).toBeGreaterThanOrEqual(2);
});
