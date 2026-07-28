import { describe, expect, it } from "vitest";

import type { ControlIntent } from "../core";
import type { ChunkTemplate } from "../content";
import { difficultyProfileForChunk } from "./DifficultyProgression";
import { FixedStepRunner } from "./FixedStepRunner";
import { GeneratedChunkCourse } from "./GeneratedChunkCourse";
import { LIFT_STAMINA_RECOVERY_PER_SECOND } from "./LiftStamina";
import { PRECISION_LANDING_SCORE } from "./Scoring";
import {
  ChickenSimulation,
  FIXED_STEP_MS,
  FIXED_WORLD_SPEED,
  type PlatformDefinition,
  type SimulationSnapshot,
} from "./simulation";
import { DEFAULT_PLAYER_CONTROLLER_TUNING } from "./FixedStepPlayerController";

const NEUTRAL_INTENT: ControlIntent = {
  atMs: 0,
  jumpPressed: false,
  lift: 0,
};

const ENDLESS_PLATFORM: readonly PlatformDefinition[] = [
  { id: "endless", x: -500, width: 10_000, top: 584 },
];

function quietTunnelTemplate(x = 300, top = 500): ChunkTemplate {
  return {
    id: "stamina-tunnel",
    width: 900,
    minimumDifficulty: 1,
    maximumDifficulty: 5,
    challengeStage: "introduction",
    mechanics: [],
    requiresIntroductions: [],
    voiceSkills: [],
    entry: { platformId: "runway" },
    exit: { platformId: "runway" },
    requiredCapability: "run",
    platforms: [{ id: "runway", x: 0, width: 900, top: 584 }],
    hazards: [
      {
        id: "tunnel",
        kind: "quiet-zone",
        x,
        width: 240,
        top,
        bottom: 584,
        maximumLift: 0.05,
      },
    ],
    collectibles: [],
    warnings: [],
    route: [
      {
        fromPlatformId: "runway",
        toPlatformId: "runway",
        requiredCapability: "run",
      },
    ],
  };
}

function generatedTunnelCourse(
  template = quietTunnelTemplate(),
  difficultyForChunk?: (chunkIndex: number) => number,
) {
  const course = new GeneratedChunkCourse({
    templates: [template],
    slotCount: 7,
    repeatWindow: 0,
    difficultyForChunk,
    progressionForChunk: difficultyForChunk ? difficultyProfileForChunk : undefined,
  });
  course.reset("stamina-ceiling", "sho-17-test");
  return course;
}

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

  it("keeps a long-held lift bounded and eventually descends without stamina", () => {
    const simulation = new ChickenSimulation({ platforms: ENDLESS_PLATFORM });
    simulation.start();
    simulation.step({ ...NEUTRAL_INTENT, jumpPressed: true, lift: 1 });

    let highestY = simulation.snapshot().chicken.y;
    let descendedWhileHeld = false;

    for (let tick = 0; tick < 3_000 && !simulation.snapshot().chicken.grounded; tick += 1) {
      const before = simulation.snapshot().chicken.y;
      const after = simulation.step({ ...NEUTRAL_INTENT, lift: 1 });
      highestY = Math.min(highestY, after.chicken.y);
      descendedWhileHeld ||= after.chicken.y > before;
      expect(after.chicken.velocityY).toBeGreaterThanOrEqual(
        DEFAULT_PLAYER_CONTROLLER_TUNING.maximumRiseVelocity,
      );
      expect(after.chicken.velocityY).toBeLessThanOrEqual(
        DEFAULT_PLAYER_CONTROLLER_TUNING.maximumFallVelocity,
      );
    }

    expect(highestY).toBeGreaterThan(-1_000);
    expect(descendedWhileHeld).toBe(true);
    expect(simulation.snapshot().chicken.grounded).toBe(true);
    expect(simulation.snapshot().phase).toBe("running");
  });

  it("drains airborne lift to empty, suppresses effective lift, and recovers on release", () => {
    const simulation = new ChickenSimulation({
      platforms: ENDLESS_PLATFORM,
      playerTuning: {
        gravityPerSecond: 1,
        jumpVelocity: -100,
        liftAccelerationPerSecond: 0,
        maximumRiseVelocity: -200,
        maximumFallVelocity: 720,
      },
    });
    simulation.start();
    simulation.step({ ...NEUTRAL_INTENT, jumpPressed: true, lift: 1 });

    for (let tick = 0; tick < 180; tick += 1) {
      simulation.step({ ...NEUTRAL_INTENT, lift: 1 });
    }

    expect(simulation.snapshot()).toMatchObject({
      phase: "running",
      liftStamina: 0,
      effectiveLift: 0,
      statistics: {
        longestLiftMs: 2_500,
      },
    });

    for (let tick = 0; tick < 60; tick += 1) {
      simulation.step(NEUTRAL_INTENT);
    }
    expect(simulation.snapshot().liftStamina).toBeCloseTo(LIFT_STAMINA_RECOVERY_PER_SECOND, 8);
  });

  it("rejects raw held input in a quiet zone after effective stamina lift is depleted", () => {
    const simulation = new ChickenSimulation({
      generatedCourse: generatedTunnelCourse(quietTunnelTemplate(650, 0)),
      playerTuning: {
        gravityPerSecond: 1,
        jumpVelocity: -100,
        liftAccelerationPerSecond: 0,
        maximumRiseVelocity: -200,
        maximumFallVelocity: 720,
      },
    });
    simulation.start();
    simulation.step({ ...NEUTRAL_INTENT, jumpPressed: true, lift: 1 });

    for (let tick = 0; tick < 400 && simulation.snapshot().phase === "running"; tick += 1) {
      simulation.step({ ...NEUTRAL_INTENT, lift: 1 });
    }

    expect(simulation.snapshot()).toMatchObject({
      phase: "dead",
      deathReason: "hazard",
      collisionId: "0:stamina-tunnel:tunnel",
      liftStamina: 0,
      effectiveLift: 0,
    });
    expect(simulation.drainInteractionEvents()).toContainEqual({
      type: "hazard-collision",
      value: {
        id: "0:stamina-tunnel:tunnel",
        kind: "quiet-zone",
        tick: expect.any(Number),
      },
    });
  });

  it("keeps grounded tunnel traversal safe and diagnoses released ceiling impacts distinctly", () => {
    const safe = new ChickenSimulation({
      generatedCourse: generatedTunnelCourse(),
    });
    safe.start();
    for (let tick = 0; tick < 360; tick += 1) {
      safe.step(NEUTRAL_INTENT);
    }
    expect(safe.snapshot().phase).toBe("running");
    expect(safe.drainInteractionEvents()).toEqual([]);

    const replayedOutcomes: Array<
      Pick<
        SimulationSnapshot,
        "tick" | "collisionId" | "deathReason" | "difficultyStage" | "scoreBreakdown" | "statistics"
      >
    > = [];
    const course = generatedTunnelCourse(
      quietTunnelTemplate(),
      (chunkIndex) => difficultyProfileForChunk(chunkIndex).difficulty,
    );
    const simulation = new ChickenSimulation({ generatedCourse: course });

    for (let run = 0; run < 2; run += 1) {
      if (run > 0) {
        simulation.reset();
      }
      simulation.start();
      let jumpStarted = false;

      for (let tick = 0; tick < 5_000 && simulation.snapshot().phase === "running"; tick += 1) {
        const before = simulation.snapshot();
        const placement = course
          .snapshot(before.tick)
          .chunks.find((chunk) => chunk.chunkIndex === 6);
        const worldX = before.distance + 112;
        const jumpAt = placement ? placement.originX + 120 : Number.POSITIVE_INFINITY;
        const releaseAt = placement ? placement.originX + 240 : Number.POSITIVE_INFINITY;
        const jumpPressed = !jumpStarted && worldX >= jumpAt;

        if (jumpPressed) {
          jumpStarted = true;
        }
        simulation.step({
          atMs: before.elapsedMs + FIXED_STEP_MS,
          jumpPressed,
          lift: jumpStarted && worldX < releaseAt ? 1 : 0,
        });
      }

      const outcome = simulation.snapshot();
      replayedOutcomes.push({
        tick: outcome.tick,
        collisionId: outcome.collisionId,
        deathReason: outcome.deathReason,
        difficultyStage: outcome.difficultyStage,
        scoreBreakdown: outcome.scoreBreakdown,
        statistics: outcome.statistics,
      });
      expect(simulation.drainInteractionEvents()).toContainEqual({
        type: "hazard-collision",
        value: {
          id: "6:stamina-tunnel:tunnel:ceiling",
          kind: "ceiling",
          tick: outcome.tick,
        },
      });
    }

    expect(replayedOutcomes[0]).toEqual(replayedOutcomes[1]);
    expect(replayedOutcomes[0]).toMatchObject({
      collisionId: "6:stamina-tunnel:tunnel:ceiling",
      deathReason: "hazard",
      difficultyStage: 2,
    });
  });

  it("counts a safely cleared obstacle once and resets its deterministic replay", () => {
    const course = generatedTunnelCourse(quietTunnelTemplate(300, 0));
    const simulation = new ChickenSimulation({ generatedCourse: course });

    const runTrace = () => {
      simulation.start();
      for (let tick = 0; tick < 240; tick += 1) {
        simulation.step(NEUTRAL_INTENT);
      }

      const cleared = simulation.snapshot();
      expect(cleared).toMatchObject({
        phase: "running",
        statistics: {
          obstaclesCleared: 1,
        },
      });

      for (let tick = 0; tick < 30; tick += 1) {
        simulation.step(NEUTRAL_INTENT);
      }
      expect(simulation.snapshot().statistics.obstaclesCleared).toBe(1);

      const replay = simulation.snapshot();
      return {
        tick: replay.tick,
        distance: replay.distance,
        scoreBreakdown: replay.scoreBreakdown,
        statistics: replay.statistics,
      };
    };

    const first = runTrace();
    expect(simulation.reset()).toMatchObject({
      tick: 0,
      distance: 0,
      scoreBreakdown: {
        survival: 0,
        collectibles: 0,
        precision: 0,
        total: 0,
      },
      statistics: {
        distance: 0,
        obstaclesCleared: 0,
        collectibles: 0,
        precisionLandings: 0,
        longestLiftMs: 0,
        highestDifficultyStage: 1,
      },
    });
    expect(runTrace()).toEqual(first);
  });

  it("awards one precision bonus per narrow platform and resets its replay", () => {
    const simulation = new ChickenSimulation({
      platforms: [{ id: "precision-platform", x: 0, width: 200, top: 584 }],
      worldSpeed: 1,
    });

    const runTrace = () => {
      simulation.start();

      for (let jump = 0; jump < 2; jump += 1) {
        const landingCount = simulation.snapshot().landingCount;
        simulation.step({ ...NEUTRAL_INTENT, jumpPressed: true });
        for (
          let tick = 0;
          tick < 240 && simulation.snapshot().landingCount === landingCount;
          tick += 1
        ) {
          simulation.step(NEUTRAL_INTENT);
        }
        expect(simulation.snapshot().landingCount).toBe(landingCount + 1);
      }

      const replay = simulation.snapshot();
      expect(replay.statistics.precisionLandings).toBe(1);
      expect(replay.scoreBreakdown.precision).toBe(PRECISION_LANDING_SCORE);
      expect(replay.score).toBe(replay.scoreBreakdown.total);
      return {
        tick: replay.tick,
        distance: replay.distance,
        scoreBreakdown: replay.scoreBreakdown,
        statistics: replay.statistics,
      };
    };

    const first = runTrace();
    expect(simulation.reset()).toMatchObject({
      landingCount: 0,
      score: 0,
      statistics: {
        precisionLandings: 0,
      },
    });
    expect(runTrace()).toEqual(first);
  });

  it("does not retrigger a held jump edge after landing", () => {
    const simulation = new ChickenSimulation({ platforms: ENDLESS_PLATFORM });
    simulation.start();
    simulation.step({ ...NEUTRAL_INTENT, jumpPressed: true });

    for (let tick = 0; tick < 180 && !simulation.snapshot().chicken.grounded; tick += 1) {
      simulation.step({ ...NEUTRAL_INTENT, jumpPressed: true });
    }

    const landed = simulation.snapshot();
    expect(landed.chicken.grounded).toBe(true);

    const heldAfterLanding = simulation.step({
      ...NEUTRAL_INTENT,
      jumpPressed: true,
    });
    expect(heldAfterLanding.chicken.grounded).toBe(true);
    expect(heldAfterLanding.landingCount).toBe(1);
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
      collisionZones: 2,
      pooledObjects: 2,
      destroyed: false,
    });
  });

  it("preserves a held edge across pause and resume without inventing a second jump", () => {
    const simulation = new ChickenSimulation({ platforms: ENDLESS_PLATFORM });
    simulation.start();
    simulation.step({ ...NEUTRAL_INTENT, jumpPressed: true });
    simulation.pause();

    for (let tick = 0; tick < 60; tick += 1) {
      simulation.step({ ...NEUTRAL_INTENT, jumpPressed: true, lift: 1 });
    }

    simulation.resume();
    for (let tick = 0; tick < 180 && !simulation.snapshot().chicken.grounded; tick += 1) {
      simulation.step({ ...NEUTRAL_INTENT, jumpPressed: true });
    }

    expect(simulation.snapshot().chicken.grounded).toBe(true);
    expect(simulation.step({ ...NEUTRAL_INTENT, jumpPressed: true }).chicken.grounded).toBe(true);
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
