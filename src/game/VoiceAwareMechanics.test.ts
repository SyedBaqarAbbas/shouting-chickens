import { describe, expect, it } from "vitest";

import { AUTHORED_CHUNK_TEMPLATES, type ChunkTemplate } from "../content";
import type { ControlIntent, GameplayInteractionEvent } from "../core";
import { GeneratedChunkCourse } from "./GeneratedChunkCourse";
import { COLLECTIBLE_SCORE } from "./Scoring";
import {
  CHICKEN_SCREEN_X,
  ChickenSimulation,
  FIXED_STEP_MS,
  type SimulationSnapshot,
} from "./simulation";

type PilotOptions = Readonly<{
  collectFeathers?: boolean;
  holdFirstPulse?: boolean;
  intentionalLift?: number;
}>;

type TraceResult = Readonly<{
  snapshot: SimulationSnapshot;
  events: readonly GameplayInteractionEvent[];
  intents: readonly ControlIntent[];
}>;

function templateById(templateId: string) {
  const template = AUTHORED_CHUNK_TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) {
    throw new Error(`Missing authored template ${templateId}`);
  }
  return template;
}

function courseFor(template: ChunkTemplate) {
  const course = new GeneratedChunkCourse({
    templates: [template],
    slotCount: 4,
    repeatWindow: 0,
  });
  course.reset(`mechanic-${template.id}`, "sho-16-v1");
  return course;
}

function runPilot(templateId: string, options: PilotOptions = {}): TraceResult {
  const template = templateById(templateId);
  const course = courseFor(template);
  const simulation = new ChickenSimulation({ generatedCourse: course });
  const events: GameplayInteractionEvent[] = [];
  const intents: ControlIntent[] = [];
  const pulsedPlatforms = new Set<string>();
  const pulsedHazards = new Set<string>();
  let holdingFirstPulse = false;
  let liftAssistTicks = 0;

  simulation.start();

  for (
    let tick = 0;
    tick < 1_200 &&
    simulation.snapshot().phase === "running" &&
    simulation.snapshot().currentChunkIndex < 1;
    tick += 1
  ) {
    const before = simulation.snapshot();
    const worldX = before.distance + CHICKEN_SCREEN_X;
    const geometry = course.snapshot(before.tick);
    const supportingPlatform = geometry.platforms.find(
      (platform) => platform.id === before.chicken.supportingPlatformId,
    );
    let jumpPressed = false;

    if (before.chicken.grounded && supportingPlatform) {
      const nextPlatform = geometry.platforms
        .filter(
          (platform) =>
            platform.chunkIndex === 0 &&
            platform.x >= supportingPlatform.x + supportingPlatform.width,
        )
        .sort((left, right) => left.x - right.x)[0];
      const takeoffDistance = supportingPlatform.x + supportingPlatform.width - worldX;
      const nearestSpike = geometry.spikes
        .filter((spike) => spike.chunkIndex === 0 && spike.x + spike.width >= worldX)
        .sort((left, right) => left.x - right.x)[0];
      const nearestCollectible = geometry.collectibles
        .filter(
          (collectible) =>
            collectible.chunkIndex === 0 &&
            !before.collectedCollectibleIds.includes(collectible.id) &&
            collectible.x >= worldX,
        )
        .sort((left, right) => left.x - right.x)[0];
      const needsGapPulse =
        nextPlatform !== undefined &&
        takeoffDistance <= 30 &&
        !pulsedPlatforms.has(supportingPlatform.id);
      const needsHazardPulse =
        nearestSpike !== undefined &&
        nearestSpike.x - worldX <= (nearestSpike.kind === "moving-spike" ? 110 : 38) &&
        !pulsedHazards.has(nearestSpike.id);
      const needsCollectiblePulse =
        options.collectFeathers === true &&
        nearestCollectible !== undefined &&
        nearestCollectible.x - worldX <= 78 &&
        nearestCollectible.x - worldX >= 50;

      jumpPressed = needsGapPulse || needsHazardPulse || needsCollectiblePulse;

      if (needsGapPulse) {
        pulsedPlatforms.add(supportingPlatform.id);
      }
      if (needsHazardPulse && nearestSpike) {
        pulsedHazards.add(nearestSpike.id);
        liftAssistTicks = 30;
      }
      if (jumpPressed && options.holdFirstPulse && !holdingFirstPulse) {
        holdingFirstPulse = true;
      }
    }

    if (holdingFirstPulse) {
      jumpPressed = true;
    }

    const isSustainedLiftChunk = template.voiceSkills.includes("sustained-lift");
    const lift =
      options.intentionalLift ??
      (isSustainedLiftChunk && (!before.chicken.grounded || jumpPressed)
        ? 0.82
        : liftAssistTicks > 0
          ? 0.6
          : 0);
    const intent = {
      atMs: tick * FIXED_STEP_MS,
      jumpPressed,
      lift,
    };
    intents.push(intent);
    simulation.step(intent);
    events.push(...simulation.drainInteractionEvents());
    liftAssistTicks = Math.max(0, liftAssistTicks - 1);
  }

  return {
    snapshot: simulation.snapshot(),
    events,
    intents,
  };
}

function replayIntents(templateId: string, intents: readonly ControlIntent[]) {
  const course = courseFor(templateById(templateId));
  const simulation = new ChickenSimulation({ generatedCourse: course });
  const events: GameplayInteractionEvent[] = [];
  simulation.start();

  for (const intent of intents) {
    simulation.step(intent);
    events.push(...simulation.drainInteractionEvents());
  }

  return { snapshot: simulation.snapshot(), events };
}

function runFeatherCatalog(collect: boolean) {
  const intro = templateById("feather-path-intro");
  const advanced = templateById("feather-path-advanced");
  const course = new GeneratedChunkCourse({
    templates: [intro, advanced],
    slotCount: 4,
    repeatWindow: 1,
    difficultyForChunk: () => 2,
  });
  course.reset("feather-catalog", "sho-16-v1");
  const expectedFeatherIds = course
    .snapshot(0)
    .collectibles.filter((collectible) => collectible.chunkIndex < 2)
    .map((collectible) => collectible.id);
  const simulation = new ChickenSimulation({ generatedCourse: course });
  const events: GameplayInteractionEvent[] = [];
  let assistTicks = 0;
  simulation.start();

  for (
    let tick = 0;
    tick < 1_200 &&
    simulation.snapshot().phase === "running" &&
    simulation.snapshot().currentChunkIndex < 2;
    tick += 1
  ) {
    const before = simulation.snapshot();
    const worldX = before.distance + CHICKEN_SCREEN_X;
    const nextFeather = course
      .snapshot(before.tick)
      .collectibles.filter(
        (collectible) =>
          collectible.chunkIndex < 2 &&
          collectible.x >= worldX &&
          !before.collectedCollectibleIds.includes(collectible.id),
      )
      .sort((left, right) => left.x - right.x)[0];
    const jumpPressed =
      collect &&
      before.chicken.grounded &&
      nextFeather !== undefined &&
      nextFeather.x - worldX >= 55 &&
      nextFeather.x - worldX <= 80;

    if (jumpPressed) {
      assistTicks = nextFeather.path.requiredCapability === "lift" ? 45 : 0;
    }

    simulation.step({
      atMs: tick * FIXED_STEP_MS,
      jumpPressed,
      lift: assistTicks > 0 ? 0.65 : 0,
    });
    assistTicks = Math.max(0, assistTicks - 1);
    events.push(...simulation.drainInteractionEvents());
  }

  return {
    course,
    expectedFeatherIds,
    snapshot: simulation.snapshot(),
    events,
  };
}

describe("voice-aware authored mechanics", () => {
  it("keeps retired quiet-tunnel geometry nonlethal for released and held input", () => {
    const released = runPilot("quiet-tunnel-intro");
    const held = runPilot("quiet-tunnel-intro", { intentionalLift: 1 });

    expect(released.snapshot).toMatchObject({
      phase: "running",
      currentChunkIndex: 1,
    });
    expect(held.snapshot).toMatchObject({ phase: "running", currentChunkIndex: 1 });
    expect(released.events).toEqual([]);
    expect(held.events).toEqual([]);
  });

  it("requires bounded sustained lift for the lift introduction", () => {
    const success = runPilot("lift-terraces");
    const failure = runPilot("lift-terraces", { intentionalLift: 0 });

    expect(success.snapshot).toMatchObject({
      phase: "running",
      currentChunkIndex: 1,
    });
    expect(success.intents.some((intent) => intent.lift > 0 && intent.lift < 1)).toBe(true);
    expect(failure.snapshot.phase).toBe("dead");
    expect(["water", "fall"]).toContain(failure.snapshot.deathReason);
  });

  it("requires separate pulse edges across precision islands", () => {
    const pulseChain = runPilot("precision-islands-intro");
    const heldPulse = runPilot("precision-islands-intro", { holdFirstPulse: true });

    expect(pulseChain.snapshot).toMatchObject({
      phase: "running",
      currentChunkIndex: 1,
    });
    expect(pulseChain.intents.filter((intent) => intent.jumpPressed)).toHaveLength(2);
    expect(heldPulse.snapshot.phase).toBe("dead");
  });

  it("clears static and deterministic moving hazards with pulses, but collides without one", () => {
    for (const templateId of ["spike-straight", "moving-spike-intro"] as const) {
      const success = runPilot(templateId);
      const failure = runPilot(templateId, { holdFirstPulse: false, intentionalLift: 0 });
      const neutralFailure = replayIntents(
        templateId,
        failure.intents.map((intent) => ({ ...intent, jumpPressed: false })),
      );

      expect(success.snapshot).toMatchObject({
        phase: "running",
        currentChunkIndex: 1,
      });
      expect(neutralFailure.snapshot).toMatchObject({
        phase: "dead",
        deathReason: "hazard",
      });
      expect(
        neutralFailure.events.filter((event) => event.type === "hazard-collision"),
      ).toHaveLength(1);
    }
  });

  it("keeps feather paths optional and rewards every one-shot collection explicitly", () => {
    const fallback = runFeatherCatalog(false);
    const collector = runFeatherCatalog(true);
    const collectionEvents = collector.events.filter(
      (event) => event.type === "collectible-collected",
    );

    expect(fallback.snapshot).toMatchObject({
      phase: "running",
      currentChunkIndex: 2,
      collectedCollectibleIds: [],
    });
    expect(collector.snapshot).toMatchObject({
      phase: "running",
      currentChunkIndex: 2,
    });
    expect(collectionEvents.map((event) => event.value.id).sort()).toEqual(
      collector.expectedFeatherIds.sort(),
    );
    expect(new Set(collectionEvents.map((event) => event.value.id)).size).toBe(
      collectionEvents.length,
    );
    expect(collector.snapshot.scoreBreakdown.survival).toBe(
      fallback.snapshot.scoreBreakdown.survival,
    );
    expect(collector.snapshot.scoreBreakdown.collectibles).toBe(
      collectionEvents.length * COLLECTIBLE_SCORE,
    );
    expect(collector.snapshot.score).toBe(
      fallback.snapshot.score + collectionEvents.length * COLLECTIBLE_SCORE,
    );
  });

  it("replays the same mechanic trace for voice and keyboard-touch ControlIntent equivalents", () => {
    const voice = runPilot("precision-islands-intro");
    const fallback = replayIntents("precision-islands-intro", voice.intents);

    expect(fallback.snapshot).toEqual(voice.snapshot);
    expect(fallback.events).toEqual(voice.events);
  });

  it("resets collision and collection dedupe on the same simulation instance", () => {
    const hazardCourse = courseFor(templateById("spike-straight"));
    const hazardSimulation = new ChickenSimulation({ generatedCourse: hazardCourse });
    const collide = () => {
      const events: GameplayInteractionEvent[] = [];
      hazardSimulation.start();
      for (let tick = 0; tick < 400 && hazardSimulation.snapshot().phase === "running"; tick += 1) {
        hazardSimulation.step({
          atMs: tick * FIXED_STEP_MS,
          jumpPressed: false,
          lift: 0,
        });
        events.push(...hazardSimulation.drainInteractionEvents());
      }
      return events;
    };

    const firstCollision = collide();
    hazardSimulation.reset();
    const secondCollision = collide();
    expect(secondCollision).toEqual(firstCollision);
    expect(firstCollision).toHaveLength(1);

    const featherCourse = courseFor(templateById("feather-path-intro"));
    const featherSimulation = new ChickenSimulation({ generatedCourse: featherCourse });
    const collect = () => {
      const events: GameplayInteractionEvent[] = [];
      let collected = false;
      featherSimulation.start();
      for (let tick = 0; tick < 300 && !collected; tick += 1) {
        const before = featherSimulation.snapshot();
        const worldX = before.distance + CHICKEN_SCREEN_X;
        const firstFeather = featherCourse
          .snapshot(before.tick)
          .collectibles.find((collectible) => collectible.chunkIndex === 0)!;
        const distanceToFeather = firstFeather.x - worldX;
        featherSimulation.step({
          atMs: tick * FIXED_STEP_MS,
          jumpPressed:
            before.chicken.grounded && distanceToFeather >= 55 && distanceToFeather <= 80,
          lift: 0,
        });
        const nextEvents = featherSimulation.drainInteractionEvents();
        events.push(...nextEvents);
        collected ||= nextEvents.some((event) => event.type === "collectible-collected");
      }
      return events.filter((event) => event.type === "collectible-collected");
    };

    const firstCollection = collect();
    featherSimulation.reset();
    const secondCollection = collect();
    expect(firstCollection).toHaveLength(1);
    expect(secondCollection).toEqual(firstCollection);
  });
});
