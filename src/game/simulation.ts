import type { ControlIntent } from "../core";

export const LOGICAL_GAME_WIDTH = 432;
export const LOGICAL_GAME_HEIGHT = 768;
export const FIXED_STEP_HZ = 60;
export const FIXED_STEP_MS = 1000 / FIXED_STEP_HZ;

export const CHICKEN_SCREEN_X = 112;
export const CHICKEN_BODY_WIDTH = 42;
export const CHICKEN_BODY_HEIGHT = 54;
export const WATER_DEATH_Y = 704;
export const FIXED_WORLD_SPEED = 144;

const STEP_SECONDS = 1 / FIXED_STEP_HZ;
const GRAVITY_PER_SECOND = 1_180;
const BASE_JUMP_VELOCITY = -470;
const LANDING_EPSILON = 0.001;

export type ChickenAnimationState = "idle" | "run" | "jump" | "flap" | "death";
export type SimulationPhase = "ready" | "running" | "paused" | "dead";

export type PlatformDefinition = {
  id: string;
  x: number;
  width: number;
  top: number;
};

export type SimulationSnapshot = {
  phase: SimulationPhase;
  tick: number;
  elapsedMs: number;
  distance: number;
  chicken: {
    x: number;
    y: number;
    velocityY: number;
    grounded: boolean;
    supportingPlatformId: string | null;
    animation: ChickenAnimationState;
  };
  deathReason: "water" | null;
  landingCount: number;
};

export type SimulationDiagnostics = {
  activeBodies: number;
  activeTimers: number;
  destroyed: boolean;
};

export const FOUNDATION_PLATFORMS: readonly PlatformDefinition[] = Object.freeze([
  Object.freeze({ id: "start", x: -60, width: 390, top: 584 }),
  Object.freeze({ id: "landing", x: 392, width: 276, top: 548 }),
  Object.freeze({ id: "finish", x: 738, width: 310, top: 602 }),
]);

type SimulationOptions = {
  platforms?: readonly PlatformDefinition[];
  worldSpeed?: number;
};

function copySnapshot(snapshot: SimulationSnapshot): SimulationSnapshot {
  return {
    ...snapshot,
    chicken: { ...snapshot.chicken },
  };
}

function validatePlatforms(platforms: readonly PlatformDefinition[]) {
  for (const platform of platforms) {
    if (
      !platform.id ||
      !Number.isFinite(platform.x) ||
      !Number.isFinite(platform.width) ||
      platform.width <= 0 ||
      !Number.isFinite(platform.top)
    ) {
      throw new RangeError("Every platform needs a finite position and positive width");
    }
  }
}

function platformSupportsChicken(platform: PlatformDefinition, distance: number, chickenY: number) {
  const chickenWorldX = distance + CHICKEN_SCREEN_X;
  const chickenLeft = chickenWorldX - CHICKEN_BODY_WIDTH / 2;
  const chickenRight = chickenWorldX + CHICKEN_BODY_WIDTH / 2;
  const chickenBottom = chickenY + CHICKEN_BODY_HEIGHT / 2;

  return (
    chickenRight > platform.x &&
    chickenLeft < platform.x + platform.width &&
    Math.abs(chickenBottom - platform.top) <= LANDING_EPSILON
  );
}

function canLandOnPlatform(
  platform: PlatformDefinition,
  distance: number,
  previousBottom: number,
  nextBottom: number,
) {
  const chickenWorldX = distance + CHICKEN_SCREEN_X;
  const chickenLeft = chickenWorldX - CHICKEN_BODY_WIDTH / 2;
  const chickenRight = chickenWorldX + CHICKEN_BODY_WIDTH / 2;

  return (
    chickenRight > platform.x &&
    chickenLeft < platform.x + platform.width &&
    previousBottom <= platform.top + LANDING_EPSILON &&
    nextBottom >= platform.top
  );
}

export class ChickenSimulation {
  readonly platforms: readonly PlatformDefinition[];
  readonly worldSpeed: number;

  private destroyed = false;
  private snapshotValue: SimulationSnapshot;

  constructor(options: SimulationOptions = {}) {
    const platforms = options.platforms ?? FOUNDATION_PLATFORMS;
    const worldSpeed = options.worldSpeed ?? FIXED_WORLD_SPEED;

    validatePlatforms(platforms);

    if (!Number.isFinite(worldSpeed) || worldSpeed <= 0) {
      throw new RangeError("World speed must be a positive finite number");
    }

    this.platforms = platforms.map((platform) => ({ ...platform }));
    this.worldSpeed = worldSpeed;
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

    state.tick += 1;
    state.elapsedMs = state.tick * FIXED_STEP_MS;
    state.distance += this.worldSpeed * STEP_SECONDS;

    if (chicken.grounded) {
      const support = this.platforms.find((platform) =>
        platformSupportsChicken(platform, state.distance, chicken.y),
      );

      if (support) {
        chicken.supportingPlatformId = support.id;
        chicken.y = support.top - CHICKEN_BODY_HEIGHT / 2;
      } else {
        chicken.grounded = false;
        chicken.supportingPlatformId = null;
      }
    }

    if (intent.jumpPressed && chicken.grounded) {
      chicken.grounded = false;
      chicken.supportingPlatformId = null;
      chicken.velocityY = BASE_JUMP_VELOCITY;
    }

    if (!chicken.grounded) {
      const previousBottom = chicken.y + CHICKEN_BODY_HEIGHT / 2;

      chicken.velocityY += GRAVITY_PER_SECOND * STEP_SECONDS;
      const nextY = chicken.y + chicken.velocityY * STEP_SECONDS;
      const nextBottom = nextY + CHICKEN_BODY_HEIGHT / 2;

      const landing =
        chicken.velocityY >= 0
          ? this.platforms
              .filter((platform) =>
                canLandOnPlatform(platform, state.distance, previousBottom, nextBottom),
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

    if (chicken.y + CHICKEN_BODY_HEIGHT / 2 >= WATER_DEATH_Y) {
      state.phase = "dead";
      state.deathReason = "water";
      chicken.grounded = false;
      chicken.supportingPlatformId = null;
      chicken.animation = "death";
      return this.snapshot();
    }

    chicken.animation = chicken.grounded ? "run" : intent.lift > 0 ? "flap" : "jump";
    return this.snapshot();
  }

  snapshot() {
    return copySnapshot(this.snapshotValue);
  }

  diagnostics(): SimulationDiagnostics {
    return {
      activeBodies: this.destroyed ? 0 : 1,
      activeTimers: 0,
      destroyed: this.destroyed,
    };
  }

  destroy() {
    this.destroyed = true;
  }

  private createInitialSnapshot(): SimulationSnapshot {
    const startingPlatform =
      this.platforms.find((platform) => {
        const chickenLeft = CHICKEN_SCREEN_X - CHICKEN_BODY_WIDTH / 2;
        const chickenRight = CHICKEN_SCREEN_X + CHICKEN_BODY_WIDTH / 2;
        return chickenRight > platform.x && chickenLeft < platform.x + platform.width;
      }) ?? this.platforms[0];

    if (!startingPlatform) {
      throw new Error("The simulation needs at least one starting platform");
    }

    return {
      phase: "ready",
      tick: 0,
      elapsedMs: 0,
      distance: 0,
      chicken: {
        x: CHICKEN_SCREEN_X,
        y: startingPlatform.top - CHICKEN_BODY_HEIGHT / 2,
        velocityY: 0,
        grounded: true,
        supportingPlatformId: startingPlatform.id,
        animation: "idle",
      },
      deathReason: null,
      landingCount: 0,
    };
  }

  private assertAlive() {
    if (this.destroyed) {
      throw new Error("The simulation has been destroyed");
    }
  }
}
