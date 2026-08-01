import { describe, expect, it } from "vitest";

import {
  AUTHORED_CHUNK_TEMPLATES,
  areChunkBoundariesCompatible,
  type ChunkTemplate,
} from "../content";
import {
  DIFFICULTY_PROFILES,
  MAX_DIFFICULTY_WORLD_SPEED,
  type DifficultyProfile,
} from "./DifficultyProgression";
import { GeneratedChunkCourse } from "./GeneratedChunkCourse";
import { PRECISION_LANDING_SCORE } from "./Scoring";
import {
  CHICKEN_SCREEN_X,
  ChickenSimulation,
  FIXED_STEP_MS,
  type SimulationDiagnostics,
} from "./simulation";

const NEUTRAL_INTENT = Object.freeze({
  atMs: 0,
  jumpPressed: false,
  lift: 0,
});

function activeTemplateIds(course: GeneratedChunkCourse) {
  return course.snapshot().chunks.map((chunk) => chunk.templateId);
}

function runReachableTemplate(
  templateId: string,
  targetChunkIndex: number,
  progression?: DifficultyProfile,
) {
  const template = AUTHORED_CHUNK_TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) {
    throw new Error(`Missing authored template ${templateId}`);
  }

  const course = new GeneratedChunkCourse({
    templates: [template],
    slotCount: 5,
    repeatWindow: 0,
    difficultyForChunk: progression ? () => template.minimumDifficulty : undefined,
    progressionForChunk: progression ? () => progression : undefined,
  });
  course.reset(`trace-${templateId}`, "gameplay-v1");
  const simulation = new ChickenSimulation({ generatedCourse: course });
  const jumpedSupports = new Set<string>();
  simulation.start();

  for (
    let tick = 0;
    tick < 20_000 &&
    simulation.snapshot().phase === "running" &&
    simulation.snapshot().currentChunkIndex < targetChunkIndex;
    tick += 1
  ) {
    const before = simulation.snapshot();
    const worldX = before.distance + CHICKEN_SCREEN_X;
    const geometry = course.snapshot();
    const supportingPlatform = geometry.platforms.find(
      (platform) => platform.id === before.chicken.supportingPlatformId,
    );
    let jumpPressed = false;

    if (before.chicken.grounded && supportingPlatform) {
      const nextPlatform = geometry.platforms
        .filter((platform) => platform.x >= supportingPlatform.x + supportingPlatform.width)
        .sort((left, right) => left.x - right.x)[0];
      const gap = nextPlatform
        ? nextPlatform.x - (supportingPlatform.x + supportingPlatform.width)
        : 0;
      const spikeAhead = geometry.spikes.some(
        (spike) =>
          spike.x >= worldX &&
          spike.x - worldX <= 90 &&
          spike.x < supportingPlatform.x + supportingPlatform.width,
      );
      const takeoffDistance = supportingPlatform.x + supportingPlatform.width - worldX;

      jumpPressed =
        !jumpedSupports.has(supportingPlatform.id) &&
        takeoffDistance <= 82 &&
        (gap > 0 || spikeAhead);

      if (jumpPressed) {
        jumpedSupports.add(supportingPlatform.id);
      }
    }

    simulation.step({
      atMs: tick * FIXED_STEP_MS,
      jumpPressed,
      lift: jumpPressed || !before.chicken.grounded ? 0.8 : 0,
    });
  }

  return { course, simulation };
}

const CONTINUOUS_TEMPLATES = [
  {
    id: "continuous-a",
    width: 200,
    minimumDifficulty: 1,
    maximumDifficulty: 1,
    challengeStage: "introduction",
    mechanics: [],
    requiresIntroductions: [],
    voiceSkills: [],
    entry: { platformId: "ground" },
    exit: { platformId: "ground" },
    requiredCapability: "run",
    platforms: [{ id: "ground", x: 0, width: 200, top: 584 }],
    hazards: [
      {
        id: "retention-marker",
        kind: "quiet-zone",
        x: 100,
        width: 20,
        top: 0,
        bottom: 1,
        maximumLift: 1,
      },
    ],
    collectibles: [
      {
        id: "feather",
        kind: "feather",
        x: 100,
        y: 520,
        radius: 10,
        optional: true,
        path: {
          fromPlatformId: "ground",
          requiredCapability: "jump",
        },
      },
    ],
    warnings: [],
    route: [],
  },
  {
    id: "continuous-b",
    width: 200,
    minimumDifficulty: 1,
    maximumDifficulty: 1,
    challengeStage: "introduction",
    mechanics: [],
    requiresIntroductions: [],
    voiceSkills: [],
    entry: { platformId: "ground" },
    exit: { platformId: "ground" },
    requiredCapability: "run",
    platforms: [{ id: "ground", x: 0, width: 200, top: 584 }],
    hazards: [
      {
        id: "retention-marker",
        kind: "quiet-zone",
        x: 100,
        width: 20,
        top: 0,
        bottom: 1,
        maximumLift: 1,
      },
    ],
    collectibles: [],
    warnings: [],
    route: [],
  },
] as const satisfies readonly ChunkTemplate[];

describe("GeneratedChunkCourse", () => {
  it("replays identical placements for the same version, seed, and focus trace", () => {
    const first = new GeneratedChunkCourse();
    const second = new GeneratedChunkCourse();
    first.reset("repeatable", "gameplay-v1");
    second.reset("repeatable", "gameplay-v1");

    for (let focus = CHICKEN_SCREEN_X; focus < 60_000; focus += 347) {
      const firstSnapshot = first.updateForFocus(focus);
      const secondSnapshot = second.updateForFocus(focus);
      expect(secondSnapshot).toEqual(firstSnapshot);
    }

    const otherSeed = new GeneratedChunkCourse();
    otherSeed.reset("different", "gameplay-v1");
    expect(activeTemplateIds(otherSeed)).not.toEqual(activeTemplateIds(first));

    const otherVersion = new GeneratedChunkCourse();
    otherVersion.reset("repeatable", "gameplay-v2");
    expect(activeTemplateIds(otherVersion)).not.toEqual(activeTemplateIds(first));
  });

  it("keeps fixed pool capacities and consecutive reachable chunks over long recycling", () => {
    const course = new GeneratedChunkCourse({ slotCount: 7, repeatWindow: 2 });
    course.reset("long-course", "gameplay-v1");
    const capacities = course.poolCapacities();
    let previousRecycled = 0;

    for (let focus = CHICKEN_SCREEN_X; focus < 900_000; focus += 421) {
      const snapshot = course.updateForFocus(focus);
      const diagnostics = course.diagnostics(focus);

      expect(snapshot.poolCapacities).toEqual(capacities);
      expect(snapshot.chunks).toHaveLength(capacities.chunkSlots);
      expect(snapshot.platforms.length).toBeLessThanOrEqual(capacities.platforms);
      expect(
        snapshot.spikes.length + snapshot.water.length + snapshot.quietZones.length,
      ).toBeLessThanOrEqual(capacities.hazards);
      expect(snapshot.collectibles.length).toBeLessThanOrEqual(capacities.collectibles);
      expect(snapshot.warnings.length).toBeLessThanOrEqual(capacities.warnings);
      expect(new Set(snapshot.platforms.map((platform) => platform.id)).size).toBe(
        snapshot.platforms.length,
      );
      expect(diagnostics.recycledChunks).toBeGreaterThanOrEqual(previousRecycled);
      expect(diagnostics.aheadDistance).toBeGreaterThan(4_000);
      expect(diagnostics.behindDistance).toBeGreaterThanOrEqual(0);
      previousRecycled = diagnostics.recycledChunks;

      for (let index = 1; index < snapshot.chunks.length; index += 1) {
        const previous = snapshot.chunks[index - 1]!;
        const current = snapshot.chunks[index]!;
        expect(current.chunkIndex).toBe(previous.chunkIndex + 1);
        expect(current.originX).toBe(previous.originX + previous.width);

        const previousTemplate = AUTHORED_CHUNK_TEMPLATES.find(
          (template) => template.id === previous.templateId,
        )!;
        const currentTemplate = AUTHORED_CHUNK_TEMPLATES.find(
          (template) => template.id === current.templateId,
        )!;
        expect(areChunkBoundariesCompatible(previousTemplate, currentTemplate)).toBe(true);
      }
    }

    expect(previousRecycled).toBeGreaterThan(900);
  });

  it("derives moving hazards only from run identity, chunk instance, and fixed tick", () => {
    const template = AUTHORED_CHUNK_TEMPLATES.find(
      (candidate) => candidate.id === "moving-spike-intro",
    )!;
    const first = new GeneratedChunkCourse({
      templates: [template],
      slotCount: 3,
      repeatWindow: 0,
    });
    const replay = new GeneratedChunkCourse({
      templates: [template],
      slotCount: 3,
      repeatWindow: 0,
    });
    first.reset("moving-seed", "gameplay-v2");
    replay.reset("moving-seed", "gameplay-v2");

    const ticks = [0, 1, 17, 60, 119, 120, 721];
    const firstTrace = ticks.map((tick) => first.snapshot(tick).spikes);
    const replayTrace = ticks.map((tick) => replay.snapshot(tick).spikes);

    expect(replayTrace).toEqual(firstTrace);
    expect(first.snapshot(17).spikes).toEqual(first.snapshot(17).spikes);
    expect(first.snapshot(0).spikes[0]?.motion).toMatchObject({
      axis: "horizontal",
      periodTicks: 120,
    });
    expect(first.snapshot(0).spikes[0]?.id).toBe("0:moving-spike-intro:moving-spike");
    expect(first.snapshot(0).spikes[1]?.id).toBe("1:moving-spike-intro:moving-spike");

    const otherSeed = new GeneratedChunkCourse({
      templates: [template],
      slotCount: 3,
      repeatWindow: 0,
    });
    otherSeed.reset("other-moving-seed", "gameplay-v2");
    expect(otherSeed.snapshot(17).spikes.map((spike) => spike.motion?.phaseTick)).not.toEqual(
      first.snapshot(17).spikes.map((spike) => spike.motion?.phaseTick),
    );
  });

  it("instance-qualifies all gameplay and warning identities across recycled slots", () => {
    const course = new GeneratedChunkCourse({ slotCount: 6 });
    course.reset("instance-ids", "gameplay-v2");

    for (let focus = CHICKEN_SCREEN_X; focus < 30_000; focus += 731) {
      const snapshot = course.updateForFocus(focus, Math.floor(focus));
      const ids = [
        ...snapshot.platforms,
        ...snapshot.spikes,
        ...snapshot.water,
        ...snapshot.quietZones,
        ...snapshot.collectibles,
        ...snapshot.warnings,
      ].map((entity) => entity.id);

      expect(new Set(ids).size).toBe(ids.length);
      for (const entity of [
        ...snapshot.platforms,
        ...snapshot.spikes,
        ...snapshot.water,
        ...snapshot.quietZones,
        ...snapshot.collectibles,
        ...snapshot.warnings,
      ]) {
        expect(entity.id).toMatch(
          new RegExp(`^${entity.chunkIndex}:${entity.templateId.replaceAll("-", "\\-")}:`),
        );
      }
    }
  });

  it("bounds retained scoring identities through more than one hundred recycled chunks", () => {
    const course = new GeneratedChunkCourse({
      templates: CONTINUOUS_TEMPLATES,
      slotCount: 5,
      repeatWindow: 1,
      supportedCapabilities: ["run"],
    });
    course.reset("simulation", "gameplay-v1");
    const simulation = new ChickenSimulation({ generatedCourse: course });
    simulation.start();
    const stablePool = simulation.diagnostics().pooledObjects;
    let lastDiagnostics: SimulationDiagnostics | null = null;
    let maximumRetainedCollectibles = 0;
    let maximumRetainedObstacles = 0;
    let maximumRetainedPrecisionLandings = 0;

    for (let tick = 0; tick < 42_000; tick += 1) {
      const before = simulation.snapshot();
      const snapshot = simulation.step({
        ...NEUTRAL_INTENT,
        atMs: tick * FIXED_STEP_MS,
        jumpPressed: before.chicken.grounded,
      });

      expect(snapshot.phase).toBe("running");

      if (tick % 60 === 0) {
        lastDiagnostics = simulation.diagnostics();
        maximumRetainedCollectibles = Math.max(
          maximumRetainedCollectibles,
          lastDiagnostics.retainedCollectibleIds,
        );
        maximumRetainedObstacles = Math.max(
          maximumRetainedObstacles,
          lastDiagnostics.retainedObstacleIds,
        );
        maximumRetainedPrecisionLandings = Math.max(
          maximumRetainedPrecisionLandings,
          lastDiagnostics.retainedPrecisionLandingIds,
        );
        expect(lastDiagnostics.pooledObjects).toBe(stablePool);
        expect(lastDiagnostics.retainedCollectibleIds).toBeLessThanOrEqual(
          course.poolCapacities().collectibles,
        );
        expect(lastDiagnostics.retainedPrecisionLandingIds).toBeLessThanOrEqual(
          course.poolCapacities().platforms,
        );
        expect(lastDiagnostics.retainedObstacleIds).toBeLessThanOrEqual(
          course.poolCapacities().hazards,
        );
      }
    }

    expect(simulation.snapshot().currentChunkIndex).toBeGreaterThan(100);
    expect(simulation.snapshot().statistics.collectibles).toBeGreaterThan(100);
    expect(simulation.snapshot().statistics.obstaclesCleared).toBeGreaterThan(100);
    expect(simulation.snapshot().statistics.precisionLandings).toBeGreaterThan(100);
    expect(maximumRetainedCollectibles).toBeGreaterThan(0);
    expect(maximumRetainedObstacles).toBeGreaterThan(0);
    expect(maximumRetainedPrecisionLandings).toBeGreaterThan(0);
    expect(
      course.diagnostics(simulation.snapshot().distance + CHICKEN_SCREEN_X).recycledChunks,
    ).toBe(simulation.snapshot().currentChunkIndex - 1);
    expect(lastDiagnostics).toMatchObject({
      activeBodies: 1,
      activeTimers: 0,
      pooledObjects: stablePool,
      destroyed: false,
    });
  });

  it.each([
    ["meadow-hop", 10, 0],
    ["lift-terraces", 8, 1],
  ] as const)(
    "replays deterministic jump/lift controls through reachable %s gaps",
    (templateId, targetChunkIndex, minimumPrecisionLandings) => {
      const first = runReachableTemplate(templateId, targetChunkIndex);
      const second = runReachableTemplate(templateId, targetChunkIndex);

      expect(first.simulation.snapshot()).toEqual(second.simulation.snapshot());
      expect(first.course.snapshot()).toEqual(second.course.snapshot());
      expect(first.simulation.snapshot()).toMatchObject({
        phase: "running",
        currentChunkIndex: targetChunkIndex,
        deathReason: null,
      });
      expect(first.simulation.snapshot().landingCount).toBeGreaterThanOrEqual(targetChunkIndex);
      expect(first.simulation.snapshot().statistics.precisionLandings).toBeGreaterThanOrEqual(
        minimumPrecisionLandings,
      );
      expect(first.simulation.snapshot().scoreBreakdown.precision).toBe(
        first.simulation.snapshot().statistics.precisionLandings * PRECISION_LANDING_SCORE,
      );
      expect(first.course.snapshot().recycledChunks).toBeGreaterThan(0);
      expect(first.simulation.diagnostics().pooledObjects).toBe(
        first.course.poolCapacities().total,
      );
    },
  );

  it.each(["meadow-hop", "lift-terraces"] as const)(
    "keeps representative %s traversal reachable at the configured speed cap",
    (templateId) => {
      const capped = runReachableTemplate(templateId, 8, DIFFICULTY_PROFILES.at(-1)!);

      expect(capped.simulation.snapshot()).toMatchObject({
        phase: "running",
        currentChunkIndex: 8,
        worldSpeed: MAX_DIFFICULTY_WORLD_SPEED,
        difficultyStage: 5,
      });
      expect(capped.simulation.snapshot().deathReason).toBeNull();
    },
  );

  it("resets every recycled slot and object identity back to the seed origin", () => {
    const course = new GeneratedChunkCourse();
    const initial = course.reset("resettable", "gameplay-v1");
    course.updateForFocus(250_000);
    expect(course.snapshot().recycledChunks).toBeGreaterThan(200);

    const reset = course.reset("resettable", "gameplay-v1");
    expect({ ...reset, revision: initial.revision }).toEqual(initial);
    expect(course.diagnostics(CHICKEN_SCREEN_X)).toMatchObject({
      firstChunkIndex: 0,
      lastChunkIndex: 5,
      recycledChunks: 0,
    });
  });
});
