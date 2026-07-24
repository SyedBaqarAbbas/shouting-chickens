import type { ControlIntent } from "../../core";
import type { ScriptedControlFrame } from "../../core/input/ScriptedInputSource";
import { FIXED_STEP_MS } from "../simulation";

type LiftWindow = Readonly<{
  fromTick: number;
  toTick: number;
  lift: number;
}>;

export type AuthoredCourseTrace = Readonly<{
  jumpTicks: ReadonlySet<number>;
  liftWindows: readonly LiftWindow[];
}>;

function trace(
  jumpTicks: readonly number[],
  liftWindows: readonly LiftWindow[] = [],
): AuthoredCourseTrace {
  return Object.freeze({
    jumpTicks: new Set(jumpTicks),
    liftWindows: Object.freeze(liftWindows.map((window) => Object.freeze({ ...window }))),
  });
}

export const AUTHORED_COURSE_TRACES = Object.freeze({
  complete: trace(
    [82, 287, 445, 660, 800],
    [
      { fromTick: 445, toTick: 485, lift: 0.8 },
      { fromTick: 800, toTick: 840, lift: 0.8 },
    ],
  ),
  water: trace([]),
  fall: trace([82]),
  spike: trace([82, 287, 445, 660], [{ fromTick: 445, toTick: 485, lift: 0.8 }]),
});

export function authoredCourseIntent(
  traceDefinition: AuthoredCourseTrace,
  tick: number,
): ControlIntent {
  const liftWindow = traceDefinition.liftWindows.find(
    (window) => tick >= window.fromTick && tick < window.toTick,
  );

  return {
    atMs: tick * FIXED_STEP_MS,
    jumpPressed: traceDefinition.jumpTicks.has(tick),
    lift: liftWindow?.lift ?? 0,
  };
}

export function toScriptedControlFrames(
  traceDefinition: AuthoredCourseTrace,
  throughTick = 1_100,
): readonly ScriptedControlFrame[] {
  const frames: ScriptedControlFrame[] = [];
  let previous: ControlIntent = {
    atMs: 0,
    jumpPressed: false,
    lift: 0,
  };

  for (let tick = 0; tick < throughTick; tick += 1) {
    const intent = authoredCourseIntent(traceDefinition, tick);

    if (intent.jumpPressed !== previous.jumpPressed || intent.lift !== previous.lift) {
      frames.push({
        atMs: (tick + 1) * FIXED_STEP_MS,
        jumpPressed: intent.jumpPressed,
        lift: intent.lift,
      });
    }

    previous = intent;
  }

  return frames;
}
