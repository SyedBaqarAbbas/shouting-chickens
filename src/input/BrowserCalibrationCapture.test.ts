import { describe, expect, it, vi } from "vitest";

import { ManualClock } from "../core/clock";
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

function createHarness(publishIntervalMs = 100, targetSamples = 12) {
  const source = new FakeScalarSource();
  const clock = new ManualClock();
  const capture = new BrowserCalibrationCapture(
    {} as BrowserMediaSession,
    {},
    clock,
    targetSamples,
    publishIntervalMs,
    source,
  );
  return { capture, clock, source };
}

describe("BrowserCalibrationCapture", () => {
  it("accumulates scalar frames internally and throttles React-facing snapshots", async () => {
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
      sampleCount: 12,
      stage: "quiet",
      status: "stage-complete",
    });
    expect(listener.mock.calls.length).toBeLessThanOrEqual(3);
    expect(capture.getSnapshot()).not.toHaveProperty("samples");
  });

  it("throttles alternating weak and good quality frames instead of publishing every change", async () => {
    const { capture, clock, source } = createHarness(100, 100);
    const listener = vi.fn();
    capture.subscribe(listener);
    await capture.start();
    capture.beginStage("quiet");
    listener.mockClear();

    for (let index = 0; index < 100; index += 1) {
      source.emit(frameAt(index % 2 === 0 ? -60 : -40));
      clock.advance(5);
    }

    expect(capture.getSnapshot()).toMatchObject({
      sampleCount: 100,
      status: "stage-complete",
    });
    expect(listener.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it.each([
    {
      code: "not-enough-samples",
      run: async (capture: BrowserCalibrationCapture) => capture.finalize(),
    },
    {
      code: "clipped",
      run: async (capture: BrowserCalibrationCapture, source: FakeScalarSource) => {
        feedTrace(capture, source, -60, -30, -0.1, true);
        return capture.getSnapshot().result;
      },
    },
    {
      code: "quiet-normal-range",
      run: async (capture: BrowserCalibrationCapture, source: FakeScalarSource) => {
        feedTrace(capture, source, -50, -46, -20);
        return capture.getSnapshot().result;
      },
    },
    {
      code: "normal-loud-range",
      run: async (capture: BrowserCalibrationCapture, source: FakeScalarSource) => {
        feedTrace(capture, source, -60, -30, -27);
        return capture.getSnapshot().result;
      },
    },
  ])("surfaces and resets $code without exposing samples", async ({ code, run }) => {
    const { capture, source } = createHarness(0);
    await capture.start();
    const result = await run(capture, source);

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
    const { capture, source } = createHarness(0);
    await capture.start();

    feedTrace(capture, source, -60, -30, -10);

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
});

function feedTrace(
  capture: BrowserCalibrationCapture,
  source: FakeScalarSource,
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
    capture.beginStage(stage satisfies CalibrationStage);
    for (let index = 0; index < 12; index += 1) {
      source.emit(frameAt(dbfs, clippedLoud && stage === "loud"));
    }
  }
}

function frameAt(dbfs: number, clipped = false): EnergyScalarFrame {
  const rms = 10 ** (dbfs / 20);
  return {
    clipped,
    dbfs,
    peak: clipped ? 1 : rms,
    rms,
  };
}
