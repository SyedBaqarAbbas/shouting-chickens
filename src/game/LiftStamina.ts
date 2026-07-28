export const LIFT_STAMINA_DRAIN_PER_SECOND = 0.4;
export const LIFT_STAMINA_RECOVERY_PER_SECOND = 0.8;

export type LiftStaminaState = Readonly<{
  remaining: number;
  effectiveLift: number;
  activeLiftTicks: number;
  longestLiftTicks: number;
}>;

export const INITIAL_LIFT_STAMINA_STATE: LiftStaminaState = Object.freeze({
  remaining: 1,
  effectiveLift: 0,
  activeLiftTicks: 0,
  longestLiftTicks: 0,
});

function clampLevel(level: number) {
  return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}

export function advanceLiftStamina(
  state: LiftStaminaState,
  requestedLift: number,
  airborne: boolean,
  stepMs: number,
): LiftStaminaState {
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    throw new RangeError("Lift stamina step must be a positive finite duration");
  }

  const request = clampLevel(requestedLift);
  const shouldDrain = airborne && request > 0;
  const active = shouldDrain && state.remaining > 0;
  const effectiveLift = active ? request : 0;
  const seconds = stepMs / 1_000;
  const remaining = shouldDrain
    ? Math.max(0, state.remaining - request * LIFT_STAMINA_DRAIN_PER_SECOND * seconds)
    : Math.min(1, state.remaining + LIFT_STAMINA_RECOVERY_PER_SECOND * seconds);
  const activeLiftTicks = active ? state.activeLiftTicks + 1 : 0;

  return Object.freeze({
    remaining,
    effectiveLift,
    activeLiftTicks,
    longestLiftTicks: Math.max(state.longestLiftTicks, activeLiftTicks),
  });
}
