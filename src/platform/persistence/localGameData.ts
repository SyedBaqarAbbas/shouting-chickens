import type {
  CalibrationProfile,
  ControlMode,
  KeyValueStorage,
  RunSummary,
} from "../../core/contracts";
import { MemoryStorage } from "../../core/storage";
import { calculateScoreBreakdown } from "../../game/Scoring";
import { isCalibrationProfile } from "../../input/calibration";

export const GAME_STORAGE_PREFIX = "shouting-chickens.";
export const LOCAL_DATA_STORAGE_KEY = `${GAME_STORAGE_PREFIX}player-data.v2`;
export const LEGACY_LOCAL_DATA_STORAGE_KEY = `${GAME_STORAGE_PREFIX}player-data.v1`;
export const LEGACY_CALIBRATION_STORAGE_KEY = `${GAME_STORAGE_PREFIX}calibration.v1`;
export const LOCAL_DATA_SCHEMA_VERSION = 2 as const;
export const CURRENT_COPY_VERSION = 1;
export const MIN_MANUAL_THRESHOLD = 0.38;
export const MAX_MANUAL_THRESHOLD = 0.72;

export type GameSettings = {
  readonly cameraEnabled: boolean;
  readonly controlPreference: ControlMode;
  readonly copyVersion: number;
  readonly muted: boolean;
  readonly reducedMotion: boolean;
  readonly replayConsent: boolean;
  readonly screenShakeEnabled: boolean;
};

export type RunStatistics = {
  readonly bestDistance: number;
  readonly bestScore: number;
  readonly completedRuns: number;
  readonly longestSurvivalMs: number;
};

export type LocalGameData = {
  readonly calibration: CalibrationProfile | null;
  readonly schemaVersion: typeof LOCAL_DATA_SCHEMA_VERSION;
  readonly settings: GameSettings;
  readonly statistics: RunStatistics;
};

export type LocalDataReadResult = {
  readonly data: LocalGameData;
  readonly recovered: boolean;
};

export const DEFAULT_GAME_SETTINGS: Readonly<GameSettings> = Object.freeze({
  cameraEnabled: false,
  controlPreference: "keyboard-touch",
  copyVersion: 0,
  muted: false,
  reducedMotion: false,
  replayConsent: false,
  screenShakeEnabled: true,
});

export const DEFAULT_RUN_STATISTICS: Readonly<RunStatistics> = Object.freeze({
  bestDistance: 0,
  bestScore: 0,
  completedRuns: 0,
  longestSurvivalMs: 0,
});

export function defaultLocalGameData(): LocalGameData {
  return {
    calibration: null,
    schemaVersion: LOCAL_DATA_SCHEMA_VERSION,
    settings: { ...DEFAULT_GAME_SETTINGS },
    statistics: { ...DEFAULT_RUN_STATISTICS },
  };
}

export class BrowserKeyValueStorage implements KeyValueStorage {
  constructor(private readonly storage: Storage) {}

  get(key: string): string | null {
    return this.storage.getItem(key);
  }

  set(key: string, value: string): void {
    this.storage.setItem(key, value);
  }

  remove(key: string): void {
    this.storage.removeItem(key);
  }

  keys(): readonly string[] {
    return Array.from({ length: this.storage.length }, (_, index) =>
      this.storage.key(index),
    ).filter((key): key is string => key !== null);
  }

  clear(): void {
    this.storage.clear();
  }
}

export function createBrowserLocalGameDataStore(): LocalGameDataStore {
  try {
    return new LocalGameDataStore(new BrowserKeyValueStorage(window.localStorage));
  } catch {
    return new LocalGameDataStore(new MemoryStorage());
  }
}

export class LocalGameDataStore {
  constructor(private readonly storage: KeyValueStorage) {}

  read(): LocalDataReadResult {
    const currentRaw = this.safeGet(LOCAL_DATA_STORAGE_KEY);
    if (currentRaw !== null) {
      const current = parseJson(currentRaw);
      const migrated = migrateLocalData(current);
      if (migrated) {
        if (JSON.stringify(current) !== JSON.stringify(migrated)) {
          this.write(migrated);
        }
        return { data: migrated, recovered: false };
      }

      this.safeRemove(LOCAL_DATA_STORAGE_KEY);
      return { data: defaultLocalGameData(), recovered: true };
    }

    const legacyRaw = this.safeGet(LEGACY_LOCAL_DATA_STORAGE_KEY);
    if (legacyRaw !== null) {
      const migrated = migrateLocalData(parseJson(legacyRaw));
      if (migrated) {
        this.write(migrated);
        this.safeRemove(LEGACY_LOCAL_DATA_STORAGE_KEY);
        this.safeRemove(LEGACY_CALIBRATION_STORAGE_KEY);
        return { data: migrated, recovered: false };
      }

      this.safeRemove(LEGACY_LOCAL_DATA_STORAGE_KEY);
      return { data: defaultLocalGameData(), recovered: true };
    }

    const legacyCalibration = parseJson(this.safeGet(LEGACY_CALIBRATION_STORAGE_KEY));
    if (isCalibrationProfile(legacyCalibration)) {
      const migrated = {
        ...defaultLocalGameData(),
        calibration: copyCalibration(legacyCalibration),
        settings: {
          ...DEFAULT_GAME_SETTINGS,
          controlPreference: "voice" as const,
        },
      };
      this.write(migrated);
      this.safeRemove(LEGACY_CALIBRATION_STORAGE_KEY);
      return { data: migrated, recovered: false };
    }

    if (legacyCalibration !== null) {
      this.safeRemove(LEGACY_CALIBRATION_STORAGE_KEY);
      return { data: defaultLocalGameData(), recovered: true };
    }

    return { data: defaultLocalGameData(), recovered: false };
  }

  write(data: LocalGameData): LocalGameData {
    const validated = sanitizeLocalGameData(data);
    if (!validated) {
      throw new RangeError("Cannot persist invalid local game data");
    }

    this.safeSet(LOCAL_DATA_STORAGE_KEY, JSON.stringify(validated));
    return validated;
  }

  updateSettings(settings: GameSettings): LocalGameData {
    const current = this.read().data;
    return this.write({ ...current, settings });
  }

  saveCalibration(calibration: CalibrationProfile | null): LocalGameData {
    if (calibration !== null && !isCalibrationProfile(calibration)) {
      throw new RangeError("Cannot persist an invalid calibration profile");
    }

    const current = this.read().data;
    return this.write({
      ...current,
      calibration: calibration ? copyCalibration(calibration) : null,
    });
  }

  recordCompletedRun(summary: RunSummary): {
    readonly data: LocalGameData;
    readonly recorded: boolean;
  } {
    const current = this.read().data;
    if (!isValidCompletedLocalRun(summary)) {
      return { data: current, recorded: false };
    }

    const statistics = {
      bestDistance: Math.max(current.statistics.bestDistance, summary.distance),
      bestScore: Math.max(current.statistics.bestScore, summary.score),
      completedRuns: current.statistics.completedRuns + 1,
      longestSurvivalMs: Math.max(current.statistics.longestSurvivalMs, summary.survivalMs),
    };
    return {
      data: this.write({ ...current, statistics }),
      recorded: true,
    };
  }

  reset(): LocalGameData {
    for (const key of this.safeKeys()) {
      if (key.startsWith(GAME_STORAGE_PREFIX)) {
        this.safeRemove(key);
      }
    }

    return defaultLocalGameData();
  }

  private safeGet(key: string): string | null {
    try {
      return this.storage.get(key);
    } catch {
      return null;
    }
  }

  private safeSet(key: string, value: string): void {
    try {
      this.storage.set(key, value);
    } catch {
      // Storage can be disabled or full. Gameplay must remain available in-memory.
    }
  }

  private safeRemove(key: string): void {
    try {
      this.storage.remove(key);
    } catch {
      // A blocked storage backend should not prevent recovery or reset UI.
    }
  }

  private safeKeys(): readonly string[] {
    try {
      return this.storage.keys();
    } catch {
      return [
        LOCAL_DATA_STORAGE_KEY,
        LEGACY_LOCAL_DATA_STORAGE_KEY,
        LEGACY_CALIBRATION_STORAGE_KEY,
      ];
    }
  }
}

export function withManualJumpThreshold(
  profile: CalibrationProfile,
  threshold: number,
): CalibrationProfile {
  if (!isCalibrationProfile(profile) || !Number.isFinite(threshold)) {
    throw new RangeError("A valid calibration and finite threshold are required");
  }

  const jumpEnterLevel = clamp(threshold, MIN_MANUAL_THRESHOLD, MAX_MANUAL_THRESHOLD);
  const jumpExitLevel = clamp(jumpEnterLevel - 0.2, 0.18, jumpEnterLevel - 0.08);
  return {
    ...copyCalibration(profile),
    jumpEnterLevel,
    jumpExitLevel,
    liftStartLevel: jumpEnterLevel,
  };
}

export function isValidCompletedLocalRun(summary: RunSummary): boolean {
  const scoreBreakdown = summary.scoreBreakdown;
  const statistics = summary.statistics;
  if (!isRecord(scoreBreakdown) || !isRecord(statistics)) {
    return false;
  }

  const validIdentityAndOutcome =
    summary.reason !== "quit" &&
    ["water", "hazard", "fall", "completed"].includes(summary.reason) &&
    isNonNegativeInteger(summary.score) &&
    isNonNegativeFinite(summary.survivalMs) &&
    isNonNegativeFinite(summary.distance) &&
    isNonNegativeInteger(summary.runId) &&
    summary.runId > 0 &&
    typeof summary.seed === "string" &&
    summary.seed.length > 0 &&
    typeof summary.gameplayVersion === "string" &&
    summary.gameplayVersion.length > 0;
  const validStatistics =
    isNonNegativeFinite(statistics.distance) &&
    isNonNegativeInteger(statistics.obstaclesCleared) &&
    isNonNegativeInteger(statistics.collectibles) &&
    isNonNegativeInteger(statistics.precisionLandings) &&
    isNonNegativeFinite(statistics.longestLiftMs) &&
    isNonNegativeInteger(statistics.highestDifficultyStage) &&
    statistics.highestDifficultyStage > 0;
  if (!validIdentityAndOutcome || !validStatistics) {
    return false;
  }

  const expectedScore = calculateScoreBreakdown(
    summary.survivalMs,
    statistics.collectibles,
    statistics.precisionLandings,
  );

  return (
    statistics.distance === summary.distance &&
    scoreBreakdown.survival === expectedScore.survival &&
    scoreBreakdown.collectibles === expectedScore.collectibles &&
    scoreBreakdown.precision === expectedScore.precision &&
    scoreBreakdown.total === expectedScore.total &&
    summary.score === expectedScore.total
  );
}

function migrateLocalData(value: unknown): LocalGameData | null {
  if (isLocalGameData(value)) {
    return sanitizeLocalGameData(value);
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return null;
  }

  const calibration = value.calibration;
  if (calibration !== null && !isCalibrationProfile(calibration)) {
    return null;
  }

  const settings = isRecord(value.settings) ? value.settings : {};
  const statistics = isRecord(value.statistics) ? value.statistics : {};
  const migrated: LocalGameData = {
    calibration: calibration ? copyCalibration(calibration) : null,
    schemaVersion: LOCAL_DATA_SCHEMA_VERSION,
    settings: {
      cameraEnabled: booleanOr(settings.cameraEnabled, DEFAULT_GAME_SETTINGS.cameraEnabled),
      controlPreference: isControlMode(settings.controlPreference)
        ? settings.controlPreference
        : DEFAULT_GAME_SETTINGS.controlPreference,
      copyVersion: nonNegativeIntegerOr(settings.copyVersion, DEFAULT_GAME_SETTINGS.copyVersion),
      muted: booleanOr(settings.muted, DEFAULT_GAME_SETTINGS.muted),
      reducedMotion: booleanOr(settings.reducedMotion, DEFAULT_GAME_SETTINGS.reducedMotion),
      replayConsent: booleanOr(settings.replayConsent, DEFAULT_GAME_SETTINGS.replayConsent),
      screenShakeEnabled: booleanOr(
        settings.screenShakeEnabled,
        DEFAULT_GAME_SETTINGS.screenShakeEnabled,
      ),
    },
    statistics: {
      bestDistance: nonNegativeNumberOr(
        statistics.bestDistance,
        DEFAULT_RUN_STATISTICS.bestDistance,
      ),
      bestScore: nonNegativeIntegerOr(statistics.bestScore, DEFAULT_RUN_STATISTICS.bestScore),
      completedRuns: nonNegativeIntegerOr(
        statistics.completedRuns,
        DEFAULT_RUN_STATISTICS.completedRuns,
      ),
      longestSurvivalMs: nonNegativeNumberOr(
        statistics.longestSurvivalMs,
        DEFAULT_RUN_STATISTICS.longestSurvivalMs,
      ),
    },
  };
  return sanitizeLocalGameData(migrated);
}

function isLocalGameData(value: unknown): value is LocalGameData {
  return (
    isRecord(value) &&
    value.schemaVersion === LOCAL_DATA_SCHEMA_VERSION &&
    (value.calibration === null || isCalibrationProfile(value.calibration)) &&
    isGameSettings(value.settings) &&
    isRunStatistics(value.statistics)
  );
}

function sanitizeLocalGameData(value: LocalGameData): LocalGameData | null {
  if (!isLocalGameData(value)) {
    return null;
  }

  return {
    calibration: value.calibration ? copyCalibration(value.calibration) : null,
    schemaVersion: LOCAL_DATA_SCHEMA_VERSION,
    settings: {
      cameraEnabled: value.settings.cameraEnabled,
      controlPreference: value.settings.controlPreference,
      copyVersion: value.settings.copyVersion,
      muted: value.settings.muted,
      reducedMotion: value.settings.reducedMotion,
      replayConsent: value.settings.replayConsent,
      screenShakeEnabled: value.settings.screenShakeEnabled,
    },
    statistics: {
      bestDistance: value.statistics.bestDistance,
      bestScore: value.statistics.bestScore,
      completedRuns: value.statistics.completedRuns,
      longestSurvivalMs: value.statistics.longestSurvivalMs,
    },
  };
}

function isGameSettings(value: unknown): value is GameSettings {
  return (
    isRecord(value) &&
    typeof value.cameraEnabled === "boolean" &&
    isControlMode(value.controlPreference) &&
    isNonNegativeInteger(value.copyVersion) &&
    typeof value.muted === "boolean" &&
    typeof value.reducedMotion === "boolean" &&
    typeof value.replayConsent === "boolean" &&
    typeof value.screenShakeEnabled === "boolean"
  );
}

function isRunStatistics(value: unknown): value is RunStatistics {
  return (
    isRecord(value) &&
    isNonNegativeFinite(value.bestDistance) &&
    isNonNegativeInteger(value.bestScore) &&
    isNonNegativeInteger(value.completedRuns) &&
    isNonNegativeFinite(value.longestSurvivalMs)
  );
}

function copyCalibration(profile: CalibrationProfile): CalibrationProfile {
  return {
    jumpEnterLevel: profile.jumpEnterLevel,
    jumpExitLevel: profile.jumpExitLevel,
    liftStartLevel: profile.liftStartLevel,
    loudDb: profile.loudDb,
    noiseFloorDb: profile.noiseFloorDb,
    normalDb: profile.normalDb,
    schemaVersion: 1,
  };
}

function parseJson(raw: string | null): unknown {
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isControlMode(value: unknown): value is ControlMode {
  return value === "voice" || value === "keyboard-touch";
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeFinite(value) && Number.isSafeInteger(value);
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function nonNegativeNumberOr(value: unknown, fallback: number): number {
  return isNonNegativeFinite(value) ? value : fallback;
}

function nonNegativeIntegerOr(value: unknown, fallback: number): number {
  return isNonNegativeInteger(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
