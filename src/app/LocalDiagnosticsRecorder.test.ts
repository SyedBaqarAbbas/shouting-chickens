import { describe, expect, it } from "vitest";

import type { SafeLocalRuntimeDiagnostics } from "../game/PhaserGameRuntime";
import type { MediaSessionDiagnostics } from "../platform/media";
import {
  LocalDiagnosticsRecorder,
  REFERENCE_EVIDENCE_DURATION_MS,
  type ReferenceEvidenceObservation,
} from "./LocalDiagnosticsRecorder";

const runtime: SafeLocalRuntimeDiagnostics = {
  capabilities: { gameAudio: true, phaserMounted: true },
  performance: {
    frameBudgetMet: true,
    frameOverBudgetRatio: 0,
    frameP50Ms: 16,
    frameP95Ms: 18,
    frameSamples: 36_000,
    inputBudgetMet: true,
    inputSamples: 120,
    inputToIntentP95Ms: 42,
    voiceInputBudgetMet: true,
    voiceInputSamples: 120,
    voiceInputToIntentP95Ms: 42,
  },
  release: { commit: "0123456789abcdef", version: "0.1.0" },
  renderer: "webgl",
  resources: {
    activeBodies: 1,
    activeParticles: 0,
    activeTimers: 0,
    audioActiveVoices: 0,
    audioGraphNodes: 2,
    eventListeners: 1,
    inputListeners: 5,
    pooledObjects: 72,
    retainedCollectibleIds: 2,
    retainedCollisionIds: 0,
    retainedObstacleIds: 4,
    retainedPrecisionLandingIds: 1,
    sceneObjects: 86,
  },
  run: { gameplayVersion: "sho-17-progression-v1", seed: "authored-launch" },
  schemaVersion: 1,
};

const media: MediaSessionDiagnostics = {
  capabilities: {
    audioContext: true,
    audioWorklet: true,
    camera: true,
    deviceEnumeration: true,
    microphone: true,
  },
  resources: {
    activeAudioNodes: 2,
    activeCameraTracks: 1,
    activeMicrophoneTracks: 1,
    activeTracks: 2,
    lifecycleListeners: 3,
    pendingAudioContexts: 0,
    sessionSubscribers: 2,
    trackListeners: 6,
  },
  schemaVersion: 1,
};

function observation(
  nowMs: number,
  patch: Partial<ReferenceEvidenceObservation> = {},
): ReferenceEvidenceObservation {
  return {
    controlModeValid: true,
    gameplayActive: true,
    media,
    nowMs,
    nowUtc: new Date(nowMs).toISOString(),
    qualifying: true,
    runtime,
    visible: true,
    ...patch,
  };
}

describe("LocalDiagnosticsRecorder", () => {
  it("completes only after ten active qualifying minutes and freezes constant-size evidence", () => {
    const recorder = new LocalDiagnosticsRecorder(0, new Date(0).toISOString());

    for (let second = 0; second <= 600; second += 1) {
      recorder.observe(observation(second * 1_000));
    }
    const completed = recorder.snapshot();
    expect(completed).toMatchObject({
      activeEvidenceMs: REFERENCE_EVIDENCE_DURATION_MS,
      qualifyingSamples: 601,
      totalSamples: 601,
      verdict: {
        duration: true,
        frame: true,
        input: true,
        mediaResources: true,
        pass: true,
        runtimeResources: true,
      },
    });
    expect(completed.completedAtUtc).not.toBeNull();

    const frozen = recorder.observe(
      observation(900_000, {
        media: null,
        qualifying: false,
        runtime: null,
      }),
    );
    expect(frozen).toEqual(completed);
    expect(Object.keys(frozen).sort()).toEqual([
      "activeEvidenceMs",
      "completedAtUtc",
      "controlModeViolations",
      "media",
      "performance",
      "qualifyingSamples",
      "release",
      "renderer",
      "run",
      "runtime",
      "schemaVersion",
      "startedAtUtc",
      "totalSamples",
      "verdict",
      "visibilityInterruptions",
      "wallElapsedMs",
    ]);
    expect(JSON.stringify(frozen)).not.toMatch(
      /blob|dbfs|deviceId|label|normalizedInput|normalizedLevel|peak|raw|recording|rms/i,
    );
  });

  it("does not count inactive, hidden, or timer-throttled gaps as active evidence", () => {
    const recorder = new LocalDiagnosticsRecorder(0, new Date(0).toISOString());
    recorder.observe(observation(0));
    recorder.observe(observation(1_000));
    recorder.observe(
      observation(2_000, {
        gameplayActive: false,
        qualifying: false,
      }),
    );
    recorder.observe(observation(3_000));
    recorder.observe(observation(5_000));
    recorder.observe(
      observation(6_000, {
        qualifying: false,
        visible: false,
      }),
    );
    recorder.observe(observation(7_000));
    recorder.observe(observation(8_000));

    expect(recorder.snapshot()).toMatchObject({
      activeEvidenceMs: 2_000,
      visibilityInterruptions: 1,
      verdict: { duration: false, pass: false },
      wallElapsedMs: 8_000,
    });
  });

  it("allows camera setup after an inactive restart but rejects a live control interruption", () => {
    const recorder = new LocalDiagnosticsRecorder(0, new Date(0).toISOString());
    recorder.observe(observation(0));
    recorder.observe(observation(1_000));
    recorder.observe(
      observation(2_000, {
        gameplayActive: false,
        qualifying: false,
      }),
    );
    recorder.observe(
      observation(3_000, {
        controlModeValid: false,
        qualifying: false,
      }),
    );
    recorder.observe(observation(4_000));
    expect(recorder.snapshot().controlModeViolations).toBe(0);

    recorder.observe(
      observation(5_000, {
        controlModeValid: false,
        qualifying: false,
      }),
    );
    expect(recorder.snapshot().controlModeViolations).toBe(1);
  });

  it("treats bounded cue voices and their graph nodes as dynamic resources", () => {
    const recorder = new LocalDiagnosticsRecorder(0, new Date(0).toISOString());
    recorder.observe(observation(0));
    recorder.observe(
      observation(1_000, {
        runtime: {
          ...runtime,
          resources: {
            ...runtime.resources,
            audioActiveVoices: 1,
            audioGraphNodes: 4,
          },
        },
      }),
    );
    recorder.observe(observation(2_000));

    expect(recorder.snapshot()).toMatchObject({
      runtime: {
        max: { audioActiveVoices: 1, audioGraphNodes: 4 },
        stableMismatchCount: 0,
      },
      verdict: { runtimeResources: true },
    });
  });

  it("fails evidence when active play violates voice/media mode or stable resources drift", () => {
    const recorder = new LocalDiagnosticsRecorder(0, new Date(0).toISOString());
    recorder.observe(observation(0));
    recorder.observe(
      observation(1_000, {
        controlModeValid: false,
        qualifying: false,
      }),
    );
    recorder.observe(observation(2_000));
    recorder.observe(
      observation(3_000, {
        runtime: {
          ...runtime,
          resources: { ...runtime.resources, inputListeners: 6 },
        },
      }),
    );

    expect(recorder.snapshot()).toMatchObject({
      controlModeViolations: 1,
      runtime: { stableMismatchCount: 1 },
      verdict: { duration: false, pass: false, runtimeResources: false },
    });
  });

  it("rejects already-inflated runtime and media baselines", () => {
    const recorder = new LocalDiagnosticsRecorder(0, new Date(0).toISOString());
    recorder.observe(
      observation(0, {
        media: {
          ...media,
          resources: {
            ...media.resources,
            activeAudioNodes: 99,
            lifecycleListeners: 99,
            sessionSubscribers: 99,
            trackListeners: 99,
          },
        },
        runtime: {
          ...runtime,
          resources: {
            ...runtime.resources,
            activeTimers: 99,
            eventListeners: 99,
            inputListeners: 99,
            pooledObjects: 999,
            sceneObjects: 999,
          },
        },
      }),
    );

    expect(recorder.snapshot().verdict).toMatchObject({
      mediaResources: false,
      pass: false,
      runtimeResources: false,
    });
  });

  it("rejects fast fallback inputs when no voice latency samples were measured", () => {
    const recorder = new LocalDiagnosticsRecorder(0, new Date(0).toISOString());
    const fallbackOnlyRuntime: SafeLocalRuntimeDiagnostics = {
      ...runtime,
      performance: {
        ...runtime.performance,
        inputBudgetMet: true,
        inputSamples: 120,
        inputToIntentP95Ms: 12,
        voiceInputBudgetMet: null,
        voiceInputSamples: 0,
        voiceInputToIntentP95Ms: null,
      },
    };

    for (let second = 0; second <= 600; second += 1) {
      recorder.observe(observation(second * 1_000, { runtime: fallbackOnlyRuntime }));
    }

    expect(recorder.snapshot().verdict).toMatchObject({
      duration: true,
      input: false,
      pass: false,
    });
  });
});
