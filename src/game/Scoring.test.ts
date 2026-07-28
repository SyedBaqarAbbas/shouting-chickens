import { describe, expect, it } from "vitest";

import { calculateScoreBreakdown, COLLECTIBLE_SCORE, PRECISION_LANDING_SCORE } from "./Scoring";

describe("score breakdown", () => {
  it("separates survival, collectible, and precision arithmetic", () => {
    expect(calculateScoreBreakdown(4_250, 3, 2)).toEqual({
      survival: 42,
      collectibles: 3 * COLLECTIBLE_SCORE,
      precision: 2 * PRECISION_LANDING_SCORE,
      total: 42 + 3 * COLLECTIBLE_SCORE + 2 * PRECISION_LANDING_SCORE,
    });
  });

  it("uses whole survival intervals and validates counters", () => {
    expect(calculateScoreBreakdown(99.99, 0, 0).total).toBe(0);
    expect(calculateScoreBreakdown(100, 0, 0).total).toBe(1);
    expect(() => calculateScoreBreakdown(-1, 0, 0)).toThrow("non-negative finite");
    expect(() => calculateScoreBreakdown(0, 0.5, 0)).toThrow("safe integer");
    expect(() => calculateScoreBreakdown(0, 0, -1)).toThrow("safe integer");
  });
});
