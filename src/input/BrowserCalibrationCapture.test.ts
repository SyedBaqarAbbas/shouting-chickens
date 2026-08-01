import { describe, expect, it, vi } from "vitest";

import { ManualClock } from "../core/clock";
import type {
  CalibrationClipRecorder,
  CalibrationClipSnapshot,
  CalibrationClipStage,
} from "../platform/audio";
import type { BrowserMediaSession } from "../platform/media";
import { BrowserCalibrationCapture, type CalibrationStage } from "./BrowserCalibrationCapture";
import type { EnergyScalarFrame } from "./energy";

class FakeScalarSource {
  sink: ((frame: EnergyScalarFrame) => void) | null = null;
  readonly start = vi.fn(async (sink: (frame: EnergyScalarFrame) => void) => {
    this.sink = sink;
  });
  readonly stop = vi.fn(() => {
    this.sink = null;
  });

  emit(frame: EnergyScalarFrame) {
    this.sink?.(frame);
  }
}

class FakeClipRecorder implements CalibrationClipRecorder {
  private readonly listeners = new Set<() => void>();
  private snapshot: CalibrationClipSnapshot = { stage: null, status: "idle", url: null };
  readonly beginStage = vi.fn((stage: CalibrationClipStage) => {
    this.snapshot = { stage, status: "recording", url: null };
    this.publish();
  });
  readonly finishStage = vi.fn(() => {
    if (!this.snapshot.stage) {
      return;
    }
    this.snapshot = {
      stage: this.snapshot.stage,
      status: "ready",
      url: `blob:${this.snapshot.stage}`,
    };
    this.publish();
  });
  readonly discard = vi.fn(() => {
    this.snapshot = { stage: null, status: "idle", url: null };
    this.publish();
  });
  readonly stop = vi.fn(() => this.discard());
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish() {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

function createHarness(publishIntervalMs = 100, targetSamples = 12) {
  const source = new FakeScalarSource();
  const clipRecorder = new FakeClipRecorder();
  const clock = new ManualClock();
  const capture = new BrowserCalibrationCapture(
    {} as BrowserMediaSession,
    {},
    clock,
    targetSamples,
    publishIntervalMs,
    source,
    1_500,
    clipRecorder,
  );
  return { capture, clipRecorder, clock, source };
}

describe("BrowserCalibrationCapture", () => {
  it("uses a human-paced time window instead of completing from render-quantum bursts", async () => {
    const { capture, clock, source } = createHarness();
    const listener = vi.fn();
    capture.subscribe(listener);
    await capture.start();
    capture.beginStage("quiet");
    listener.mockClear();

    for (let index = 0; index < 100; index += 1) {
      source.emit(frameAt(-65));
      clock.advance(5);
    }

    expect(capture.getSnapshot()).toMatchObject({
      stage: "quiet",
      status: "capturing",
      targetDurationMs: 1_500,
    });
    expect(capture.getSnapshot().sampleCount).toBeLessThan(12);

    for (let index = 0; index < 200; index += 1) {
      source.emit(frameAt(-65));
      clock.advance(5);
    }
    source.emit(frameAt(-65));

    expect(capture.getSnapshot()).toMatchObject({
      elapsedMs: 1_500,
      sampleCount: 12,
      stage: "quiet",
      status: "stage-complete",
    });
    expect(listener.mock.calls.length).toBeLessThanOrEqual(18);
    expect(capture.getSnapshot()).not.toHaveProperty("samples");
  });

  it.each([3, 17])(
    "captures speech that begins 350ms after the click at a %dms source cadence",
    async (cadenceMs) => {
      const { capture, clock, source } = createHarness(0);
      await capture.start();
      feedStage(capture, source, clock, "quiet", -60);

      capture.beginStage("normal");
      const startedAtMs = clock.now();
      while (clock.now() - startedAtMs < 350) {
        source.emit(frameAt(-60));
        clock.advance(cadenceMs);
      }
      expect(capture.getSnapshot().status).toBe("capturing");

      while (capture.getSnapshot().status === "capturing") {
        source.emit(frameAt(-30));
        clock.advance(cadenceMs);
      }
      feedStage(capture, source, clock, "loud", -10);

      expect(capture.getSnapshot()).toMatchObject({
        result: {
          ok: true,
          profile: {
            normalDb: -30,
          },
        },
        status: "complete",
      });
    },
  );

  it("publishes a live preview outside capture without retaining preview frames", async () => {
    const { capture, clock, source } = createHarness();
    const listener = vi.fn();
    capture.subscribe(listener);
    await capture.start();
    listener.mockClear();

    source.emit(frameAt(-30));

    expect(capture.getSnapshot()).toMatchObject({
      hasSignal: true,
      quality: "good",
      sampleCount: 0,
      status: "idle",
    });
    expect(capture.getSnapshot().level).toBeGreaterThan(0.6);
    expect(listener).toHaveBeenCalledOnce();

    clock.advance(50);
    source.emit(frameAt(-60));
    expect(listener).toHaveBeenCalledOnce();
    expect(capture.getSnapshot().sampleCount).toBe(0);
  });

  it.each([
    {
      code: "not-enough-samples",
      run: async (capture: BrowserCalibrationCapture) => capture.finalize(),
    },
    {
      code: "clipped",
      run: async (
        capture: BrowserCalibrationCapture,
        source: FakeScalarSource,
        clock: ManualClock,
      ) => {
        feedStage(capture, source, clock, "quiet", -60);
        feedStage(capture, source, clock, "normal", -30);
        feedStage(capture, source, clock, "loud", -0.1, true);
        return capture.getSnapshot().result;
      },
    },
    {
      code: "quiet-normal-range",
      run: async (
        capture: BrowserCalibrationCapture,
        source: FakeScalarSource,
        clock: ManualClock,
      ) => {
        feedStage(capture, source, clock, "quiet", -50);
        feedStage(capture, source, clock, "normal", -46);
        return capture.getSnapshot().result;
      },
    },
    {
      code: "normal-loud-range",
      run: async (
        capture: BrowserCalibrationCapture,
        source: FakeScalarSource,
        clock: ManualClock,
      ) => {
        feedStage(capture, source, clock, "quiet", -60);
        feedStage(capture, source, clock, "normal", -30);
        feedStage(capture, source, clock, "loud", -27);
        return capture.getSnapshot().result;
      },
    },
  ])("surfaces and resets $code without exposing samples", async ({ code, run }) => {
    const { capture, clock, source } = createHarness(0);
    await capture.start();
    const result = await run(capture, source, clock);

    expect(result).toMatchObject({ code, ok: false });
    expect(capture.getSnapshot().status).toBe("failed");

    capture.reset();
    expect(capture.getSnapshot()).toMatchObject({
      completedStages: [],
      sampleCount: 0,
      stage: "quiet",
      status: "idle",
    });
  });

  it("derives a valid profile after ordered quiet, normal, and loud stages", async () => {
    const { capture, clock, source } = createHarness(0);
    await capture.start();

    feedTrace(capture, source, clock, -60, -30, -10);

    expect(capture.getSnapshot()).toMatchObject({
      completedStages: ["quiet", "normal", "loud"],
      result: {
        ok: true,
        profile: {
          loudDb: -10,
          noiseFloorDb: -60,
          normalDb: -30,
        },
      },
      status: "complete",
    });

    capture.stop();
    expect(source.stop).toHaveBeenCalledOnce();
    expect(capture.getSnapshot().status).toBe("stopped");
  });

  it("retries only the invalid stage and preserves earlier valid input", async () => {
    const { capture, clipRecorder, clock, source } = createHarness(0);
    await capture.start();

    feedStage(capture, source, clock, "quiet", -60);
    feedStage(capture, source, clock, "normal", -58);

    expect(capture.getSnapshot()).toMatchObject({
      completedStages: ["quiet"],
      clip: { stage: "normal", status: "ready", url: "blob:normal" },
      result: { code: "quiet-normal-range", ok: false },
      stage: "normal",
      status: "failed",
    });
    expect(clipRecorder.finishStage).toHaveBeenCalledOnce();

    feedStage(capture, source, clock, "normal", -30);
    expect(capture.getSnapshot()).toMatchObject({
      completedStages: ["quiet", "normal"],
      stage: "normal",
      status: "stage-complete",
    });
  });
});

function feedTrace(
  capture: BrowserCalibrationCapture,
  source: FakeScalarSource,
  clock: ManualClock,
  quiet: number,
  normal: number,
  loud: number,
  clippedLoud = false,
) {
  for (const [stage, dbfs] of [
    ["quiet", quiet],
    ["normal", normal],
    ["loud", loud],
  ] as const) {
    feedStage(capture, source, clock, stage, dbfs, clippedLoud && stage === "loud");
  }
}

function feedStage(
  capture: BrowserCalibrationCapture,
  source: FakeScalarSource,
  clock: ManualClock,
  stage: CalibrationStage,
  dbfs: number,
  clipped = false,
) {
  capture.beginStage(stage);
  for (let index = 0; index < 12; index += 1) {
    if (index > 0) {
      clock.advance(1_500 / 11);
    }
    source.emit(frameAt(dbfs, clipped));
  }
  if (capture.getSnapshot().status === "capturing") {
    clock.advance(1);
    source.emit(frameAt(dbfs, clipped));
  }
}

function frameAt(dbfs: number, clipped = false): EnergyScalarFrame {
  const rms = 10 ** (dbfs / 20);
  return {
    capturedAtMs: 0,
    clipped,
    dbfs,
    peak: clipped ? 1 : rms,
    rms,
  };
}
