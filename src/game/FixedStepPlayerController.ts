import type { ControlIntent } from "../core";

export type PlayerControllerTuning = Readonly<{
  gravityPerSecond: number;
  jumpVelocity: number;
  liftAccelerationPerSecond: number;
  maximumRiseVelocity: number;
  maximumFallVelocity: number;
}>;

export const DEFAULT_PLAYER_CONTROLLER_TUNING: PlayerControllerTuning = Object.freeze({
  gravityPerSecond: 1_180,
  jumpVelocity: -470,
  liftAccelerationPerSecond: 900,
  maximumRiseVelocity: -560,
  maximumFallVelocity: 720,
});

export type PlayerKinematics = Readonly<{
  grounded: boolean;
  velocityY: number;
}>;

export type PlayerControlStep = Readonly<{
  jumped: boolean;
  lift: number;
  velocityY: number;
}>;

function validateTuning(tuning: PlayerControllerTuning) {
  if (!Number.isFinite(tuning.gravityPerSecond) || tuning.gravityPerSecond <= 0) {
    throw new RangeError("Player gravity must be a positive finite number");
  }

  if (!Number.isFinite(tuning.jumpVelocity) || tuning.jumpVelocity >= 0) {
    throw new RangeError("Player jump velocity must be a negative finite number");
  }

  if (!Number.isFinite(tuning.liftAccelerationPerSecond) || tuning.liftAccelerationPerSecond < 0) {
    throw new RangeError("Player lift acceleration must be a non-negative finite number");
  }

  if (!Number.isFinite(tuning.maximumRiseVelocity) || tuning.maximumRiseVelocity >= 0) {
    throw new RangeError("Maximum rise velocity must be a negative finite number");
  }

  if (!Number.isFinite(tuning.maximumFallVelocity) || tuning.maximumFallVelocity <= 0) {
    throw new RangeError("Maximum fall velocity must be a positive finite number");
  }

  if (tuning.jumpVelocity < tuning.maximumRiseVelocity) {
    throw new RangeError("Jump velocity cannot exceed the maximum rise velocity");
  }
}

function clampLift(lift: number) {
  if (!Number.isFinite(lift)) {
    return 0;
  }

  return Math.min(1, Math.max(0, lift));
}

/**
 * Owns the input-edge and vertical-velocity rules that run exactly once per
 * fixed simulation step. Input adapters only produce ControlIntent; they never
 * get a second path into player physics.
 */
export class FixedStepPlayerController {
  readonly tuning: PlayerControllerTuning;

  private previousJumpPressed = false;
  private jumpQueued = false;

  constructor(tuning: PlayerControllerTuning = DEFAULT_PLAYER_CONTROLLER_TUNING) {
    validateTuning(tuning);
    this.tuning = Object.freeze({ ...tuning });
  }

  step(intent: ControlIntent, kinematics: PlayerKinematics, stepMs: number): PlayerControlStep {
    if (!Number.isFinite(stepMs) || stepMs <= 0) {
      throw new RangeError("Player control step must be a positive finite duration");
    }

    const jumpEdge = intent.jumpPressed && !this.previousJumpPressed;
    this.previousJumpPressed = intent.jumpPressed;

    if (jumpEdge) {
      this.jumpQueued = true;
    }

    let jumped = false;
    let velocityY = kinematics.velocityY;

    if (kinematics.grounded && this.jumpQueued) {
      jumped = true;
      velocityY = this.tuning.jumpVelocity;
      this.clearJumpQueue();
    }

    const lift = clampLift(intent.lift);
    if (!kinematics.grounded || jumped) {
      const stepSeconds = stepMs / 1000;
      const acceleration =
        this.tuning.gravityPerSecond - lift * this.tuning.liftAccelerationPerSecond;
      velocityY += acceleration * stepSeconds;
      velocityY = Math.max(
        this.tuning.maximumRiseVelocity,
        Math.min(this.tuning.maximumFallVelocity, velocityY),
      );
    }

    return {
      jumped,
      lift,
      velocityY,
    };
  }

  reset() {
    this.previousJumpPressed = false;
    this.clearJumpQueue();
  }

  private clearJumpQueue() {
    this.jumpQueued = false;
  }
}
