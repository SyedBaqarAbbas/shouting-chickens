import { describe, expect, it } from "vitest";

import {
  advanceLiftStamina,
  INITIAL_LIFT_STAMINA_STATE,
  LIFT_STAMINA_DRAIN_PER_SECOND,
} from "./LiftStamina";

describe("lift stamina", () => {
  it("drains and recovers predictably from fixed-step time", () => {
    let state = INITIAL_LIFT_STAMINA_STATE;

    state = advanceLiftStamina(state, 1, true, 1_000);
    expect(state.remaining).toBeCloseTo(1 - LIFT_STAMINA_DRAIN_PER_SECOND, 8);
    expect(state.effectiveLift).toBe(1);
    expect(state.activeLiftTicks).toBe(1);

    state = advanceLiftStamina(state, 0, true, 1_000);
    expect(state.remaining).toBe(1);
    expect(state.effectiveLift).toBe(0);
    expect(state.activeLiftTicks).toBe(0);
    expect(state.longestLiftTicks).toBe(1);
  });

  it("caps at empty/full and cannot apply lift after depletion", () => {
    let state = INITIAL_LIFT_STAMINA_STATE;

    for (let tick = 0; tick < 180; tick += 1) {
      state = advanceLiftStamina(state, 1, true, 1_000 / 60);
    }
    expect(state.remaining).toBe(0);
    expect(state.effectiveLift).toBe(0);
    expect(state.longestLiftTicks).toBe(150);

    for (let tick = 0; tick < 240; tick += 1) {
      state = advanceLiftStamina(state, 0, true, 1_000 / 60);
    }
    expect(state.remaining).toBe(1);
    expect(state.effectiveLift).toBe(0);
  });

  it("does not drain while grounded and validates time", () => {
    expect(advanceLiftStamina(INITIAL_LIFT_STAMINA_STATE, 1, false, 1_000)).toEqual(
      INITIAL_LIFT_STAMINA_STATE,
    );
    expect(() => advanceLiftStamina(INITIAL_LIFT_STAMINA_STATE, 1, true, 0)).toThrow(
      "positive finite",
    );
  });
});
