import type { Page } from "@playwright/test";

export type SyntheticMediaOptions = {
  readonly camera?: "allow" | "deny" | "unavailable";
  readonly microphone?: "allow" | "deny" | "unavailable";
};

export type SyntheticMediaSnapshot = {
  readonly audioResumeUserActivation: readonly boolean[];
  readonly cameraMode: "allow" | "deny" | "unavailable";
  readonly cameraRequests: number;
  readonly cameraStops: number;
  readonly microphoneMode: "allow" | "deny" | "unavailable";
  readonly microphoneRequests: number;
  readonly microphoneStops: number;
  readonly retainedCanvasesCount: number;
  readonly workletUrls: readonly string[];
};

export async function installSyntheticMedia(page: Page, options: SyntheticMediaOptions = {}) {
  await page.addInitScript((initialOptions) => {
    type MediaMode = "allow" | "deny" | "unavailable";
    type Harness = {
      cameraMode: MediaMode;
      cameraRequests: number;
      cameraStops: number;
      dbfs: number;
      microphoneMode: MediaMode;
      microphoneRequests: number;
      microphoneStops: number;
      audioResumeUserActivation: boolean[];
      visibility: DocumentVisibilityState;
      workletUrls: string[];
      retainedCanvasesCount: number;
      setDbfs(value: number): void;
      loseCamera(): void;
      loseMicrophone(): void;
      setMicrophoneMode(value: MediaMode): void;
      setVisibility(value: DocumentVisibilityState): void;
    };

    let loseCameraImpl = () => {};
    let loseMicrophoneImpl = () => {};
    const retainedCanvases = new Set<HTMLCanvasElement>();
    const harness: Harness = {
      cameraMode: initialOptions.camera ?? "deny",
      cameraRequests: 0,
      cameraStops: 0,
      dbfs: -60,
      microphoneMode: initialOptions.microphone ?? "allow",
      microphoneRequests: 0,
      microphoneStops: 0,
      audioResumeUserActivation: [],
      visibility: "visible",
      workletUrls: [],
      get retainedCanvasesCount() {
        return retainedCanvases.size;
      },
      loseCamera() {
        loseCameraImpl();
      },
      loseMicrophone() {
        loseMicrophoneImpl();
      },
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
        } else {
          harness.cameraStops += 1;
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

      constructor(private readonly capturedAtMs: () => number) {
        super();
      }

      start() {
        if (this.interval !== undefined) {
          return;
        }
        this.interval = window.setInterval(() => {
          const rms = 10 ** (harness.dbfs / 20);
          this.dispatchEvent(
            new MessageEvent("message", {
              data: {
                capturedAtMs: this.capturedAtMs(),
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
      readonly port: SyntheticMessagePort;

      constructor(context: SyntheticAudioContext) {
        super();
        this.port = new SyntheticMessagePort(() => context.currentTime * 1_000);
      }
    }

    class SyntheticAudioContext extends EventTarget {
      state: AudioContextState = "running";
      readonly destination = new SyntheticNode();
      private accumulatedSeconds = 0;
      private runningSinceMs = performance.now();
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

      createGain() {
        const node = new SyntheticNode() as SyntheticNode & {
          gain: {
            cancelScheduledValues(): void;
            exponentialRampToValueAtTime(): void;
            linearRampToValueAtTime(): void;
            setValueAtTime(): void;
          };
        };
        node.gain = {
          cancelScheduledValues() {},
          exponentialRampToValueAtTime() {},
          linearRampToValueAtTime() {},
          setValueAtTime() {},
        };
        return node;
      }

      createOscillator() {
        const node = new SyntheticNode() as SyntheticNode & {
          frequency: {
            exponentialRampToValueAtTime(): void;
            setValueAtTime(): void;
          };
          start(): void;
          stop(): void;
          type: OscillatorType;
        };
        node.frequency = {
          exponentialRampToValueAtTime() {},
          setValueAtTime() {},
        };
        node.start = () => {};
        node.stop = () => {
          queueMicrotask(() => node.dispatchEvent(new Event("ended")));
        };
        node.type = "sine";
        return node;
      }

      createWaveShaper() {
        const node = new SyntheticNode() as SyntheticNode & {
          curve: Float32Array | null;
          oversample: OverSampleType;
        };
        node.curve = null;
        node.oversample = "none";
        return node;
      }

      get currentTime() {
        return (
          this.accumulatedSeconds +
          (this.state === "running" ? (performance.now() - this.runningSinceMs) / 1_000 : 0)
        );
      }

      async resume() {
        harness.audioResumeUserActivation.push(navigator.userActivation?.isActive ?? false);
        if (this.state !== "running") {
          this.runningSinceMs = performance.now();
        }
        this.state = "running";
        this.dispatchEvent(new Event("statechange"));
      }

      async suspend() {
        if (this.state === "running") {
          this.accumulatedSeconds = this.currentTime;
        }
        this.state = "suspended";
        this.dispatchEvent(new Event("statechange"));
      }

      async close() {
        if (this.state === "running") {
          this.accumulatedSeconds = this.currentTime;
        }
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
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 960;
          const context = canvas.getContext("2d");
          if (!context) {
            throw new DOMException("Synthetic camera canvas unavailable", "NotReadableError");
          }
          context.fillStyle = "#31576f";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "#f4ce64";
          context.beginPath();
          context.arc(210, 280, 120, 0, Math.PI * 2);
          context.fill();
          retainedCanvases.add(canvas);
          const stream = canvas.captureStream(5);
          const track = stream.getVideoTracks()[0];
          if (!track) {
            retainedCanvases.delete(canvas);
            throw new DOMException("Synthetic camera track unavailable", "NotReadableError");
          }
          const stop = track.stop.bind(track);
          track.stop = () => {
            if (track.readyState === "ended") {
              return;
            }
            retainedCanvases.delete(canvas);
            harness.cameraStops += 1;
            stop();
            track.dispatchEvent(new Event("ended"));
          };
          track.addEventListener("ended", () => {
            retainedCanvases.delete(canvas);
          });
          loseCameraImpl = () => track.stop();
          return stream;
        }

        harness.microphoneRequests += 1;
        const failure = requestFailure(harness.microphoneMode, "microphone");
        if (failure) {
          throw failure;
        }
        const track = new SyntheticTrack("audio");
        loseMicrophoneImpl = () => track.stop();
        return new SyntheticStream(track);
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

export async function loseSyntheticMicrophone(page: Page) {
  await page.evaluate(() => {
    const harness = (
      window as typeof window & {
        __releaseMediaHarness?: { loseMicrophone(): void };
      }
    ).__releaseMediaHarness;
    if (!harness) {
      throw new Error("Release media harness was not installed");
    }
    harness.loseMicrophone();
  });
}

export async function loseSyntheticCamera(page: Page) {
  await page.evaluate(() => {
    const harness = (
      window as typeof window & {
        __releaseMediaHarness?: { loseCamera(): void };
      }
    ).__releaseMediaHarness;
    if (!harness) {
      throw new Error("Release media harness was not installed");
    }
    harness.loseCamera();
  });
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
          audioResumeUserActivation: boolean[];
          cameraMode: "allow" | "deny" | "unavailable";
          cameraRequests: number;
          cameraStops: number;
          microphoneMode: "allow" | "deny" | "unavailable";
          microphoneRequests: number;
          microphoneStops: number;
          retainedCanvasesCount: number;
          workletUrls: string[];
        };
      }
    ).__releaseMediaHarness;
    if (!harness) {
      throw new Error("Release media harness was not installed");
    }
    return {
      audioResumeUserActivation: harness.audioResumeUserActivation,
      cameraMode: harness.cameraMode,
      cameraRequests: harness.cameraRequests,
      cameraStops: harness.cameraStops,
      microphoneMode: harness.microphoneMode,
      microphoneRequests: harness.microphoneRequests,
      microphoneStops: harness.microphoneStops,
      retainedCanvasesCount: harness.retainedCanvasesCount,
      workletUrls: harness.workletUrls,
    };
  });
}
