import { describe, expect, it } from "vitest";

import { MemoryStorage } from "../core/storage";
import {
  CalibrationProfileStore,
  createCalibrationProfile,
  normalizeDbfs,
  percentile,
  SAFE_CALIBRATION_GUIDANCE,
  type CalibrationTrace,
} from "./calibration";
import type { EnergyScalarFrame } from "./energy";

describe("percentile calibration", () => {
  it("interpolates percentiles without mutating samples", () => {
    const values = [40, 10, 30, 20];

    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 0.5)).toBe(25);
    expect(percentile(values, 1)).toBe(40);
    expect(values).toEqual([40, 10, 30, 20]);
  });

  it("derives a device-adjusted profile from quiet, comfortable, and strong input", () => {
    const result = createCalibrationProfile(traceAt(-60, -30, -10));

    expect(result).toMatchObject({
      ok: true,
      profile: {
        loudDb: -10,
        noiseFloorDb: -60,
        normalDb: -30,
        schemaVersion: 1,
      },
    });
    if (result.ok) {
      expect(result.profile.jumpEnterLevel).toBeCloseTo(0.51);
      expect(result.profile.jumpExitLevel).toBeCloseTo(0.31);
      expect(result.profile.liftStartLevel).toBeCloseTo(0.51);
      expect(result.profile.jumpEnterLevel).toBeLessThan(
        normalizeDbfs(result.profile.normalDb, result.profile),
      );
    }
  });

  it("rejects short, sustained clipping, and inadequate ranges with safe guidance", () => {
    const short = traceAt(-60, -30, -10, 3);
    const clipped = traceAt(-60, -30, -10);
    const clippedLoud = clipped.loud.map((sample, index) =>
      index < 3 ? { ...sample, clipped: true } : sample,
    );

    expect(createCalibrationProfile(short)).toMatchObject({
      code: "not-enough-samples",
      guidance: SAFE_CALIBRATION_GUIDANCE,
      ok: false,
    });
    expect(createCalibrationProfile({ ...clipped, loud: clippedLoud })).toMatchObject({
      code: "clipped",
      guidance: expect.stringContaining("do not shout"),
      ok: false,
    });
    expect(createCalibrationProfile(traceAt(-50, -46, -20))).toMatchObject({
      code: "quiet-normal-range",
      ok: false,
    });
    expect(createCalibrationProfile(traceAt(-60, -30, -27))).toMatchObject({
      code: "normal-loud-range",
      ok: false,
    });
  });

  it("ignores one transient peak and uses the speech-weighted comfortable percentile", () => {
    const trace = traceAt(-60, -55, -10);
    const intermittentNormal = trace.normal.map((sample, index) => ({
      ...sample,
      dbfs: index < 4 ? -55 : -30,
    }));
    const isolatedPeak = trace.loud.map((sample, index) =>
      index === 0 ? { ...sample, clipped: true, dbfs: -0.1, peak: 1 } : sample,
    );

    const result = createCalibrationProfile({
      ...trace,
      loud: isolatedPeak,
      normal: intermittentNormal,
    });

    expect(result).toMatchObject({
      ok: true,
      profile: {
        normalDb: -30,
      },
    });
  });

  it("normalizes and clamps device levels", () => {
    const profile = { loudDb: -10, noiseFloorDb: -60 };

    expect(normalizeDbfs(-80, profile)).toBe(0);
    expect(normalizeDbfs(-35, profile)).toBe(0.5);
    expect(normalizeDbfs(0, profile)).toBe(1);
  });

  it("persists only derived thresholds and never calibration samples", () => {
    const storage = new MemoryStorage();
    const store = new CalibrationProfileStore(storage);
    const profile = {
      jumpEnterLevel: 0.6,
      jumpExitLevel: 0.4,
      liftStartLevel: 0.6,
      loudDb: -10,
      noiseFloorDb: -60,
      normalDb: -30,
      rawSamples: [0.2, 0.5],
      schemaVersion: 1 as const,
    };

    store.write(profile);

    expect(store.read()).toEqual({
      jumpEnterLevel: 0.6,
      jumpExitLevel: 0.4,
      liftStartLevel: 0.6,
      loudDb: -10,
      noiseFloorDb: -60,
      normalDb: -30,
      schemaVersion: 1,
    });
    expect(storage.get("shouting-chickens.calibration.v1")).not.toContain("rawSamples");
    expect(storage.get("shouting-chickens.calibration.v1")).not.toContain("[0.2,0.5]");
  });

  it("rejects a persisted lift threshold that would divide by zero", () => {
    const storage = new MemoryStorage();
    const store = new CalibrationProfileStore(storage);

    expect(() =>
      store.write({
        jumpEnterLevel: 0.6,
        jumpExitLevel: 0.4,
        liftStartLevel: 1,
        loudDb: -10,
        noiseFloorDb: -60,
        normalDb: -30,
        schemaVersion: 1,
      }),
    ).toThrow("invalid calibration profile");
  });
});

function traceAt(quietDb: number, normalDb: number, loudDb: number, count = 12): CalibrationTrace {
  return {
    loud: framesAt(loudDb, count),
    normal: framesAt(normalDb, count),
    quiet: framesAt(quietDb, count),
  };
}

function framesAt(dbfs: number, count: number): EnergyScalarFrame[] {
  const rms = 10 ** (dbfs / 20);
  return Array.from({ length: count }, () => ({
    capturedAtMs: 0,
    clipped: false,
    dbfs,
    peak: rms,
    rms,
  }));
}
