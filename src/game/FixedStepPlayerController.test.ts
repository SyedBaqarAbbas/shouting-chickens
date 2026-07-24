import { describe, expect, it } from "vitest";

import type { ControlIntent } from "../core";
import {
  DEFAULT_PLAYER_CONTROLLER_TUNING,
  FixedStepPlayerController,
  type PlayerControllerTuning,
} from "./FixedStepPlayerController";

const STEP_MS = 1000 / 60;
const GROUNDED = { grounded: true, velocityY: 0 } as const;
const AIRBORNE = { grounded: false, velocityY: 0 } as const;

function intent(jumpPressed: boolean, lift = 0): ControlIntent {
  return {
    atMs: 0,
    jumpPressed,
    lift,
  };
}

describe("FixedStepPlayerController", () => {
  it("consumes a short jump pulse on the next grounded fixed step", () => {
    const controller = new FixedStepPlayerController();

    const result = controller.step(intent(true), GROUNDED, STEP_MS);

    expect(result.jumped).toBe(true);
    expect(result.velocityY).toBeLessThan(0);
    expect(result.velocityY).toBeGreaterThanOrEqual(
      DEFAULT_PLAYER_CONTROLLER_TUNING.maximumRiseVelocity,
    );
  });

  it("does not turn a held onset into another jump on landing", () => {
    const controller = new FixedStepPlayerController();

    expect(controller.step(intent(true, 1), GROUNDED, STEP_MS).jumped).toBe(true);
    expect(controller.step(intent(true, 1), AIRBORNE, STEP_MS).jumped).toBe(false);
    expect(controller.step(intent(true, 0), GROUNDED, STEP_MS).jumped).toBe(false);

    controller.step(intent(false), GROUNDED, STEP_MS);
    expect(controller.step(intent(true), GROUNDED, STEP_MS).jumped).toBe(true);
  });

  it("queues an independent airborne edge and consumes it only when grounded", () => {
    const controller = new FixedStepPlayerController();

    expect(controller.step(intent(true), AIRBORNE, STEP_MS).jumped).toBe(false);
    for (let step = 0; step < 30; step += 1) {
      controller.step(intent(false), AIRBORNE, STEP_MS);
    }

    const landingStep = controller.step(intent(false), GROUNDED, STEP_MS);
    expect(landingStep.jumped).toBe(true);
  });

  it("coalesces airborne threshold chatter into one queued grounded jump", () => {
    const controller = new FixedStepPlayerController();

    for (let step = 0; step < 20; step += 1) {
      controller.step(intent(step % 2 === 0), AIRBORNE, STEP_MS);
    }

    expect(controller.step(intent(false), GROUNDED, STEP_MS).jumped).toBe(true);
    expect(controller.step(intent(false), GROUNDED, STEP_MS).jumped).toBe(false);
  });

  it("applies proportional lift and clamps rise, fall, and malformed input", () => {
    const tuning: PlayerControllerTuning = {
      gravityPerSecond: 1_000,
      jumpVelocity: -50,
      liftAccelerationPerSecond: 2_000,
      maximumRiseVelocity: -100,
      maximumFallVelocity: 200,
    };
    const silent = new FixedStepPlayerController(tuning);
    const halfLift = new FixedStepPlayerController(tuning);
    const loud = new FixedStepPlayerController(tuning);

    expect(silent.step(intent(false, 0), AIRBORNE, 100).velocityY).toBe(100);
    expect(halfLift.step(intent(false, 0.5), AIRBORNE, 100).velocityY).toBe(0);
    expect(loud.step(intent(false, 5), AIRBORNE, 100).velocityY).toBe(-100);
    expect(loud.step(intent(false, Number.NaN), AIRBORNE, 100).lift).toBe(0);

    let fallingVelocity = 0;
    for (let step = 0; step < 10; step += 1) {
      fallingVelocity = silent.step(
        intent(false),
        { grounded: false, velocityY: fallingVelocity },
        100,
      ).velocityY;
    }
    expect(fallingVelocity).toBe(tuning.maximumFallVelocity);
  });

  it("exposes immutable tuning without adding source-specific controls", () => {
    const controller = new FixedStepPlayerController();

    expect(Object.isFrozen(controller.tuning)).toBe(true);
    expect(Object.keys(controller.tuning).sort()).toEqual([
      "gravityPerSecond",
      "jumpVelocity",
      "liftAccelerationPerSecond",
      "maximumFallVelocity",
      "maximumRiseVelocity",
    ]);
  });
});
