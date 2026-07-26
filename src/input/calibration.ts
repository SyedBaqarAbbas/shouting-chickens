import type { CalibrationProfile, KeyValueStorage } from "../core/contracts";
import { JsonStore } from "../core/storage";
import { CLIPPING_AMPLITUDE, MIN_DBFS, clamp, type EnergyScalarFrame } from "./energy";

const CALIBRATION_SCHEMA_VERSION = 1;
const CALIBRATION_STORAGE_KEY = "shouting-chickens.calibration.v1";
const MIN_STAGE_SAMPLES = 12;
const MIN_QUIET_TO_NORMAL_DB = 6;
const MIN_NORMAL_TO_LOUD_DB = 4;
const MAX_CLIPPED_SAMPLE_RATIO = 0.2;

export const SAFE_CALIBRATION_GUIDANCE =
  "Use a comfortable voice only—do not shout. Move the microphone or retry somewhere quieter.";

export type CalibrationTrace = {
  readonly quiet: readonly EnergyScalarFrame[];
  readonly normal: readonly EnergyScalarFrame[];
  readonly loud: readonly EnergyScalarFrame[];
};

export type CalibrationFailureCode =
  "not-enough-samples" | "clipped" | "quiet-normal-range" | "normal-loud-range";

export type CalibrationFailure = {
  readonly ok: false;
  readonly code: CalibrationFailureCode;
  readonly message: string;
  readonly guidance: string;
};

export type CalibrationResult =
  { readonly ok: true; readonly profile: CalibrationProfile } | CalibrationFailure;

export function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) {
    throw new RangeError("A percentile requires at least one value");
  }
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new RangeError("Percentile ratio must be between 0 and 1");
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError("Percentile values must be finite");
  }

  const ordered = [...values].sort((left, right) => left - right);
  const rank = (ordered.length - 1) * ratio;
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = ordered[lowerIndex];
  const upper = ordered[upperIndex];

  if (lower === undefined || upper === undefined) {
    throw new RangeError("Percentile rank was outside the sample set");
  }

  return lower + (upper - lower) * (rank - lowerIndex);
}

export function createCalibrationProfile(trace: CalibrationTrace): CalibrationResult {
  for (const stage of ["quiet", "normal", "loud"] as const) {
    const invalid = validateCalibrationStage(trace, stage);
    if (invalid) {
      return invalid;
    }
  }

  const noiseFloorDb = percentile(
    trace.quiet.map((sample) => sample.dbfs),
    0.75,
  );
  const normalDb = percentile(
    trace.normal.map((sample) => sample.dbfs),
    0.75,
  );
  const loudDb = percentile(
    trace.loud.map((sample) => sample.dbfs),
    0.75,
  );

  const normalLevel = normalizeDbfs(normalDb, {
    loudDb,
    noiseFloorDb,
  });
  // Keep the enter threshold below the player's comfortable calibration level.
  // A smoothed signal approaches its target asymptotically, so using the exact
  // comfortable level as the threshold could make it impossible to cross.
  const jumpEnterLevel = clamp(normalLevel * 0.85, 0.38, 0.62);

  return {
    ok: true,
    profile: {
      jumpEnterLevel,
      jumpExitLevel: clamp(jumpEnterLevel - 0.2, 0.2, 0.5),
      liftStartLevel: jumpEnterLevel,
      loudDb,
      noiseFloorDb,
      normalDb,
      schemaVersion: CALIBRATION_SCHEMA_VERSION,
    },
  };
}

export function validateCalibrationStage(
  trace: CalibrationTrace,
  stage: keyof CalibrationTrace,
): CalibrationFailure | null {
  const samples = trace[stage];
  if (samples.length < MIN_STAGE_SAMPLES) {
    return failure(
      "not-enough-samples",
      `The ${stageLabel(stage)} step needs a little more steady input.`,
    );
  }

  const clippedSamples = samples.filter(
    (sample) => sample.clipped || sample.peak >= CLIPPING_AMPLITUDE || sample.dbfs >= -0.25,
  ).length;
  const allowedTransientSamples = Math.max(
    1,
    Math.floor(samples.length * MAX_CLIPPED_SAMPLE_RATIO),
  );
  if (clippedSamples > allowedTransientSamples) {
    return failure(
      "clipped",
      `The microphone clipped repeatedly during the ${stageLabel(stage)} step.`,
    );
  }

  if (stage === "quiet") {
    return null;
  }

  const quietDb = percentile(
    trace.quiet.map((sample) => sample.dbfs),
    0.75,
  );
  const normalDb = percentile(
    trace.normal.map((sample) => sample.dbfs),
    0.75,
  );

  if (normalDb - quietDb < MIN_QUIET_TO_NORMAL_DB) {
    return failure(
      "quiet-normal-range",
      "The quiet and comfortable-voice levels are too close to distinguish reliably.",
    );
  }

  if (stage === "normal") {
    return null;
  }

  const loudDb = percentile(
    trace.loud.map((sample) => sample.dbfs),
    0.75,
  );
  if (loudDb - normalDb < MIN_NORMAL_TO_LOUD_DB) {
    return failure(
      "normal-loud-range",
      "The comfortable and strong-voice levels are too close to distinguish reliably.",
    );
  }

  return null;
}

export function normalizeDbfs(
  dbfs: number,
  profile: Pick<CalibrationProfile, "noiseFloorDb" | "loudDb">,
): number {
  if (!Number.isFinite(dbfs) || profile.loudDb <= profile.noiseFloorDb) {
    return 0;
  }

  return clamp((dbfs - profile.noiseFloorDb) / (profile.loudDb - profile.noiseFloorDb), 0, 1);
}

export function isCalibrationProfile(value: unknown): value is CalibrationProfile {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const profile = value as Partial<CalibrationProfile>;
  return (
    profile.schemaVersion === CALIBRATION_SCHEMA_VERSION &&
    isFiniteNumber(profile.noiseFloorDb) &&
    isFiniteNumber(profile.normalDb) &&
    isFiniteNumber(profile.loudDb) &&
    isUnitInterval(profile.jumpEnterLevel) &&
    isUnitInterval(profile.jumpExitLevel) &&
    isUnitInterval(profile.liftStartLevel) &&
    profile.liftStartLevel < 1 &&
    profile.noiseFloorDb >= MIN_DBFS &&
    profile.loudDb <= 0 &&
    profile.noiseFloorDb < profile.normalDb &&
    profile.normalDb < profile.loudDb &&
    profile.jumpExitLevel < profile.jumpEnterLevel
  );
}

export class CalibrationProfileStore {
  private readonly store: JsonStore<CalibrationProfile>;

  constructor(storage: KeyValueStorage) {
    this.store = new JsonStore(storage, CALIBRATION_STORAGE_KEY, isCalibrationProfile);
  }

  read(): CalibrationProfile | null {
    return this.store.read();
  }

  write(profile: CalibrationProfile): void {
    if (!isCalibrationProfile(profile)) {
      throw new RangeError("Cannot persist an invalid calibration profile");
    }

    this.store.write({
      jumpEnterLevel: profile.jumpEnterLevel,
      jumpExitLevel: profile.jumpExitLevel,
      liftStartLevel: profile.liftStartLevel,
      loudDb: profile.loudDb,
      noiseFloorDb: profile.noiseFloorDb,
      normalDb: profile.normalDb,
      schemaVersion: CALIBRATION_SCHEMA_VERSION,
    });
  }

  remove(): void {
    this.store.remove();
  }
}

function failure(code: CalibrationFailureCode, message: string): CalibrationFailure {
  return {
    code,
    guidance: SAFE_CALIBRATION_GUIDANCE,
    message,
    ok: false,
  };
}

function stageLabel(stage: keyof CalibrationTrace): string {
  switch (stage) {
    case "quiet":
      return "quiet-room";
    case "normal":
      return "comfortable-voice";
    case "loud":
      return "strong-voice";
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUnitInterval(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

export {
  CALIBRATION_SCHEMA_VERSION,
  CALIBRATION_STORAGE_KEY,
  MAX_CLIPPED_SAMPLE_RATIO,
  MIN_NORMAL_TO_LOUD_DB,
  MIN_QUIET_TO_NORMAL_DB,
  MIN_STAGE_SAMPLES,
};
