import type { Page } from "@playwright/test";

export type SyntheticMediaOptions = {
  readonly camera?: "allow" | "deny" | "unavailable";
  readonly microphone?: "allow" | "deny" | "unavailable";
};

export type SyntheticMediaSnapshot = {
  readonly cameraMode: "allow" | "deny" | "unavailable";
  readonly cameraRequests: number;
  readonly microphoneMode: "allow" | "deny" | "unavailable";
  readonly microphoneRequests: number;
  readonly microphoneStops: number;
  readonly workletUrls: readonly string[];
};

export async function installSyntheticMedia(page: Page, options: SyntheticMediaOptions = {}) {
  await page.addInitScript((initialOptions) => {
    type MediaMode = "allow" | "deny" | "unavailable";
    type Harness = {
      cameraMode: MediaMode;
      cameraRequests: number;
      dbfs: number;
      microphoneMode: MediaMode;
      microphoneRequests: number;
      microphoneStops: number;
      visibility: DocumentVisibilityState;
      workletUrls: string[];
      setDbfs(value: number): void;
      setMicrophoneMode(value: MediaMode): void;
      setVisibility(value: DocumentVisibilityState): void;
    };

    const harness: Harness = {
      cameraMode: initialOptions.camera ?? "deny",
      cameraRequests: 0,
      dbfs: -60,
      microphoneMode: initialOptions.microphone ?? "allow",
      microphoneRequests: 0,
      microphoneStops: 0,
      visibility: "visible",
      workletUrls: [],
      setDbfs(value) {
        harness.dbfs = value;
      },
      setMicrophoneMode(value) {
        harness.microphoneMode = value;
      },
      setVisibility(value) {
        harness.visibility = value;
        document.dispatchEvent(new Event("visibilitychange"));
      },
    };
    (
      window as typeof window & {
        __releaseMediaHarness?: Harness;
      }
    ).__releaseMediaHarness = harness;

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => harness.visibility,
    });

    class SyntheticTrack extends EventTarget {
      enabled = true;
      muted = false;
      readyState: MediaStreamTrackState = "live";

      constructor(readonly kind: "audio" | "video") {
        super();
      }

      stop() {
        if (this.readyState === "ended") {
          return;
        }
        this.readyState = "ended";
        if (this.kind === "audio") {
          harness.microphoneStops += 1;
        }
        this.dispatchEvent(new Event("ended"));
      }

      getSettings(): MediaTrackSettings {
        return this.kind === "audio"
          ? {
              autoGainControl: false,
              channelCount: 1,
              deviceId: "release-synthetic-microphone",
              echoCancellation: true,
              noiseSuppression: true,
            }
          : {
              deviceId: "release-synthetic-camera",
              facingMode: "user",
              height: 960,
              width: 640,
            };
      }
    }

    class SyntheticStream {
      constructor(private readonly track: SyntheticTrack) {}

      getTracks() {
        return [this.track];
      }

      getAudioTracks() {
        return this.track.kind === "audio" ? [this.track] : [];
      }

      getVideoTracks() {
        return this.track.kind === "video" ? [this.track] : [];
      }
    }

    class SyntheticNode extends EventTarget {
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

    class SyntheticMessagePort extends EventTarget {
      private interval: number | undefined;

      start() {
        if (this.interval !== undefined) {
          return;
        }
        this.interval = window.setInterval(() => {
          const rms = 10 ** (harness.dbfs / 20);
          this.dispatchEvent(
            new MessageEvent("message", {
              data: {
                clipped: rms >= 0.995,
                dbfs: harness.dbfs,
                peak: rms,
                rms,
                type: "voice-energy",
              },
            }),
          );
        }, 16);
      }

      close() {
        if (this.interval !== undefined) {
          window.clearInterval(this.interval);
          this.interval = undefined;
        }
      }
    }

    class SyntheticAudioWorkletNode extends SyntheticNode {
      readonly port = new SyntheticMessagePort();
    }

    class SyntheticAudioContext extends EventTarget {
      state: AudioContextState = "running";
      readonly audioWorklet = {
        addModule: async (url: string) => {
          const absoluteUrl = new URL(url, document.baseURI).href;
          harness.workletUrls.push(absoluteUrl);
          const response = await fetch(absoluteUrl);
          if (!response.ok) {
            throw new Error(`Synthetic AudioWorklet request failed: ${response.status}`);
          }
        },
      };

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

    Object.defineProperties(window, {
      AudioContext: {
        configurable: true,
        value: SyntheticAudioContext,
      },
      AudioWorkletNode: {
        configurable: true,
        value: SyntheticAudioWorkletNode,
      },
    });

    const requestFailure = (mode: MediaMode, label: string) => {
      if (mode === "deny") {
        return new DOMException(`Synthetic ${label} denial`, "NotAllowedError");
      }
      if (mode === "unavailable") {
        return new DOMException(`Synthetic ${label} unavailable`, "NotFoundError");
      }
      return null;
    };
    const mediaDevices = {
      addEventListener() {},
      async enumerateDevices() {
        return [];
      },
      async getUserMedia(constraints: MediaStreamConstraints) {
        const cameraRequest = constraints.audio === false;
        if (cameraRequest) {
          harness.cameraRequests += 1;
          const failure = requestFailure(harness.cameraMode, "camera");
          if (failure) {
            throw failure;
          }
          return new SyntheticStream(new SyntheticTrack("video"));
        }

        harness.microphoneRequests += 1;
        const failure = requestFailure(harness.microphoneMode, "microphone");
        if (failure) {
          throw failure;
        }
        return new SyntheticStream(new SyntheticTrack("audio"));
      },
      removeEventListener() {},
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });
  }, options);
}

export async function setSyntheticDbfs(page: Page, dbfs: number) {
  await page.evaluate((value) => {
    const harness = (
      window as typeof window & {
        __releaseMediaHarness?: { setDbfs(value: number): void };
      }
    ).__releaseMediaHarness;
    if (!harness) {
      throw new Error("Release media harness was not installed");
    }
    harness.setDbfs(value);
  }, dbfs);
}

export async function setSyntheticMicrophoneMode(
  page: Page,
  mode: "allow" | "deny" | "unavailable",
) {
  await page.evaluate((value) => {
    const harness = (
      window as typeof window & {
        __releaseMediaHarness?: {
          setMicrophoneMode(value: "allow" | "deny" | "unavailable"): void;
        };
      }
    ).__releaseMediaHarness;
    if (!harness) {
      throw new Error("Release media harness was not installed");
    }
    harness.setMicrophoneMode(value);
  }, mode);
}

export async function setSyntheticVisibility(page: Page, visibility: DocumentVisibilityState) {
  await page.evaluate((value) => {
    const harness = (
      window as typeof window & {
        __releaseMediaHarness?: { setVisibility(value: DocumentVisibilityState): void };
      }
    ).__releaseMediaHarness;
    if (!harness) {
      throw new Error("Release media harness was not installed");
    }
    harness.setVisibility(value);
  }, visibility);
}

export async function syntheticMediaSnapshot(page: Page): Promise<SyntheticMediaSnapshot> {
  return page.evaluate(() => {
    const harness = (
      window as typeof window & {
        __releaseMediaHarness?: {
          cameraMode: "allow" | "deny" | "unavailable";
          cameraRequests: number;
          microphoneMode: "allow" | "deny" | "unavailable";
          microphoneRequests: number;
          microphoneStops: number;
          workletUrls: string[];
        };
      }
    ).__releaseMediaHarness;
    if (!harness) {
      throw new Error("Release media harness was not installed");
    }
    return {
      cameraMode: harness.cameraMode,
      cameraRequests: harness.cameraRequests,
      microphoneMode: harness.microphoneMode,
      microphoneRequests: harness.microphoneRequests,
      microphoneStops: harness.microphoneStops,
      workletUrls: harness.workletUrls,
    };
  });
}
