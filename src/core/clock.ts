import type { Clock } from "./contracts";

export class SystemClock implements Clock {
  now() {
    const timer = globalThis.performance;
    const monotonicNow = timer?.now();
    const timeOrigin = timer?.timeOrigin;
    return typeof timeOrigin === "number" &&
      Number.isFinite(timeOrigin) &&
      typeof monotonicNow === "number" &&
      Number.isFinite(monotonicNow)
      ? timeOrigin + monotonicNow
      : Date.now();
  }
}

export class ManualClock implements Clock {
  constructor(private currentMs = 0) {
    this.assertValidTime(currentMs);
  }

  now() {
    return this.currentMs;
  }

  set(timeMs: number) {
    this.assertValidTime(timeMs);

    if (timeMs < this.currentMs) {
      throw new RangeError("ManualClock cannot move backwards");
    }

    this.currentMs = timeMs;
  }

  advance(deltaMs: number) {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError("ManualClock delta must be a non-negative finite number");
    }

    this.currentMs += deltaMs;
    return this.currentMs;
  }

  private assertValidTime(timeMs: number) {
    if (!Number.isFinite(timeMs) || timeMs < 0) {
      throw new RangeError("ManualClock time must be a non-negative finite number");
    }
  }
}
