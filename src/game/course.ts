import { DEFAULT_PLAYER_CONTROLLER_TUNING } from "./FixedStepPlayerController";

export type PlatformDefinition = Readonly<{
  id: string;
  x: number;
  width: number;
  top: number;
}>;

export type SpikeHazardDefinition = Readonly<{
  id: string;
  x: number;
  width: number;
  baseTop: number;
  height: number;
}>;

export type WaterZoneDefinition = Readonly<{
  id: string;
  x: number;
  width: number;
  top: number;
}>;

export type CourseSegmentDefinition = Readonly<{
  id: string;
  challenge: "safe-start" | "small-gap" | "fall-gap" | "lift-gap" | "spike" | "loop";
  approachWidth: number;
  landingWidth: number;
  horizontalGap: number;
  verticalRise: number;
}>;

export const COURSE_LENGTH = 2_500;
export const COURSE_WORLD_SPEED = 144;

/**
 * The authored envelope is intentionally more conservative than the controller
 * limits. Every gap has at least 190 px of approach, at least 360 px of
 * landing, no more than 110 px of horizontal separation, and no more than
 * 56 px of upward step. At 144 px/s the default -470 px/s jump clears the
 * small/fall gaps; holding lift up to 0.8 stays inside the -560 px/s rise cap
 * and clears the lift gap with room to release before landing.
 */
export const COURSE_TRAVERSAL_ENVELOPE = Object.freeze({
  worldSpeed: COURSE_WORLD_SPEED,
  jumpVelocity: DEFAULT_PLAYER_CONTROLLER_TUNING.jumpVelocity,
  maximumRiseVelocity: DEFAULT_PLAYER_CONTROLLER_TUNING.maximumRiseVelocity,
  maximumFallVelocity: DEFAULT_PLAYER_CONTROLLER_TUNING.maximumFallVelocity,
  maximumAuthoredGap: 110,
  maximumAuthoredRise: 56,
  minimumApproachWidth: 190,
  minimumLandingWidth: 360,
  recommendedLift: 0.8,
});

export const LOOPING_COURSE_PLATFORMS: readonly PlatformDefinition[] = Object.freeze([
  Object.freeze({ id: "safe-start", x: -160, width: 520, top: 584 }),
  Object.freeze({ id: "small-gap-landing", x: 430, width: 390, top: 584 }),
  Object.freeze({ id: "fall-gap-landing", x: 900, width: 360, top: 550 }),
  Object.freeze({ id: "lift-gap-landing", x: 1_370, width: 370, top: 494 }),
  Object.freeze({ id: "spike-approach", x: 1_830, width: 500, top: 584 }),
]);

export const LOOPING_COURSE_SPIKES: readonly SpikeHazardDefinition[] = Object.freeze([
  Object.freeze({
    id: "first-spike",
    x: 2_075,
    width: 46,
    baseTop: 584,
    height: 38,
  }),
]);

export const LOOPING_COURSE_WATER: readonly WaterZoneDefinition[] = Object.freeze([
  Object.freeze({ id: "small-gap-water", x: 350, width: 205, top: 704 }),
  Object.freeze({ id: "lift-gap-water", x: 1_250, width: 270, top: 704 }),
  Object.freeze({ id: "drop-gap-water", x: 1_730, width: 245, top: 704 }),
]);

export const LOOPING_COURSE_SEGMENTS: readonly CourseSegmentDefinition[] = Object.freeze([
  Object.freeze({
    id: "safe-start",
    challenge: "safe-start",
    approachWidth: 248,
    landingWidth: 520,
    horizontalGap: 0,
    verticalRise: 0,
  }),
  Object.freeze({
    id: "small-gap",
    challenge: "small-gap",
    approachWidth: 248,
    landingWidth: 390,
    horizontalGap: 70,
    verticalRise: 0,
  }),
  Object.freeze({
    id: "fall-gap",
    challenge: "fall-gap",
    approachWidth: 390,
    landingWidth: 360,
    horizontalGap: 80,
    verticalRise: 34,
  }),
  Object.freeze({
    id: "lift-gap",
    challenge: "lift-gap",
    approachWidth: 360,
    landingWidth: 370,
    horizontalGap: 110,
    verticalRise: 56,
  }),
  Object.freeze({
    id: "spike",
    challenge: "spike",
    approachWidth: 245,
    landingWidth: 209,
    horizontalGap: 0,
    verticalRise: 0,
  }),
  Object.freeze({
    id: "loop",
    challenge: "loop",
    approachWidth: 209,
    landingWidth: 520,
    horizontalGap: 10,
    verticalRise: 0,
  }),
]);

export function wrapCourseCoordinate(value: number, length = COURSE_LENGTH) {
  if (!Number.isFinite(value) || !Number.isFinite(length) || length <= 0) {
    throw new RangeError("Course coordinates need a finite value and positive length");
  }

  return ((value % length) + length) % length;
}

export function projectLoopingWorldX(worldX: number, distance: number, length = COURSE_LENGTH) {
  const relative = wrapCourseCoordinate(worldX - distance + length / 2, length);
  return relative - length / 2;
}
