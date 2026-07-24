import { describe, expect, it } from "vitest";

import type { ControlIntent } from "../core";
import {
  COURSE_LENGTH,
  COURSE_TRAVERSAL_ENVELOPE,
  LOOPING_COURSE_PLATFORMS,
  LOOPING_COURSE_SEGMENTS,
  LOOPING_COURSE_SPIKES,
  LOOPING_COURSE_WATER,
  projectLoopingWorldX,
  wrapCourseCoordinate,
} from "./course";
import {
  CHICKEN_BODY_HEIGHT,
  ChickenSimulation,
  FALL_DEATH_Y,
  FIXED_STEP_MS,
  SURVIVAL_SCORE_INTERVAL_MS,
  type PlatformDefinition,
} from "./simulation";

const NEUTRAL_INTENT: ControlIntent = {
  atMs: 0,
  jumpPressed: false,
  lift: 0,
};

const COURSE_JUMP_TICKS = new Set([82, 287, 445, 660, 800]);

function authoredCourseIntent(tick: number): ControlIntent {
  return {
    atMs: tick * FIXED_STEP_MS,
    jumpPressed: COURSE_JUMP_TICKS.has(tick),
    lift: (tick >= 445 && tick < 465) || (tick >= 800 && tick < 820) ? 0.8 : 0,
  };
}

function runAuthoredCourseTrace() {
  const simulation = new ChickenSimulation();
  const landedPlatforms = new Set<string>();
  const trace = [];
  simulation.start();

  for (let tick = 0; tick < 1_100 && simulation.snapshot().phase === "running"; tick += 1) {
    const snapshot = simulation.step(authoredCourseIntent(tick));

    if (snapshot.chicken.grounded && snapshot.chicken.supportingPlatformId) {
      landedPlatforms.add(snapshot.chicken.supportingPlatformId);
    }

    if (tick % 60 === 0 || snapshot.landingCount > (trace.at(-1)?.landingCount ?? 0)) {
      trace.push(snapshot);
    }
  }

  return {
    final: simulation.snapshot(),
    landedPlatforms: [...landedPlatforms],
    trace,
  };
}

describe("authored looping course", () => {
  it("keeps every challenge inside the documented jump and landing envelope", () => {
    const gaps = LOOPING_COURSE_SEGMENTS.filter((segment) => segment.horizontalGap > 0);

    expect(Math.max(...gaps.map((segment) => segment.horizontalGap))).toBeLessThanOrEqual(
      COURSE_TRAVERSAL_ENVELOPE.maximumAuthoredGap,
    );
    expect(Math.max(...gaps.map((segment) => segment.verticalRise))).toBeLessThanOrEqual(
      COURSE_TRAVERSAL_ENVELOPE.maximumAuthoredRise,
    );
    expect(Math.min(...gaps.map((segment) => segment.approachWidth))).toBeGreaterThanOrEqual(
      COURSE_TRAVERSAL_ENVELOPE.minimumApproachWidth,
    );
    expect(Math.min(...gaps.map((segment) => segment.landingWidth))).toBeGreaterThanOrEqual(
      COURSE_TRAVERSAL_ENVELOPE.minimumLandingWidth,
    );
    expect(LOOPING_COURSE_PLATFORMS.map((platform) => platform.id)).toEqual([
      "safe-start",
      "small-gap-landing",
      "fall-gap-landing",
      "lift-gap-landing",
      "spike-approach",
    ]);
    expect(LOOPING_COURSE_SPIKES).toHaveLength(1);
    expect(LOOPING_COURSE_WATER.length).toBeGreaterThan(0);
  });

  it("replays one fixed trace across every segment and into the next loop", () => {
    const first = runAuthoredCourseTrace();
    const second = runAuthoredCourseTrace();

    expect(second).toEqual(first);
    expect(first.final).toMatchObject({
      phase: "running",
      loopsCompleted: 1,
      deathReason: null,
    });
    expect(first.landedPlatforms).toEqual(
      expect.arrayContaining([
        "safe-start",
        "small-gap-landing",
        "fall-gap-landing",
        "lift-gap-landing",
        "spike-approach",
      ]),
    );
  });

  it("projects one fixed object pool continuously across the course seam", () => {
    expect(wrapCourseCoordinate(COURSE_LENGTH + 12)).toBe(12);
    expect(projectLoopingWorldX(-160, COURSE_LENGTH - 20)).toBe(-140);
    expect(projectLoopingWorldX(2_075, 2_000)).toBe(75);
  });
});

describe("course collision and score lifecycle", () => {
  const startPlatform: readonly PlatformDefinition[] = [
    { id: "start", x: -200, width: 560, top: 584 },
  ];

  function runUntilDead(simulation: ChickenSimulation) {
    simulation.start();
    for (let tick = 0; tick < 600 && simulation.snapshot().phase === "running"; tick += 1) {
      simulation.step(NEUTRAL_INTENT);
    }
    return simulation.snapshot();
  }

  it.each([
    {
      name: "water",
      simulation: () =>
        new ChickenSimulation({
          platforms: startPlatform,
          water: [{ id: "pool", x: 350, width: 500, top: 704 }],
        }),
      expected: { deathReason: "water", collisionId: "pool" },
    },
    {
      name: "fall",
      simulation: () => new ChickenSimulation({ platforms: startPlatform, water: [] }),
      expected: { deathReason: "fall", collisionId: "void" },
    },
    {
      name: "spike",
      simulation: () =>
        new ChickenSimulation({
          platforms: [{ id: "floor", x: -200, width: 2_000, top: 584 }],
          spikes: [{ id: "spike", x: 220, width: 46, baseTop: 584, height: 38 }],
          water: [],
        }),
      expected: { deathReason: "hazard", collisionId: "spike" },
    },
  ])("ends $name collision once and freezes its exact score tick", ({ simulation, expected }) => {
    const game = simulation();
    const ended = runUntilDead(game);
    const expectedScore = Math.floor(ended.elapsedMs / SURVIVAL_SCORE_INTERVAL_MS);

    expect(ended).toMatchObject({
      phase: "dead",
      score: expectedScore,
      ...expected,
      chicken: {
        animation: "death",
        grounded: false,
        velocityY: 0,
      },
    });

    for (let tick = 0; tick < 120; tick += 1) {
      game.step({ ...NEUTRAL_INTENT, jumpPressed: true, lift: 1 });
    }

    expect(game.snapshot()).toEqual(ended);
  });

  it("uses the lower fall boundary only when no water collision zone is present", () => {
    const game = new ChickenSimulation({ platforms: startPlatform, water: [] });
    const ended = runUntilDead(game);

    expect(ended.deathReason).toBe("fall");
    expect(ended.chicken.y + CHICKEN_BODY_HEIGHT / 2).toBeGreaterThanOrEqual(FALL_DEATH_Y);
  });
});
