import { describe, expect, it } from "vitest";

import {
  amplitudeToDbfs,
  energyScalarFromSamples,
  parseEnergyScalarFrame,
  rootMeanSquare,
} from "./energy";

describe("voice energy helpers", () => {
  it("computes RMS without retaining PCM input", () => {
    expect(rootMeanSquare(new Float32Array([1, -1, 1, -1]))).toBe(1);
    expect(rootMeanSquare(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rootMeanSquare(new Float32Array())).toBe(0);
  });

  it("converts amplitude to bounded dBFS", () => {
    expect(amplitudeToDbfs(1)).toBe(0);
    expect(amplitudeToDbfs(0.5)).toBeCloseTo(-6.0206, 3);
    expect(amplitudeToDbfs(0)).toBe(-120);
    expect(amplitudeToDbfs(Number.NaN)).toBe(-120);
    expect(amplitudeToDbfs(2)).toBe(0);
  });

  it("reports only scalar energy and clipping state", () => {
    expect(energyScalarFromSamples(new Float32Array([0.25, -0.5, 1]))).toEqual({
      capturedAtMs: 0,
      clipped: true,
      dbfs: expect.any(Number),
      peak: 1,
      rms: expect.any(Number),
    });
  });

  it("accepts only the worklet scalar message contract", () => {
    expect(
      parseEnergyScalarFrame({
        capturedAtMs: 125,
        clipped: false,
        dbfs: -20,
        peak: 0.2,
        rms: 0.1,
        type: "voice-energy",
      }),
    ).toEqual({
      capturedAtMs: 125,
      clipped: false,
      dbfs: -20,
      peak: 0.2,
      rms: 0.1,
    });
    expect(parseEnergyScalarFrame({ samples: [0.1], type: "voice-energy" })).toBeNull();
    expect(
      parseEnergyScalarFrame({
        capturedAtMs: 125,
        clipped: false,
        dbfs: 2,
        peak: 0.2,
        rms: 0.1,
        type: "voice-energy",
      }),
    ).toBeNull();
  });
});
