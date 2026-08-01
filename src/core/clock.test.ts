import { describe, expect, it, vi } from "vitest";

import { SystemClock } from "./clock";

describe("SystemClock", () => {
  it("stays in the monotonic performance domain when the wall clock changes", () => {
    let monotonicMs = 100;
    let wallMs = 10_000;
    const performanceNow = vi
      .spyOn(globalThis.performance, "now")
      .mockImplementation(() => monotonicMs);
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => wallMs);

    try {
      const clock = new SystemClock();
      expect(clock.now()).toBe(globalThis.performance.timeOrigin + 100);

      monotonicMs += 25;
      wallMs += 1_525;

      expect(clock.now()).toBe(globalThis.performance.timeOrigin + 125);
      expect(dateNow).not.toHaveBeenCalled();
    } finally {
      performanceNow.mockRestore();
      dateNow.mockRestore();
    }
  });

  it("falls back to wall time when a monotonic reading is unavailable", () => {
    const performanceNow = vi.spyOn(globalThis.performance, "now").mockReturnValue(Number.NaN);
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(42_000);

    try {
      expect(new SystemClock().now()).toBe(42_000);
      expect(dateNow).toHaveBeenCalledOnce();
    } finally {
      performanceNow.mockRestore();
      dateNow.mockRestore();
    }
  });
});
