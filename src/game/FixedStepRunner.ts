import type { ControlIntent } from "../core";
import { ChickenSimulation, FIXED_STEP_MS } from "./simulation";

const MAX_FRAME_DELTA_MS = 250;
const FLOATING_POINT_EPSILON = 0.000_001;

export class FixedStepRunner {
  private accumulatorMs = 0;

  constructor(private readonly simulation: ChickenSimulation) {}

  advance(frameDeltaMs: number, readIntent: () => ControlIntent) {
    if (!Number.isFinite(frameDeltaMs) || frameDeltaMs < 0) {
      throw new RangeError("Frame delta must be a non-negative finite number");
    }

    if (this.simulation.snapshot().phase !== "running") {
      this.accumulatorMs = 0;
      return 0;
    }

    this.accumulatorMs += Math.min(frameDeltaMs, MAX_FRAME_DELTA_MS);
    let stepCount = 0;

    while (this.accumulatorMs + FLOATING_POINT_EPSILON >= FIXED_STEP_MS) {
      this.simulation.step(readIntent());
      this.accumulatorMs -= FIXED_STEP_MS;
      stepCount += 1;

      if (this.simulation.snapshot().phase !== "running") {
        this.accumulatorMs = 0;
        break;
      }
    }

    if (Math.abs(this.accumulatorMs) < FLOATING_POINT_EPSILON) {
      this.accumulatorMs = 0;
    }

    return stepCount;
  }

  reset() {
    this.accumulatorMs = 0;
  }

  pendingMs() {
    return this.accumulatorMs;
  }
}
