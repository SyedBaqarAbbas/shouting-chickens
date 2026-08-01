import { describe, expect, it, vi } from "vitest";

import { ManualClock } from "../../core/clock";
import type { CalibrationProfile } from "../../core/contracts";
import { energyScalarFromSamples } from "../../input";
import type { MediaResourceStatus, MicrophoneAudioGraph } from "../media/BrowserMediaSession";
import { DEFAULT_WORKLET_MODULE_URL } from "./BrowserScalarEnergySource";
import {
  BrowserVoiceInputSource,
  VOICE_RMS_PROCESSOR_NAME,
  type VoiceInputDependencies,
} from "./BrowserVoiceInputSource";

const PROFILE: CalibrationProfile = {
  jumpEnterLevel: 0.6,
  jumpExitLevel: 0.3,
  liftStartLevel: 0.5,
  loudDb: -10,
  noiseFloorDb: -60,
  normalDb: -30,
  schemaVersion: 1,
};

class FakeMessagePort extends EventTarget {
  readonly close = vi.fn();
  readonly start = vi.fn();

  emit(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

class FakeWorkletNode extends EventTarget {
  readonly disconnect = vi.fn();
  readonly port = new FakeMessagePort();
}

class FakeAnalyserNode {
  disconnect = vi.fn();
  fftSize = 32;
  smoothingTimeConstant = 1;
  samples = new Float32Array(32);

  getFloatTimeDomainData(buffer: Float32Array<ArrayBuffer>): void {
    buffer.set(this.samples);
  }
}

class FakeSourceNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

interface SessionHarness {
  readonly context: AudioContext;
  readonly analyser: FakeAnalyserNode;
  readonly source: FakeSourceNode;
  readonly session: import("../media/BrowserMediaSession").BrowserMediaSession;
  readonly registerNode: ReturnType<typeof vi.fn>;
  readonly unregisterNode: ReturnType<typeof vi.fn>;
  setStatus(status: MediaResourceStatus): void;
  removeGraph(): void;
}

function createSessionHarness(options: { worklet?: boolean } = {}): SessionHarness {
  const source = new FakeSourceNode();
  const analyser = new FakeAnalyserNode();
  const addModule = vi.fn(async () => undefined);
  const context = {
    audioWorklet: options.worklet ? { addModule } : undefined,
    createAnalyser: vi.fn(() => analyser),
    currentTime: 0,
  } as unknown as AudioContext;
  let graph: MicrophoneAudioGraph | undefined = {
    context,
    source: source as unknown as MediaStreamAudioSourceNode,
    stream: {} as MediaStream,
  };
  let microphoneStatus: MediaResourceStatus = "active";
  let listener: (() => void) | null = null;
  const unregisterNode = vi.fn();
  const registerNode = vi.fn(() => unregisterNode);
  const session = {
    getMicrophoneAudioGraph: () => graph,
    getSnapshot: () => ({
      audioContext: "running",
      camera: {
        canFallback: true,
        canRetry: true,
        ignoredPreferences: [],
        kind: "camera",
        status: "idle",
      },
      microphone: {
        canFallback: true,
        canRetry: true,
        ignoredPreferences: [],
        kind: "microphone",
        status: microphoneStatus,
      },
      resumeRequired: false,
      visibility: "visible",
    }),
    registerMicrophoneNode: registerNode,
    subscribe: (nextListener: () => void) => {
      listener = nextListener;
      return vi.fn(() => {
        listener = null;
      });
    },
  } as unknown as import("../media/BrowserMediaSession").BrowserMediaSession;

  return {
    analyser,
    context,
    registerNode,
    session,
    source,
    unregisterNode,
    removeGraph() {
      graph = undefined;
    },
    setStatus(status) {
      microphoneStatus = status;
      listener?.();
    },
  };
}

function processingOptions() {
  return {
    attackMs: 1,
    cooldownMs: 100,
    releaseMs: 1,
  };
}

describe("BrowserVoiceInputSource", () => {
  it("measures acoustic onset through attack smoothing to intent creation", async () => {
    const harness = createSessionHarness({ worklet: true });
    const clock = new ManualClock(1_000);
    const node = new FakeWorkletNode();
    const input = new BrowserVoiceInputSource(
      harness.session,
      clock,
      PROFILE,
      { createAudioWorkletNode: () => node as unknown as AudioWorkletNode },
      { attackMs: 35, cooldownMs: 100, releaseMs: 180 },
    );
    await input.start();

    clock.advance(1);
    node.port.emit({
      ...energyScalarFromSamples(new Float32Array(32).fill(0.001), 1),
      type: "voice-energy",
    });
    clock.advance(21);
    node.port.emit({
      ...energyScalarFromSamples(new Float32Array(32).fill(0.5), 17),
      type: "voice-energy",
    });
    expect(input.latest().jumpPressed).toBe(false);
    clock.advance(16);
    node.port.emit({
      ...energyScalarFromSamples(new Float32Array(32).fill(0.5), 34),
      type: "voice-energy",
    });

    expect(input.latest().jumpPressed).toBe(true);
    expect(input.consumeInputLatencySamples()).toEqual([{ latencyMs: 21, provenance: "voice" }]);
    input.stop();
  });

  it("maps capture-time input to the app clock and rebases after suspension", async () => {
    const harness = createSessionHarness({ worklet: true });
    const clock = new ManualClock(10_000);
    Object.assign(harness.context, { currentTime: 5 });
    const node = new FakeWorkletNode();
    const input = new BrowserVoiceInputSource(
      harness.session,
      clock,
      PROFILE,
      { createAudioWorkletNode: () => node as unknown as AudioWorkletNode },
      processingOptions(),
    );
    await input.start();

    clock.advance(200);
    node.port.emit({
      ...energyScalarFromSamples(new Float32Array(32).fill(0.5), 5_100),
      type: "voice-energy",
    });
    expect(input.latest()).toMatchObject({ atMs: 10_100, jumpPressed: true });
    expect(input.consumeInputLatencyMs()).toBe(100);

    harness.setStatus("suspended");
    clock.advance(120_000);
    Object.assign(harness.context, { currentTime: 5.2 });
    harness.setStatus("active");
    clock.advance(100);
    node.port.emit({
      ...energyScalarFromSamples(new Float32Array(32).fill(0.5), 5_300),
      type: "voice-energy",
    });
    expect(input.getLatestVoiceFrame()?.atMs).toBe(130_300);
    input.stop();
  });

  it("uses the worklet scalar path with no audible output connection", async () => {
    const harness = createSessionHarness({ worklet: true });
    const clock = new ManualClock();
    const node = new FakeWorkletNode();
    const createNode = vi.fn(() => node as unknown as AudioWorkletNode);
    const input = new BrowserVoiceInputSource(
      harness.session,
      clock,
      PROFILE,
      { createAudioWorkletNode: createNode },
      processingOptions(),
    );

    await input.start();

    expect(input.mode).toBe("audio-worklet");
    expect(harness.context.audioWorklet.addModule).toHaveBeenCalledWith(DEFAULT_WORKLET_MODULE_URL);
    expect(createNode).toHaveBeenCalledWith(
      harness.context,
      VOICE_RMS_PROCESSOR_NAME,
      expect.objectContaining({
        numberOfInputs: 1,
        numberOfOutputs: 0,
      }),
    );
    expect(harness.source.connect).toHaveBeenCalledExactlyOnceWith(node);
    expect(harness.registerNode).toHaveBeenCalledExactlyOnceWith(node);

    clock.advance(20);
    node.port.emit({
      ...energyScalarFromSamples(new Float32Array(32).fill(0.5)),
      type: "voice-energy",
    });
    clock.advance(10);
    node.port.emit({
      ...energyScalarFromSamples(new Float32Array(32).fill(0.5)),
      type: "voice-energy",
    });

    expect(input.latest()).toMatchObject({
      atMs: 20,
      jumpPressed: true,
      lift: expect.any(Number),
    });
    expect(input.latest().jumpPressed).toBe(false);
    expect(input.getLatestVoiceFrame()).toMatchObject({
      atMs: 30,
      onset: false,
      rawDb: expect.any(Number),
    });
    expect(input.getFeedback()).toEqual({
      normalizedLevel: input.getLatestVoiceFrame()?.normalizedLevel,
      provenance: "voice",
    });
  });

  it("falls back to analyser frames using the same scalar processing contract", async () => {
    const workletHarness = createSessionHarness({ worklet: true });
    const analyserHarness = createSessionHarness();
    const clock = new ManualClock(20);
    const node = new FakeWorkletNode();
    const samples = new Float32Array(256).fill(0.5);
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    const scheduling: VoiceInputDependencies = {
      cancelAnimationFrame: (handle) => {
        callbacks.delete(handle);
      },
      requestAnimationFrame: (callback) => {
        const handle = nextHandle;
        nextHandle += 1;
        callbacks.set(handle, callback);
        return handle;
      },
    };
    const workletInput = new BrowserVoiceInputSource(
      workletHarness.session,
      clock,
      PROFILE,
      { createAudioWorkletNode: () => node as unknown as AudioWorkletNode },
      processingOptions(),
    );
    const analyserInput = new BrowserVoiceInputSource(
      analyserHarness.session,
      clock,
      PROFILE,
      scheduling,
      processingOptions(),
    );

    await Promise.all([workletInput.start(), analyserInput.start()]);
    analyserHarness.analyser.samples = samples;
    node.port.emit({ ...energyScalarFromSamples(samples), type: "voice-energy" });
    runNextAnimationFrame(callbacks);

    expect(analyserInput.mode).toBe("analyser");
    expect(analyserHarness.analyser.fftSize).toBe(256);
    expect(analyserHarness.analyser.smoothingTimeConstant).toBe(0);
    expect(analyserInput.latest()).toEqual(workletInput.latest());
    expect(analyserInput.getLatestVoiceFrame()).toEqual(workletInput.getLatestVoiceFrame());
    expect(analyserHarness.source.connect).toHaveBeenCalledWith(analyserHarness.analyser);
  });

  it("uses analyser fallback when worklet module loading is blocked", async () => {
    const harness = createSessionHarness({ worklet: true });
    vi.mocked(harness.context.audioWorklet.addModule).mockRejectedValueOnce(
      new Error("blocked by policy"),
    );
    const callbacks = new Map<number, FrameRequestCallback>();
    const input = new BrowserVoiceInputSource(
      harness.session,
      new ManualClock(),
      PROFILE,
      {
        cancelAnimationFrame: (handle) => callbacks.delete(handle),
        createAudioWorkletNode: () => new FakeWorkletNode() as unknown as AudioWorkletNode,
        requestAnimationFrame: (callback) => {
          callbacks.set(1, callback);
          return 1;
        },
      },
      processingOptions(),
    );

    await input.start();

    expect(input.mode).toBe("analyser");
    expect(harness.context.createAnalyser).toHaveBeenCalledOnce();
  });

  it("uses analyser fallback when worklet node creation fails", async () => {
    const harness = createSessionHarness({ worklet: true });
    const callbacks = new Map<number, FrameRequestCallback>();
    const input = new BrowserVoiceInputSource(
      harness.session,
      new ManualClock(),
      PROFILE,
      {
        cancelAnimationFrame: (handle) => callbacks.delete(handle),
        createAudioWorkletNode: () => {
          throw new Error("constructor unavailable");
        },
        requestAnimationFrame: (callback) => {
          callbacks.set(1, callback);
          return 1;
        },
      },
      processingOptions(),
    );

    await input.start();

    expect(input.mode).toBe("analyser");
    expect(harness.context.createAnalyser).toHaveBeenCalledOnce();
  });

  it("ignores malformed worklet messages instead of exposing raw payloads", async () => {
    const harness = createSessionHarness({ worklet: true });
    const node = new FakeWorkletNode();
    const input = new BrowserVoiceInputSource(
      harness.session,
      new ManualClock(50),
      PROFILE,
      { createAudioWorkletNode: () => node as unknown as AudioWorkletNode },
      processingOptions(),
    );
    await input.start();

    node.port.emit({ samples: [0.5, 0.5], type: "voice-energy" });

    expect(input.latest()).toEqual({
      atMs: 50,
      jumpPressed: false,
      lift: 0,
    });
    expect(input.getLatestVoiceFrame()).toBeNull();
  });

  it("neutralizes pending onset and lift while the media session is suspended", async () => {
    const harness = createSessionHarness({ worklet: true });
    const clock = new ManualClock(20);
    const node = new FakeWorkletNode();
    const input = new BrowserVoiceInputSource(
      harness.session,
      clock,
      PROFILE,
      { createAudioWorkletNode: () => node as unknown as AudioWorkletNode },
      processingOptions(),
    );
    await input.start();
    node.port.emit({
      ...energyScalarFromSamples(new Float32Array(32).fill(0.5)),
      type: "voice-energy",
    });

    clock.advance(20);
    harness.setStatus("suspended");
    node.port.emit({
      ...energyScalarFromSamples(new Float32Array(32).fill(0.5)),
      type: "voice-energy",
    });

    expect(input.latest()).toEqual({
      atMs: 40,
      jumpPressed: false,
      lift: 0,
    });
    expect(input.getLatestVoiceFrame()).toBeNull();

    harness.setStatus("active");
    clock.advance(20);
    node.port.emit({
      ...energyScalarFromSamples(new Float32Array(32).fill(0.5)),
      type: "voice-energy",
    });
    expect(input.latest().jumpPressed).toBe(true);
  });

  it("clears processed lift and a pending jump edge on explicit run reset", async () => {
    const harness = createSessionHarness({ worklet: true });
    const clock = new ManualClock(20);
    const node = new FakeWorkletNode();
    const input = new BrowserVoiceInputSource(
      harness.session,
      clock,
      PROFILE,
      { createAudioWorkletNode: () => node as unknown as AudioWorkletNode },
      processingOptions(),
    );
    await input.start();
    node.port.emit({
      ...energyScalarFromSamples(new Float32Array(32).fill(0.5)),
      type: "voice-energy",
    });

    input.resetRunState();

    expect(input.latest()).toEqual({
      atMs: 20,
      jumpPressed: false,
      lift: 0,
    });
    expect(input.getLatestVoiceFrame()).toBeNull();
  });

  it("cleans up a rejected scalar start so a retry is a fresh promise", async () => {
    const harness = createSessionHarness();
    vi.mocked(harness.context.createAnalyser).mockImplementation(() => {
      throw new Error("analyser unavailable");
    });
    const input = new BrowserVoiceInputSource(harness.session, new ManualClock(), PROFILE);

    const first = input.start();
    await expect(first).rejects.toThrow("analyser unavailable");
    const second = input.start();

    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow("analyser unavailable");
  });

  it("can restart while an earlier worklet module load is still pending", async () => {
    const harness = createSessionHarness({ worklet: true });
    const firstModule = deferred<void>();
    vi.mocked(harness.context.audioWorklet.addModule)
      .mockReturnValueOnce(firstModule.promise)
      .mockResolvedValueOnce(undefined);
    const nodes: FakeWorkletNode[] = [];
    const input = new BrowserVoiceInputSource(harness.session, new ManualClock(), PROFILE, {
      createAudioWorkletNode: () => {
        const node = new FakeWorkletNode();
        nodes.push(node);
        return node as unknown as AudioWorkletNode;
      },
    });

    const staleStart = input.start();
    input.stop();
    const currentStart = input.start();

    expect(currentStart).not.toBe(staleStart);
    await currentStart;
    expect(input.mode).toBe("audio-worklet");

    firstModule.resolve(undefined);
    await staleStart;

    expect(input.mode).toBe("audio-worklet");
    expect(nodes).toHaveLength(2);
    expect(nodes[1]?.port.close).toHaveBeenCalledOnce();
  });

  it.each(["device-lost", "fallback", "closed"] as const)(
    "releases its owned graph edge when the media session becomes %s",
    async (status) => {
      const harness = createSessionHarness({ worklet: true });
      const node = new FakeWorkletNode();
      const input = new BrowserVoiceInputSource(harness.session, new ManualClock(), PROFILE, {
        createAudioWorkletNode: () => node as unknown as AudioWorkletNode,
      });
      await input.start();

      harness.setStatus(status);
      input.stop();

      expect(input.mode).toBeNull();
      expect(harness.source.disconnect).toHaveBeenCalledExactlyOnceWith(node);
      expect(harness.unregisterNode).toHaveBeenCalledOnce();
      expect(node.port.close).toHaveBeenCalledOnce();
      expect(input.latest()).toEqual({
        atMs: 0,
        jumpPressed: false,
        lift: 0,
      });
    },
  );

  it("requires the media session to own an active microphone graph", async () => {
    const harness = createSessionHarness();
    harness.removeGraph();
    const input = new BrowserVoiceInputSource(harness.session, new ManualClock(), PROFILE);

    await expect(input.start()).rejects.toThrow(
      "Microphone capture must be active before voice processing starts.",
    );
    expect(harness.registerNode).not.toHaveBeenCalled();
  });
});

function runNextAnimationFrame(callbacks: Map<number, FrameRequestCallback>): void {
  const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
  if (!entry) {
    throw new Error("Expected an analyser animation frame");
  }

  callbacks.delete(entry[0]);
  entry[1](20);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
