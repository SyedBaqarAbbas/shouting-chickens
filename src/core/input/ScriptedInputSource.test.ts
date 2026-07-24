import { describe, expect, it } from "vitest";

import { ManualClock } from "../clock";
import { MutableInputSource, ScriptedInputSource } from "./ScriptedInputSource";

describe("ScriptedInputSource", () => {
  it("replays frames against an injected clock", async () => {
    const clock = new ManualClock(1_000);
    const input = new ScriptedInputSource(clock, [
      { atMs: 100, jumpPressed: true, lift: 0.8 },
      { atMs: 180, jumpPressed: false, lift: 0.6 },
      { atMs: 300, jumpPressed: false, lift: 0 },
    ]);

    await input.start();
    expect(input.latest()).toEqual({ atMs: 1_000, jumpPressed: false, lift: 0 });

    clock.advance(100);
    expect(input.latest()).toEqual({ atMs: 1_100, jumpPressed: true, lift: 0.8 });
    expect(input.latest()).toEqual({ atMs: 1_100, jumpPressed: false, lift: 0.8 });

    clock.advance(120);
    expect(input.latest()).toEqual({ atMs: 1_180, jumpPressed: false, lift: 0.6 });

    clock.advance(80);
    expect(input.latest()).toEqual({ atMs: 1_300, jumpPressed: false, lift: 0 });
  });

  it("resets playback after stop and restart", async () => {
    const clock = new ManualClock();
    const input = new ScriptedInputSource(clock, [{ atMs: 10, jumpPressed: true, lift: 1 }]);

    await input.start();
    clock.advance(10);
    expect(input.latest().jumpPressed).toBe(true);

    input.stop();
    expect(input.latest()).toEqual({ atMs: 0, jumpPressed: false, lift: 0 });

    clock.advance(90);
    await input.start();
    expect(input.latest()).toEqual({ atMs: 100, jumpPressed: false, lift: 0 });
  });

  it("queues a short scripted edge between deterministic simulation samples", async () => {
    const clock = new ManualClock(500);
    const input = new ScriptedInputSource(clock, [
      { atMs: 90, jumpPressed: true, lift: 0.8 },
      { atMs: 105, jumpPressed: false, lift: 0 },
    ]);
    await input.start();

    expect(input.sampleAt(80)).toEqual({
      atMs: 580,
      jumpPressed: false,
      lift: 0,
    });
    expect(input.sampleAt(120)).toEqual({
      atMs: 620,
      jumpPressed: true,
      lift: 0,
    });
    expect(input.sampleAt(140).jumpPressed).toBe(false);

    input.resetSimulationTime();
    expect(input.sampleAt(120).jumpPressed).toBe(true);
  });

  it("rewinds wall-clock and fixed-step queues for a new run", async () => {
    const clock = new ManualClock(200);
    const input = new ScriptedInputSource(clock, [
      { atMs: 40, jumpPressed: true, lift: 0.8 },
      { atMs: 80, jumpPressed: false, lift: 0 },
    ]);
    await input.start();
    clock.advance(100);

    expect(input.latest().jumpPressed).toBe(true);
    expect(input.sampleAt(100).jumpPressed).toBe(true);

    input.resetRunState();

    expect(input.latest()).toEqual({ atMs: 300, jumpPressed: false, lift: 0 });
    expect(input.sampleAt(30).jumpPressed).toBe(false);
    expect(input.sampleAt(50).jumpPressed).toBe(true);
  });
});

describe("MutableInputSource", () => {
  it("uses the same control intent contract for manual adapters", async () => {
    const input = new MutableInputSource();
    input.set({ atMs: 20, jumpPressed: true, lift: 0.75 });

    expect(input.latest()).toEqual({ atMs: 0, jumpPressed: false, lift: 0 });

    await input.start();
    expect(input.latest()).toEqual({ atMs: 20, jumpPressed: true, lift: 0.75 });
    expect(input.latest()).toEqual({ atMs: 20, jumpPressed: false, lift: 0.75 });

    input.resetRunState();
    expect(input.latest()).toEqual({ atMs: 0, jumpPressed: false, lift: 0 });

    input.stop();
    expect(input.latest()).toEqual({ atMs: 0, jumpPressed: false, lift: 0 });
  });
});
