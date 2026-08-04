import { describe, expect, it } from "vitest";

import type { CalibrationProfile, KeyValueStorage, RunSummary } from "../../core/contracts";
import { MemoryStorage } from "../../core/storage";
import {
  CURRENT_COPY_VERSION,
  DEFAULT_GAME_SETTINGS,
  GAME_STORAGE_PREFIX,
  LEGACY_CALIBRATION_STORAGE_KEY,
  LEGACY_LOCAL_DATA_STORAGE_KEY,
  LOCAL_DATA_SCHEMA_VERSION,
  LOCAL_DATA_STORAGE_KEY,
  LocalGameDataStore,
  MAX_MANUAL_THRESHOLD,
  MIN_MANUAL_THRESHOLD,
  createBrowserLocalGameDataStore,
  defaultLocalGameData,
  withManualJumpThreshold,
} from "./localGameData";

const PROFILE: CalibrationProfile = {
  jumpEnterLevel: 0.51,
  jumpExitLevel: 0.31,
  liftStartLevel: 0.51,
  loudDb: -10,
  noiseFloorDb: -60,
  normalDb: -30,
  schemaVersion: 1,
};

const COMPLETED_RUN: RunSummary = {
  distance: 432,
  gameplayVersion: "sho-19",
  reason: "water",
  runId: 1,
  score: 42,
  scoreBreakdown: {
    survival: 42,
    collectibles: 0,
    precision: 0,
    total: 42,
  },
  seed: "looping-course",
  statistics: {
    distance: 432,
    obstaclesCleared: 3,
    collectibles: 0,
    precisionLandings: 0,
    longestLiftMs: 800,
    highestDifficultyStage: 2,
  },
  survivalMs: 4_200,
};

describe("LocalGameDataStore", () => {
  it("starts with safe versioned defaults without writing media-shaped data", () => {
    const storage = new MemoryStorage();
    const store = new LocalGameDataStore(storage);

    expect(store.read()).toEqual({
      data: defaultLocalGameData(),
      recovered: false,
    });
    expect(storage.keys()).toEqual([]);
  });

  it("migrates the complete v1 schema and fills settings introduced by v2", () => {
    const storage = new MemoryStorage();
    storage.set(
      LEGACY_LOCAL_DATA_STORAGE_KEY,
      JSON.stringify({
        calibration: PROFILE,
        schemaVersion: 1,
        settings: {
          cameraEnabled: true,
          controlPreference: "voice",
          copyVersion: CURRENT_COPY_VERSION,
          muted: true,
          reducedMotion: true,
        },
        statistics: {
          bestDistance: 800,
          bestScore: 80,
          completedRuns: 3,
          longestSurvivalMs: 8_000,
        },
      }),
    );

    const result = new LocalGameDataStore(storage).read();

    expect(result.recovered).toBe(false);
    expect(result.data).toEqual({
      calibration: PROFILE,
      schemaVersion: LOCAL_DATA_SCHEMA_VERSION,
      settings: {
        cameraEnabled: true,
        controlPreference: "voice",
        copyVersion: CURRENT_COPY_VERSION,
        muted: true,
        reducedMotion: true,
        replayConsent: DEFAULT_GAME_SETTINGS.replayConsent,
        screenShakeEnabled: DEFAULT_GAME_SETTINGS.screenShakeEnabled,
      },
      statistics: {
        bestDistance: 800,
        bestScore: 80,
        completedRuns: 3,
        longestSurvivalMs: 8_000,
      },
    });
    expect(storage.get(LEGACY_LOCAL_DATA_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(storage.get(LOCAL_DATA_STORAGE_KEY)!)).toEqual(result.data);
  });

  it("migrates the legacy derived calibration without persisting samples", () => {
    const storage = new MemoryStorage();
    storage.set(LEGACY_CALIBRATION_STORAGE_KEY, JSON.stringify(PROFILE));

    const result = new LocalGameDataStore(storage).read();
    const persisted = storage.get(LOCAL_DATA_STORAGE_KEY)!;

    expect(result.data.calibration).toEqual(PROFILE);
    expect(result.data.settings.controlPreference).toBe("voice");
    expect(persisted).not.toContain("samples");
    expect(persisted).not.toContain("audio");
    expect(storage.get(LEGACY_CALIBRATION_STORAGE_KEY)).toBeNull();
  });

  it("canonicalizes valid records so unknown media-shaped fields cannot remain", () => {
    const storage = new MemoryStorage();
    storage.set(
      LOCAL_DATA_STORAGE_KEY,
      JSON.stringify({
        ...defaultLocalGameData(),
        rawSamples: [0.2, 0.5],
        recordingUrl: "blob:private-voice",
      }),
    );

    const result = new LocalGameDataStore(storage).read();
    const persisted = storage.get(LOCAL_DATA_STORAGE_KEY)!;

    expect(result.recovered).toBe(false);
    expect(result.data).toEqual(defaultLocalGameData());
    expect(persisted).not.toContain("rawSamples");
    expect(persisted).not.toContain("recordingUrl");
    expect(persisted).not.toContain("blob:");
  });

  it.each([
    ["corrupt JSON", "{not-json"],
    ["unknown schema", JSON.stringify({ schemaVersion: 99 })],
    [
      "invalid calibration",
      JSON.stringify({
        ...defaultLocalGameData(),
        calibration: { ...PROFILE, loudDb: -90 },
      }),
    ],
  ])("recovers safely from %s", (_label, raw) => {
    const storage = new MemoryStorage();
    storage.set(LOCAL_DATA_STORAGE_KEY, raw);

    expect(new LocalGameDataStore(storage).read()).toEqual({
      data: defaultLocalGameData(),
      recovered: true,
    });
    expect(storage.get(LOCAL_DATA_STORAGE_KEY)).toBeNull();
  });

  it("resets every game-owned key but preserves unrelated origin storage", () => {
    const storage = new MemoryStorage();
    storage.set(LOCAL_DATA_STORAGE_KEY, JSON.stringify(defaultLocalGameData()));
    storage.set(`${GAME_STORAGE_PREFIX}future-cache.v9`, "owned");
    storage.set("another-game.settings", "preserve");

    const data = new LocalGameDataStore(storage).reset();

    expect(data).toEqual(defaultLocalGameData());
    expect(storage.keys()).toEqual(["another-game.settings"]);
  });

  it("keeps working when a browser storage backend rejects every operation", () => {
    const blockedStorage: KeyValueStorage = {
      clear: () => {
        throw new DOMException("blocked");
      },
      get: () => {
        throw new DOMException("blocked");
      },
      keys: () => {
        throw new DOMException("blocked");
      },
      remove: () => {
        throw new DOMException("blocked");
      },
      set: () => {
        throw new DOMException("blocked");
      },
    };
    const store = new LocalGameDataStore(blockedStorage);

    expect(store.read().data).toEqual(defaultLocalGameData());
    expect(store.write(defaultLocalGameData())).toEqual(defaultLocalGameData());
    expect(store.reset()).toEqual(defaultLocalGameData());
  });

  it("falls back in memory when reading window.localStorage itself throws", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage is unavailable", "SecurityError");
      },
    });

    try {
      const store = createBrowserLocalGameDataStore();
      expect(store.read()).toEqual({
        data: defaultLocalGameData(),
        recovered: false,
      });
      expect(
        store.updateSettings({
          ...DEFAULT_GAME_SETTINGS,
          muted: true,
        }).settings.muted,
      ).toBe(true);
    } finally {
      if (descriptor) {
        Object.defineProperty(window, "localStorage", descriptor);
      }
    }
  });

  it("records only completed, finite local runs and never lets a weaker run lower bests", () => {
    const store = new LocalGameDataStore(new MemoryStorage());

    expect(store.recordCompletedRun(COMPLETED_RUN)).toMatchObject({
      recorded: true,
      data: {
        statistics: {
          bestDistance: 432,
          bestScore: 42,
          completedRuns: 1,
          longestSurvivalMs: 4_200,
        },
      },
    });
    expect(
      store.recordCompletedRun({
        ...COMPLETED_RUN,
        distance: 200,
        score: 20,
        scoreBreakdown: {
          survival: 20,
          collectibles: 0,
          precision: 0,
          total: 20,
        },
        statistics: {
          ...COMPLETED_RUN.statistics,
          distance: 200,
        },
        survivalMs: 2_000,
      }),
    ).toMatchObject({
      recorded: true,
      data: {
        statistics: {
          bestDistance: 432,
          bestScore: 42,
          completedRuns: 2,
          longestSurvivalMs: 4_200,
        },
      },
    });

    for (const invalid of [
      { ...COMPLETED_RUN, reason: "quit" as const },
      { ...COMPLETED_RUN, score: Number.NaN },
      { ...COMPLETED_RUN, survivalMs: -1 },
      { ...COMPLETED_RUN, seed: "" },
      {
        ...COMPLETED_RUN,
        scoreBreakdown: { ...COMPLETED_RUN.scoreBreakdown, total: 43 },
      },
      {
        ...COMPLETED_RUN,
        scoreBreakdown: { ...COMPLETED_RUN.scoreBreakdown, collectibles: 25, total: 67 },
      },
      {
        ...COMPLETED_RUN,
        statistics: { ...COMPLETED_RUN.statistics, distance: 431 },
      },
      {
        ...COMPLETED_RUN,
        statistics: { ...COMPLETED_RUN.statistics, highestDifficultyStage: 0 },
      },
      {
        ...COMPLETED_RUN,
        statistics: {
          ...COMPLETED_RUN.statistics,
          collectibles: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    ]) {
      expect(store.recordCompletedRun(invalid).recorded).toBe(false);
    }
    expect(store.read().data.statistics.completedRuns).toBe(2);
  });
});

describe("manual calibration threshold", () => {
  it("clamps adjustments to safe bounds and maintains valid hysteresis", () => {
    const low = withManualJumpThreshold(PROFILE, -1);
    const high = withManualJumpThreshold(PROFILE, 10);

    expect(low).toMatchObject({
      jumpEnterLevel: MIN_MANUAL_THRESHOLD,
      liftStartLevel: MIN_MANUAL_THRESHOLD,
    });
    expect(high).toMatchObject({
      jumpEnterLevel: MAX_MANUAL_THRESHOLD,
      liftStartLevel: MAX_MANUAL_THRESHOLD,
    });
    for (const adjusted of [low, high]) {
      expect(adjusted.jumpExitLevel).toBeLessThan(adjusted.jumpEnterLevel);
      expect(adjusted.jumpEnterLevel - adjusted.jumpExitLevel).toBeGreaterThanOrEqual(0.08);
    }
  });

  it("rejects invalid profiles and non-finite adjustments", () => {
    expect(() => withManualJumpThreshold(PROFILE, Number.NaN)).toThrow(RangeError);
    expect(() =>
      withManualJumpThreshold({ ...PROFILE, jumpExitLevel: PROFILE.jumpEnterLevel }, 0.5),
    ).toThrow(RangeError);
  });
});
