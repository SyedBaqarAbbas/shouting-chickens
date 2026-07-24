import type { ControlIntent, RunEndReason } from "../core";
import {
  COURSE_LENGTH,
  COURSE_WORLD_SPEED,
  LOOPING_COURSE_PLATFORMS,
  LOOPING_COURSE_SPIKES,
  LOOPING_COURSE_WATER,
  wrapCourseCoordinate,
  type PlatformDefinition,
  type SpikeHazardDefinition,
  type WaterZoneDefinition,
} from "./course";
import {
  FixedStepPlayerController,
  type PlayerControllerTuning,
} from "./FixedStepPlayerController";

export const LOGICAL_GAME_WIDTH = 432;
export const LOGICAL_GAME_HEIGHT = 768;
export const FIXED_STEP_HZ = 60;
export const FIXED_STEP_MS = 1000 / FIXED_STEP_HZ;

export const CHICKEN_SCREEN_X = 112;
export const CHICKEN_BODY_WIDTH = 42;
export const CHICKEN_BODY_HEIGHT = 54;
export const WATER_DEATH_Y = 704;
export const FALL_DEATH_Y = LOGICAL_GAME_HEIGHT + CHICKEN_BODY_HEIGHT;
export const FIXED_WORLD_SPEED = COURSE_WORLD_SPEED;
export const SURVIVAL_SCORE_INTERVAL_MS = 100;

const STEP_SECONDS = 1 / FIXED_STEP_HZ;
const LANDING_EPSILON = 0.001;

export type ChickenAnimationState = "idle" | "run" | "jump" | "flap" | "death";
export type SimulationPhase = "ready" | "running" | "paused" | "dead";
export type SimulationDeathReason = Extract<RunEndReason, "water" | "fall" | "hazard">;

export type SimulationSnapshot = {
  phase: SimulationPhase;
  tick: number;
  elapsedMs: number;
  score: number;
  distance: number;
  courseDistance: number;
  loopsCompleted: number;
  chicken: {
    x: number;
    y: number;
    velocityY: number;
    grounded: boolean;
    supportingPlatformId: string | null;
    animation: ChickenAnimationState;
  };
  deathReason: SimulationDeathReason | null;
  collisionId: string | null;
  landingCount: number;
};

export type SimulationDiagnostics = {
  activeBodies: number;
  activeTimers: number;
  collisionZones: number;
  pooledObjects: number;
  destroyed: boolean;
};

export const FOUNDATION_PLATFORMS = LOOPING_COURSE_PLATFORMS;
export type { PlatformDefinition } from "./course";

export type SimulationOptions = {
  platforms?: readonly PlatformDefinition[];
  spikes?: readonly SpikeHazardDefinition[];
  water?: readonly WaterZoneDefinition[] | null;
  courseLength?: number | null;
  worldSpeed?: number;
  playerTuning?: PlayerControllerTuning;
};

type PlatformInstance = PlatformDefinition & {
  worldX: number;
};

type SpikeInstance = SpikeHazardDefinition & {
  worldX: number;
};

type WaterInstance = WaterZoneDefinition & {
  worldX: number;
};

function copySnapshot(snapshot: SimulationSnapshot): SimulationSnapshot {
  return {
    ...snapshot,
    chicken: { ...snapshot.chicken },
  };
}

function validateHorizontalDefinitions(
  definitions: readonly Readonly<{ id: string; x: number; width: number }>[],
  kind: string,
) {
  for (const definition of definitions) {
    if (
      !definition.id ||
      !Number.isFinite(definition.x) ||
      !Number.isFinite(definition.width) ||
      definition.width <= 0
    ) {
      throw new RangeError(`Every ${kind} needs a finite position and positive width`);
    }
  }
}

function validatePlatforms(platforms: readonly PlatformDefinition[]) {
  validateHorizontalDefinitions(platforms, "platform");

  for (const platform of platforms) {
    if (!Number.isFinite(platform.top)) {
      throw new RangeError("Every platform needs a finite top");
    }
  }
}

function validateSpikes(spikes: readonly SpikeHazardDefinition[]) {
  validateHorizontalDefinitions(spikes, "spike");

  for (const spike of spikes) {
    if (!Number.isFinite(spike.baseTop) || !Number.isFinite(spike.height) || spike.height <= 0) {
      throw new RangeError("Every spike needs a finite base and positive height");
    }
  }
}

function validateWater(water: readonly WaterZoneDefinition[]) {
  validateHorizontalDefinitions(water, "water zone");

  for (const zone of water) {
    if (!Number.isFinite(zone.top)) {
      throw new RangeError("Every water zone needs a finite top");
    }
  }
}

function repeatedInstances<T extends Readonly<{ x: number }>>(
  definitions: readonly T[],
  aroundWorldX: number,
  courseLength: number | null,
): readonly (T & { worldX: number })[] {
  if (courseLength === null) {
    return definitions.map((definition) => ({ ...definition, worldX: definition.x }));
  }

  const centerCycle = Math.floor(aroundWorldX / courseLength);
  const instances: (T & { worldX: number })[] = [];

  for (let cycle = centerCycle - 1; cycle <= centerCycle + 1; cycle += 1) {
    for (const definition of definitions) {
      instances.push({
        ...definition,
        worldX: definition.x + cycle * courseLength,
      });
    }
  }

  return instances;
}

function platformSupportsChicken(
  platform: PlatformInstance,
  chickenWorldX: number,
  chickenY: number,
) {
  const chickenLeft = chickenWorldX - CHICKEN_BODY_WIDTH / 2;
  const chickenRight = chickenWorldX + CHICKEN_BODY_WIDTH / 2;
  const chickenBottom = chickenY + CHICKEN_BODY_HEIGHT / 2;

  return (
    chickenRight > platform.worldX &&
    chickenLeft < platform.worldX + platform.width &&
    Math.abs(chickenBottom - platform.top) <= LANDING_EPSILON
  );
}

function canLandOnPlatform(
  platform: PlatformInstance,
  chickenWorldX: number,
  previousBottom: number,
  nextBottom: number,
) {
  const chickenLeft = chickenWorldX - CHICKEN_BODY_WIDTH / 2;
  const chickenRight = chickenWorldX + CHICKEN_BODY_WIDTH / 2;

  return (
    chickenRight > platform.worldX &&
    chickenLeft < platform.worldX + platform.width &&
    previousBottom <= platform.top + LANDING_EPSILON &&
    nextBottom >= platform.top
  );
}

function intersectsSpike(
  spike: SpikeInstance,
  previousWorldX: number,
  nextWorldX: number,
  chickenY: number,
) {
  const sweptLeft = Math.min(previousWorldX, nextWorldX) - CHICKEN_BODY_WIDTH / 2;
  const sweptRight = Math.max(previousWorldX, nextWorldX) + CHICKEN_BODY_WIDTH / 2;
  const chickenTop = chickenY - CHICKEN_BODY_HEIGHT / 2;
  const chickenBottom = chickenY + CHICKEN_BODY_HEIGHT / 2;
  const spikeTop = spike.baseTop - spike.height;

  return (
    sweptRight > spike.worldX &&
    sweptLeft < spike.worldX + spike.width &&
    chickenBottom > spikeTop &&
    chickenTop < spike.baseTop
  );
}

function isOverWater(zone: WaterInstance, chickenWorldX: number, chickenBottom: number) {
  return (
    chickenWorldX >= zone.worldX &&
    chickenWorldX <= zone.worldX + zone.width &&
    chickenBottom >= zone.top
  );
}

export class ChickenSimulation {
  readonly platforms: readonly PlatformDefinition[];
  readonly spikes: readonly SpikeHazardDefinition[];
  readonly water: readonly WaterZoneDefinition[] | null;
  readonly courseLength: number | null;
  readonly worldSpeed: number;

  private destroyed = false;
  private readonly playerController: FixedStepPlayerController;
  private snapshotValue: SimulationSnapshot;

  constructor(options: SimulationOptions = {}) {
    const usesAuthoredCourse = options.platforms === undefined;
    const platforms = options.platforms ?? LOOPING_COURSE_PLATFORMS;
    const spikes = options.spikes ?? (usesAuthoredCourse ? LOOPING_COURSE_SPIKES : []);
    const water =
      options.water === undefined
        ? usesAuthoredCourse
          ? LOOPING_COURSE_WATER
          : null
        : options.water;
    const courseLength =
      options.courseLength === undefined
        ? usesAuthoredCourse
          ? COURSE_LENGTH
          : null
        : options.courseLength;
    const worldSpeed = options.worldSpeed ?? FIXED_WORLD_SPEED;

    validatePlatforms(platforms);
    validateSpikes(spikes);
    if (water) {
      validateWater(water);
    }

    if (courseLength !== null && (!Number.isFinite(courseLength) || courseLength <= 0)) {
      throw new RangeError("Course length must be a positive finite number or null");
    }

    if (!Number.isFinite(worldSpeed) || worldSpeed <= 0) {
      throw new RangeError("World speed must be a positive finite number");
    }

    this.platforms = platforms.map((platform) => Object.freeze({ ...platform }));
    this.spikes = spikes.map((spike) => Object.freeze({ ...spike }));
    this.water = water?.map((zone) => Object.freeze({ ...zone })) ?? water;
    this.courseLength = courseLength;
    this.worldSpeed = worldSpeed;
    this.playerController = new FixedStepPlayerController(options.playerTuning);
    this.snapshotValue = this.createInitialSnapshot();
  }

  start() {
    this.assertAlive();

    if (this.snapshotValue.phase === "dead") {
      throw new Error("Reset the simulation before starting a completed run");
    }

    this.snapshotValue.phase = "running";
    this.snapshotValue.chicken.animation = "run";
    return this.snapshot();
  }

  pause() {
    this.assertAlive();

    if (this.snapshotValue.phase === "running") {
      this.snapshotValue.phase = "paused";
      this.snapshotValue.chicken.animation = this.snapshotValue.chicken.grounded
        ? "idle"
        : this.snapshotValue.chicken.animation;
    }

    return this.snapshot();
  }

  resume() {
    this.assertAlive();

    if (this.snapshotValue.phase === "paused") {
      this.snapshotValue.phase = "running";
      this.snapshotValue.chicken.animation = this.snapshotValue.chicken.grounded
        ? "run"
        : this.snapshotValue.chicken.animation;
    }

    return this.snapshot();
  }

  reset() {
    this.assertAlive();
    this.playerController.reset();
    this.snapshotValue = this.createInitialSnapshot();
    return this.snapshot();
  }

  step(intent: ControlIntent) {
    this.assertAlive();

    if (this.snapshotValue.phase !== "running") {
      return this.snapshot();
    }

    const state = this.snapshotValue;
    const chicken = state.chicken;
    const previousWorldX = state.distance + CHICKEN_SCREEN_X;

    state.tick += 1;
    state.elapsedMs = state.tick * FIXED_STEP_MS;
    state.score = Math.floor(state.elapsedMs / SURVIVAL_SCORE_INTERVAL_MS);
    state.distance += this.worldSpeed * STEP_SECONDS;
    state.courseDistance =
      this.courseLength === null
        ? state.distance
        : wrapCourseCoordinate(state.distance, this.courseLength);
    state.loopsCompleted =
      this.courseLength === null ? 0 : Math.floor(state.distance / this.courseLength);

    const chickenWorldX = state.distance + CHICKEN_SCREEN_X;
    const nearbyPlatforms = repeatedInstances(
      this.platforms,
      chickenWorldX,
      this.courseLength,
    ) as readonly PlatformInstance[];

    if (chicken.grounded) {
      const support = nearbyPlatforms.find((platform) =>
        platformSupportsChicken(platform, chickenWorldX, chicken.y),
      );

      if (support) {
        chicken.supportingPlatformId = support.id;
        chicken.y = support.top - CHICKEN_BODY_HEIGHT / 2;
      } else {
        chicken.grounded = false;
        chicken.supportingPlatformId = null;
      }
    }

    const control = this.playerController.step(
      intent,
      {
        grounded: chicken.grounded,
        velocityY: chicken.velocityY,
      },
      FIXED_STEP_MS,
    );
    chicken.velocityY = control.velocityY;

    if (control.jumped) {
      chicken.grounded = false;
      chicken.supportingPlatformId = null;
    }

    if (!chicken.grounded) {
      const previousBottom = chicken.y + CHICKEN_BODY_HEIGHT / 2;
      const nextY = chicken.y + chicken.velocityY * STEP_SECONDS;
      const nextBottom = nextY + CHICKEN_BODY_HEIGHT / 2;

      const landing =
        chicken.velocityY >= 0
          ? nearbyPlatforms
              .filter((platform) =>
                canLandOnPlatform(platform, chickenWorldX, previousBottom, nextBottom),
              )
              .sort((left, right) => left.top - right.top)[0]
          : undefined;

      if (landing) {
        chicken.y = landing.top - CHICKEN_BODY_HEIGHT / 2;
        chicken.velocityY = 0;
        chicken.grounded = true;
        chicken.supportingPlatformId = landing.id;
        state.landingCount += 1;
      } else {
        chicken.y = nextY;
      }
    }

    const spike = (
      repeatedInstances(this.spikes, chickenWorldX, this.courseLength) as readonly SpikeInstance[]
    ).find((candidate) => intersectsSpike(candidate, previousWorldX, chickenWorldX, chicken.y));

    if (spike) {
      return this.endRun("hazard", spike.id);
    }

    const chickenBottom = chicken.y + CHICKEN_BODY_HEIGHT / 2;
    const water =
      this.water === null
        ? chickenBottom >= WATER_DEATH_Y
          ? { id: "water" }
          : undefined
        : (
            repeatedInstances(
              this.water,
              chickenWorldX,
              this.courseLength,
            ) as readonly WaterInstance[]
          ).find((zone) => isOverWater(zone, chickenWorldX, chickenBottom));

    if (water) {
      return this.endRun("water", water.id);
    }

    if (chickenBottom >= FALL_DEATH_Y) {
      return this.endRun("fall", "void");
    }

    chicken.animation = chicken.grounded ? "run" : control.lift > 0 ? "flap" : "jump";
    return this.snapshot();
  }

  snapshot() {
    return copySnapshot(this.snapshotValue);
  }

  diagnostics(): SimulationDiagnostics {
    const active = !this.destroyed;

    return {
      activeBodies: active ? 1 : 0,
      activeTimers: 0,
      collisionZones: active ? this.spikes.length + (this.water?.length ?? 1) + 1 : 0,
      pooledObjects: active
        ? this.platforms.length + this.spikes.length + (this.water?.length ?? 1)
        : 0,
      destroyed: this.destroyed,
    };
  }

  destroy() {
    this.destroyed = true;
  }

  private createInitialSnapshot(): SimulationSnapshot {
    const chickenWorldX = CHICKEN_SCREEN_X;
    const startingPlatform = (
      repeatedInstances(
        this.platforms,
        chickenWorldX,
        this.courseLength,
      ) as readonly PlatformInstance[]
    ).find((platform) => {
      const chickenLeft = chickenWorldX - CHICKEN_BODY_WIDTH / 2;
      const chickenRight = chickenWorldX + CHICKEN_BODY_WIDTH / 2;
      return chickenRight > platform.worldX && chickenLeft < platform.worldX + platform.width;
    });

    if (!startingPlatform) {
      throw new Error("The simulation needs a platform beneath its starting position");
    }

    return {
      phase: "ready",
      tick: 0,
      elapsedMs: 0,
      score: 0,
      distance: 0,
      courseDistance: 0,
      loopsCompleted: 0,
      chicken: {
        x: CHICKEN_SCREEN_X,
        y: startingPlatform.top - CHICKEN_BODY_HEIGHT / 2,
        velocityY: 0,
        grounded: true,
        supportingPlatformId: startingPlatform.id,
        animation: "idle",
      },
      deathReason: null,
      collisionId: null,
      landingCount: 0,
    };
  }

  private endRun(reason: SimulationDeathReason, collisionId: string) {
    const state = this.snapshotValue;

    if (state.phase === "dead") {
      return this.snapshot();
    }

    state.phase = "dead";
    state.deathReason = reason;
    state.collisionId = collisionId;
    state.chicken.grounded = false;
    state.chicken.supportingPlatformId = null;
    state.chicken.velocityY = 0;
    state.chicken.animation = "death";
    return this.snapshot();
  }

  private assertAlive() {
    if (this.destroyed) {
      throw new Error("The simulation has been destroyed");
    }
  }
}
