import type { ScoreBreakdown } from "../core";

export const SURVIVAL_SCORE_INTERVAL_MS = 100;
export const COLLECTIBLE_SCORE = 25;
export const PRECISION_LANDING_SCORE = 10;
export const PRECISION_LANDING_MAX_WIDTH = 200;

function assertNonNegativeSafeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

export function calculateScoreBreakdown(
  elapsedMs: number,
  collectibles: number,
  precisionLandings: number,
): ScoreBreakdown {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError("Score elapsed time must be a non-negative finite number");
  }
  assertNonNegativeSafeInteger(collectibles, "Collected collectible count");
  assertNonNegativeSafeInteger(precisionLandings, "Precision landing count");

  const survival = Math.floor(elapsedMs / SURVIVAL_SCORE_INTERVAL_MS);
  const collectibleScore = collectibles * COLLECTIBLE_SCORE;
  const precision = precisionLandings * PRECISION_LANDING_SCORE;

  return Object.freeze({
    survival,
    collectibles: collectibleScore,
    precision,
    total: survival + collectibleScore + precision,
  });
}
