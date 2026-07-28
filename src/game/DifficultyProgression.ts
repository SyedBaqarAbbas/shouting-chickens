import {
  measureBoundaryTransition,
  measureChunkTransition,
  type ChunkTemplate,
  type TraversalMeasurement,
} from "../content";
import { COURSE_WORLD_SPEED } from "./course";

export type DifficultyStage = 1 | 2 | 3 | 4 | 5;

export type DifficultyProfile = Readonly<{
  stage: DifficultyStage;
  startsAtChunk: number;
  difficulty: number;
  worldSpeed: number;
  maximumGap: number;
  maximumRise: number;
  maximumDrop: number;
  minimumLandingWidth: number;
  introductionWeight: number;
  advancedWeight: number;
}>;

/**
 * Difficulty changes only when a new authored chunk begins. The speed increase
 * is deliberately modest: authored geometry remains unchanged, and the final
 * stage is capped at 160 px/s.
 */
export const DIFFICULTY_PROFILES: readonly DifficultyProfile[] = Object.freeze([
  Object.freeze({
    stage: 1,
    startsAtChunk: 0,
    difficulty: 1,
    worldSpeed: COURSE_WORLD_SPEED,
    maximumGap: 100,
    maximumRise: 56,
    maximumDrop: 90,
    minimumLandingWidth: 160,
    introductionWeight: 4,
    advancedWeight: 0,
  }),
  Object.freeze({
    stage: 2,
    startsAtChunk: 6,
    difficulty: 2,
    worldSpeed: 148,
    maximumGap: 110,
    maximumRise: 56,
    maximumDrop: 90,
    minimumLandingWidth: 120,
    introductionWeight: 3,
    advancedWeight: 1,
  }),
  Object.freeze({
    stage: 3,
    startsAtChunk: 14,
    difficulty: 3,
    worldSpeed: 152,
    maximumGap: 110,
    maximumRise: 56,
    maximumDrop: 90,
    minimumLandingWidth: 120,
    introductionWeight: 2,
    advancedWeight: 2,
  }),
  Object.freeze({
    stage: 4,
    startsAtChunk: 24,
    difficulty: 4,
    worldSpeed: 156,
    maximumGap: 110,
    maximumRise: 56,
    maximumDrop: 90,
    minimumLandingWidth: 120,
    introductionWeight: 1,
    advancedWeight: 3,
  }),
  Object.freeze({
    stage: 5,
    startsAtChunk: 36,
    difficulty: 5,
    worldSpeed: 160,
    maximumGap: 110,
    maximumRise: 56,
    maximumDrop: 90,
    minimumLandingWidth: 120,
    introductionWeight: 1,
    advancedWeight: 4,
  }),
]);

export const MAX_DIFFICULTY_WORLD_SPEED = DIFFICULTY_PROFILES.at(-1)!.worldSpeed;

function assertChunkIndex(chunkIndex: number) {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new RangeError("Difficulty chunk index must be a non-negative safe integer");
  }
}

function fitsTraversalEnvelope(measurement: TraversalMeasurement, profile: DifficultyProfile) {
  return (
    measurement.horizontalGap <= profile.maximumGap &&
    measurement.verticalRise <= profile.maximumRise &&
    measurement.verticalDrop <= profile.maximumDrop
  );
}

function landingWidth(template: ChunkTemplate, platformId: string) {
  return template.platforms.find((platform) => platform.id === platformId)?.width ?? 0;
}

export function difficultyProfileForChunk(chunkIndex: number): DifficultyProfile {
  assertChunkIndex(chunkIndex);

  for (let index = DIFFICULTY_PROFILES.length - 1; index >= 0; index -= 1) {
    const profile = DIFFICULTY_PROFILES[index]!;
    if (chunkIndex >= profile.startsAtChunk) {
      return profile;
    }
  }

  return DIFFICULTY_PROFILES[0]!;
}

export function difficultyProfileForLevel(difficulty: number): DifficultyProfile {
  if (!Number.isSafeInteger(difficulty) || difficulty < 1) {
    throw new RangeError("Difficulty level must be a positive safe integer");
  }

  return DIFFICULTY_PROFILES[Math.min(difficulty, DIFFICULTY_PROFILES.length) - 1]!;
}

export function templateFitsDifficulty(template: ChunkTemplate, profile: DifficultyProfile) {
  return template.route.every((transition) => {
    const measurement = measureChunkTransition(template, transition);
    return (
      measurement !== null &&
      fitsTraversalEnvelope(measurement, profile) &&
      landingWidth(template, transition.toPlatformId) >= profile.minimumLandingWidth
    );
  });
}

export function boundaryFitsDifficulty(
  previous: ChunkTemplate,
  next: ChunkTemplate,
  profile: DifficultyProfile,
) {
  const measurement = measureBoundaryTransition(previous, next);
  return (
    measurement !== null &&
    fitsTraversalEnvelope(measurement, profile) &&
    landingWidth(next, next.entry.platformId) >= profile.minimumLandingWidth
  );
}

export function templateWeightForDifficulty(template: ChunkTemplate, profile: DifficultyProfile) {
  return template.challengeStage === "advanced"
    ? profile.advancedWeight
    : profile.introductionWeight;
}
