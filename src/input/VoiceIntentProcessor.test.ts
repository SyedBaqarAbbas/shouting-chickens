import { describe, expect, it } from "vitest";

import type { CalibrationProfile } from "../core/contracts";
import type { EnergyScalarFrame } from "./energy";
import { AttackReleaseSmoother, VoiceIntentProcessor } from "./VoiceIntentProcessor";

const PROFILE: CalibrationProfile = {
  jumpEnterLevel: 0.6,
  jumpExitLevel: 0.3,
  liftStartLevel: 0.5,
  loudDb: -10,
  noiseFloorDb: -60,
  normalDb: -30,
  schemaVersion: 1,
};

describe("AttackReleaseSmoother", () => {
  it("uses a faster attack than release", () => {
    const attack = new AttackReleaseSmoother(25, 200);
    attack.update(0, 0);
    const attacked = attack.update(1, 25);

    const release = new AttackReleaseSmoother(25, 200);
    release.update(1, 0);
    const released = release.update(0, 25);

    expect(attacked).toBeCloseTo(1 - Math.exp(-1));
    expect(released).toBeCloseTo(Math.exp(-0.125));
    expect(attacked).toBeGreaterThan(1 - released);
  });
});

describe("VoiceIntentProcessor", () => {
  it("emits one jump edge and bounded continuous lift for held sound", () => {
    const processor = createFastProcessor();

    processor.process(frameAt(-60), 0);
    const onset = processor.process(frameAt(-10), 20);
    const held = processor.process(frameAt(-10), 40);
    const stillHeld = processor.process(frameAt(0), 80);

    expect(onset.intent.jumpPressed).toBe(true);
    expect(onset.voice.onset).toBe(true);
    expect(onset.intent.lift).toBeGreaterThan(0);
    expect(held.intent.jumpPressed).toBe(false);
    expect(held.intent.lift).toBeCloseTo(1);
    expect(stillHeld.intent.lift).toBe(1);
    expect(stillHeld.voice.signalQuality).toBe("clipped");
  });

  it("rearms only after release and cooldown", () => {
    const processor = createFastProcessor();

    processor.process(frameAt(-60), 0);
    expect(processor.process(frameAt(-10), 20).intent.jumpPressed).toBe(true);
    processor.process(frameAt(-60), 40);
    expect(processor.process(frameAt(-10), 100).intent.jumpPressed).toBe(false);
    processor.process(frameAt(-60), 120);
    expect(processor.process(frameAt(-10), 200).intent.jumpPressed).toBe(false);
    processor.process(frameAt(-60), 300);
    expect(processor.process(frameAt(-10), 320).intent.jumpPressed).toBe(true);
  });

  it("captures quick pulses without retriggering on noisy threshold traces", () => {
    const processor = createFastProcessor({ cooldownMs: 100 });
    const levels = [-60, -29, -31, -28, -32, -29, -60, -60, -29];
    const onsets = levels.map(
      (dbfs, index) => processor.process(frameAt(dbfs), index * 20).intent.jumpPressed,
    );

    expect(onsets.filter(Boolean)).toHaveLength(2);
    expect(onsets[1]).toBe(true);
    expect(onsets[8]).toBe(true);
  });

  it("detects a short strong pulse with the default attack smoothing", () => {
    const processor = new VoiceIntentProcessor(PROFILE);
    const frames = [
      processor.process(frameAt(-60), 0),
      processor.process(frameAt(-10), 20),
      processor.process(frameAt(-10), 40),
      processor.process(frameAt(-60), 60),
    ];

    expect(frames.map((frame) => frame.intent.jumpPressed)).toEqual([false, false, true, false]);
  });

  it("does not create a false edge when landing while voice remains held", () => {
    const processor = createFastProcessor();

    processor.process(frameAt(-60), 0);
    expect(processor.process(frameAt(-10), 20).intent.jumpPressed).toBe(true);

    // The processor intentionally has no grounded input. A landing cannot alter
    // onset state, so the held frame remains lift-only.
    const landingFrame = processor.process(frameAt(-10), 400);
    expect(landingFrame.intent).toMatchObject({
      jumpPressed: false,
      lift: expect.any(Number),
    });

    processor.process(frameAt(-60), 420);
    expect(processor.process(frameAt(-10), 440).intent.jumpPressed).toBe(true);
  });

  it("classifies clipped input and clamps levels from weak through loud", () => {
    const processor = createFastProcessor();

    const weak = processor.process(frameAt(-80), 0);
    const clipped = processor.process({ ...frameAt(-1), clipped: true }, 20);

    expect(weak.voice.normalizedLevel).toBe(0);
    expect(weak.voice.signalQuality).toBe("weak");
    expect(clipped.voice.normalizedLevel).toBeLessThanOrEqual(1);
    expect(clipped.voice.signalQuality).toBe("clipped");
    expect(clipped.intent.lift).toBeLessThanOrEqual(1);
  });

  it("resets onset, cooldown, and smoothing for a new session", () => {
    const processor = createFastProcessor();

    processor.process(frameAt(-60), 0);
    expect(processor.process(frameAt(-10), 20).intent.jumpPressed).toBe(true);
    processor.reset();

    expect(processor.process(frameAt(-10), 30).intent.jumpPressed).toBe(true);
  });
});

function createFastProcessor(overrides: { cooldownMs?: number } = {}): VoiceIntentProcessor {
  return new VoiceIntentProcessor(PROFILE, {
    attackMs: 1,
    cooldownMs: overrides.cooldownMs ?? 260,
    releaseMs: 1,
  });
}

function frameAt(dbfs: number): EnergyScalarFrame {
  const rms = Math.min(1, 10 ** (dbfs / 20));
  return {
    capturedAtMs: 0,
    clipped: dbfs >= -0.25,
    dbfs: Math.min(0, dbfs),
    peak: rms,
    rms,
  };
}
