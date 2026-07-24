import { describe, expect, it } from "vitest";

import type { ControlIntent } from "../core";
import { FixedStepRunner } from "./FixedStepRunner";
import {
  ChickenSimulation,
  FIXED_STEP_MS,
  FIXED_WORLD_SPEED,
  type PlatformDefinition,
} from "./simulation";

const NEUTRAL_INTENT: ControlIntent = {
  atMs: 0,
  jumpPressed: false,
  lift: 0,
};

const ENDLESS_PLATFORM: readonly PlatformDefinition[] = [
  { id: "endless", x: -500, width: 10_000, top: 584 },
];

function runTrace() {
  const simulation = new ChickenSimulation({ platforms: ENDLESS_PLATFORM });
  const trace = [];

  simulation.start();

  for (let tick = 0; tick < 180; tick += 1) {
    const intent = {
      atMs: tick * FIXED_STEP_MS,
      jumpPressed: tick === 24,
      lift: tick >= 25 && tick < 72 ? 0.7 : 0,
    };
    const snapshot = simulation.step(intent);

    if (tick % 12 === 0 || tick === 24) {
      trace.push(snapshot);
    }
  }

  return trace;
}

describe("ChickenSimulation", () => {
  it("replays the same intent trace with identical fixed-step physics", () => {
    const first = runTrace();
    const second = runTrace();

    expect(second).toEqual(first);
    expect(first.some((snapshot) => !snapshot.chicken.grounded)).toBe(true);
    expect(first.at(-1)?.landingCount).toBe(1);
  });

  it("keeps auto-run speed fixed regardless of input lift", () => {
    const silent = new ChickenSimulation({ platforms: ENDLESS_PLATFORM });
    const loud = new ChickenSimulation({ platforms: ENDLESS_PLATFORM });

    silent.start();
    loud.start();

    for (let tick = 0; tick < 60; tick += 1) {
      silent.step({ ...NEUTRAL_INTENT, atMs: tick * FIXED_STEP_MS });
      loud.step({ atMs: tick * FIXED_STEP_MS, jumpPressed: false, lift: 1 });
    }

    expect(silent.snapshot().distance).toBeCloseTo(FIXED_WORLD_SPEED, 8);
    expect(loud.snapshot().distance).toBeCloseTo(FIXED_WORLD_SPEED, 8);
  });

  it("lands on platform collision and records one deterministic landing", () => {
    const simulation = new ChickenSimulation({ platforms: ENDLESS_PLATFORM });
    simulation.start();

    simulation.step({ ...NEUTRAL_INTENT, jumpPressed: true });

    for (let tick = 0; tick < 180 && !simulation.snapshot().chicken.grounded; tick += 1) {
      simulation.step(NEUTRAL_INTENT);
    }

    const landed = simulation.snapshot();
    expect(landed.chicken.grounded).toBe(true);
    expect(landed.chicken.supportingPlatformId).toBe("endless");
    expect(landed.chicken.velocityY).toBe(0);
    expect(landed.landingCount).toBe(1);
  });

  it("dies in water and fully resets every mutable run field", () => {
    const simulation = new ChickenSimulation();
    const initial = simulation.snapshot();
    simulation.start();

    for (let tick = 0; tick < 600 && simulation.snapshot().phase !== "dead"; tick += 1) {
      simulation.step(NEUTRAL_INTENT);
    }

    expect(simulation.snapshot()).toMatchObject({
      phase: "dead",
      deathReason: "water",
      chicken: {
        animation: "death",
        grounded: false,
      },
    });

    expect(simulation.reset()).toEqual(initial);
  });

  it("does not advance time, distance, or bodies while paused", () => {
    const simulation = new ChickenSimulation({ platforms: ENDLESS_PLATFORM });
    simulation.start();
    simulation.step(NEUTRAL_INTENT);
    const paused = simulation.pause();

    for (let tick = 0; tick < 120; tick += 1) {
      simulation.step({ ...NEUTRAL_INTENT, jumpPressed: true, lift: 1 });
    }

    expect(simulation.snapshot()).toEqual(paused);
    expect(simulation.diagnostics()).toEqual({
      activeBodies: 1,
      activeTimers: 0,
      destroyed: false,
    });
  });
});

describe("FixedStepRunner", () => {
  it("produces the same 60 steps for different render frame rates", () => {
    const coarseSimulation = new ChickenSimulation({ platforms: ENDLESS_PLATFORM });
    const fineSimulation = new ChickenSimulation({ platforms: ENDLESS_PLATFORM });
    const coarse = new FixedStepRunner(coarseSimulation);
    const fine = new FixedStepRunner(fineSimulation);

    coarseSimulation.start();
    fineSimulation.start();

    for (let frame = 0; frame < 10; frame += 1) {
      coarse.advance(100, () => NEUTRAL_INTENT);
    }

    for (let frame = 0; frame < 60; frame += 1) {
      fine.advance(FIXED_STEP_MS, () => NEUTRAL_INTENT);
    }

    expect(coarseSimulation.snapshot()).toEqual(fineSimulation.snapshot());
    expect(coarseSimulation.snapshot().tick).toBe(60);
  });

  it("drops accumulated frame time during pause and reset", () => {
    const simulation = new ChickenSimulation({ platforms: ENDLESS_PLATFORM });
    const runner = new FixedStepRunner(simulation);
    simulation.start();

    runner.advance(FIXED_STEP_MS / 2, () => NEUTRAL_INTENT);
    expect(runner.pendingMs()).toBeGreaterThan(0);

    simulation.pause();
    runner.advance(200, () => NEUTRAL_INTENT);
    expect(runner.pendingMs()).toBe(0);

    simulation.resume();
    runner.advance(FIXED_STEP_MS, () => NEUTRAL_INTENT);
    expect(simulation.snapshot().tick).toBe(1);
  });
});
