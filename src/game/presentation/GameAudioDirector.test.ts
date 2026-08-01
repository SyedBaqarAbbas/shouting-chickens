import { describe, expect, it, vi } from "vitest";

import type { SimulationSnapshot } from "../simulation";
import {
  GAME_AUDIO_CUES,
  MAX_GAME_AUDIO_DURATION_MS,
  MAX_GAME_AUDIO_OUTPUT_GAIN,
  MAX_MODELED_FEEDBACK_LEVEL,
  GameAudioDirector,
  audioCuesForTransition,
  createHardLimitCurve,
  estimateModeledFeedbackLevel,
} from "./GameAudioDirector";

const BASE_SNAPSHOT: SimulationSnapshot = {
  phase: "running",
  tick: 1,
  elapsedMs: 16,
  score: 0,
  scoreBreakdown: {
    survival: 0,
    collectibles: 0,
    precision: 0,
    total: 0,
  },
  distance: 0,
  courseDistance: 0,
  loopsCompleted: 0,
  currentChunkIndex: 0,
  currentChunkId: "test",
  difficultyStage: 1,
  difficulty: 1,
  worldSpeed: 144,
  liftStamina: 1,
  effectiveLift: 0,
  chicken: {
    x: 112,
    y: 400,
    velocityY: 0,
    grounded: true,
    supportingPlatformId: "platform",
    animation: "run",
  },
  deathReason: null,
  collisionId: null,
  landingCount: 0,
  collectedCollectibleIds: [],
  statistics: {
    distance: 0,
    obstaclesCleared: 0,
    collectibles: 0,
    precisionLandings: 0,
    longestLiftMs: 0,
    highestDifficultyStage: 1,
  },
};

describe("GameAudioDirector", () => {
  it("derives one-shot cues from deterministic simulation transitions", () => {
    expect(audioCuesForTransition(null, BASE_SNAPSHOT)).toEqual([]);
    expect(
      audioCuesForTransition(BASE_SNAPSHOT, {
        ...BASE_SNAPSHOT,
        chicken: { ...BASE_SNAPSHOT.chicken, animation: "jump", grounded: false },
      }),
    ).toEqual(["jump"]);
    expect(
      audioCuesForTransition(BASE_SNAPSHOT, {
        ...BASE_SNAPSHOT,
        collectedCollectibleIds: ["feather"],
        statistics: { ...BASE_SNAPSHOT.statistics, collectibles: 1 },
      }),
    ).toEqual(["feather"]);
    expect(
      audioCuesForTransition(BASE_SNAPSHOT, {
        ...BASE_SNAPSHOT,
        phase: "dead",
        deathReason: "hazard",
      }),
    ).toEqual(["hazard"]);
  });

  it("selects one deterministic cue when transitions happen together", () => {
    expect(
      audioCuesForTransition(BASE_SNAPSHOT, {
        ...BASE_SNAPSHOT,
        phase: "dead",
        deathReason: "hazard",
        landingCount: 1,
        collectedCollectibleIds: ["feather"],
        statistics: { ...BASE_SNAPSHOT.statistics, collectibles: 1 },
        chicken: { ...BASE_SNAPSHOT.chicken, animation: "jump" },
      }),
    ).toEqual(["hazard"]);
    expect(
      audioCuesForTransition(BASE_SNAPSHOT, {
        ...BASE_SNAPSHOT,
        landingCount: 1,
        collectedCollectibleIds: ["feather"],
        statistics: { ...BASE_SNAPSHOT.statistics, collectibles: 1 },
        chicken: { ...BASE_SNAPSHOT.chicken, animation: "jump" },
      }),
    ).toEqual(["feather"]);
    expect(
      audioCuesForTransition(BASE_SNAPSHOT, {
        ...BASE_SNAPSHOT,
        landingCount: 1,
        chicken: { ...BASE_SNAPSHOT.chicken, animation: "jump" },
      }),
    ).toEqual(["land"]);
  });

  it("keeps the aggregate synthesized mix short, quiet, and under the feedback safety model", () => {
    for (const cue of Object.values(GAME_AUDIO_CUES)) {
      expect(cue.durationMs).toBeLessThanOrEqual(MAX_GAME_AUDIO_DURATION_MS);
      expect(cue.peakOutputGain).toBeLessThanOrEqual(MAX_GAME_AUDIO_OUTPUT_GAIN);
      expect(estimateModeledFeedbackLevel(cue)).toBeLessThanOrEqual(MAX_MODELED_FEEDBACK_LEVEL);
    }
  });

  it("hard-limits the final mix while preserving samples already inside the ceiling", () => {
    const curve = createHardLimitCurve();
    expect(curve).toHaveLength(4_097);
    expect(Math.max(...curve)).toBeLessThanOrEqual(MAX_GAME_AUDIO_OUTPUT_GAIN);
    expect(Math.min(...curve)).toBeGreaterThanOrEqual(-MAX_GAME_AUDIO_OUTPUT_GAIN);
    expect(curve[2_048]).toBe(0);
    expect(curve[2_080]).toBeCloseTo(0.015625, 6);
    expect(curve[4_096]).toBeCloseTo(MAX_GAME_AUDIO_OUTPUT_GAIN, 6);
  });

  it("does not create repeated cues while an animation state is unchanged", () => {
    const flap = {
      ...BASE_SNAPSHOT,
      chicken: { ...BASE_SNAPSHOT.chicken, animation: "flap" as const },
    };
    expect(audioCuesForTransition(BASE_SNAPSHOT, flap)).toEqual(["flap"]);
    expect(audioCuesForTransition(flap, { ...flap, tick: 2 })).toEqual([]);
  });

  it("suppresses cue creation while muted without replaying it after unmute", () => {
    let contextRequests = 0;
    const director = new GameAudioDirector(() => {
      contextRequests += 1;
      return null;
    });
    const jump = {
      ...BASE_SNAPSHOT,
      chicken: { ...BASE_SNAPSHOT.chicken, animation: "jump" as const },
    };

    director.render(BASE_SNAPSHOT, {
      muted: true,
      reducedMotion: false,
      screenShakeEnabled: true,
    });
    director.render(jump, {
      muted: true,
      reducedMotion: false,
      screenShakeEnabled: true,
    });
    director.render(jump, {
      muted: false,
      reducedMotion: false,
      screenShakeEnabled: true,
    });

    expect(contextRequests).toBe(0);
    expect(director.diagnostics()).toMatchObject({ cueCount: 0, lastCue: null, state: "idle" });
    director.destroy();
  });

  it("keeps play non-blocking when Web Audio is unavailable", () => {
    const director = new GameAudioDirector(() => null);
    const jump = {
      ...BASE_SNAPSHOT,
      chicken: { ...BASE_SNAPSHOT.chicken, animation: "jump" as const, grounded: false },
    };

    director.render(BASE_SNAPSHOT, {
      muted: false,
      reducedMotion: false,
      screenShakeEnabled: true,
    });
    expect(() =>
      director.render(jump, {
        muted: false,
        reducedMotion: false,
        screenShakeEnabled: true,
      }),
    ).not.toThrow();
    expect(director.diagnostics()).toMatchObject({
      cueCount: 0,
      lastCue: null,
      state: "unavailable",
    });
    director.destroy();
  });

  it("requires an explicit gesture to resume after background suspension", async () => {
    const context = createLifecycleContext("suspended");
    const director = new GameAudioDirector(() => context.context);

    expect(await director.resumeFromGesture()).toBe(true);
    expect(context.resume).toHaveBeenCalledOnce();
    expect(director.diagnostics()).toMatchObject({
      graphNodes: 2,
      state: "ready",
    });

    await director.suspendForBackground();
    expect(context.suspend).toHaveBeenCalledOnce();
    expect(director.diagnostics().state).toBe("suspended");

    director.render(BASE_SNAPSHOT, {
      muted: false,
      reducedMotion: false,
      screenShakeEnabled: true,
    });
    director.render(
      {
        ...BASE_SNAPSHOT,
        chicken: { ...BASE_SNAPSHOT.chicken, animation: "jump" },
      },
      {
        muted: false,
        reducedMotion: false,
        screenShakeEnabled: true,
      },
    );
    expect(director.diagnostics().cueCount).toBe(0);

    expect(await director.resumeFromGesture()).toBe(true);
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(director.diagnostics().state).toBe("ready");
    director.destroy();
  });

  it("recovers a browser-closed output context on the next gesture", async () => {
    const first = createLifecycleContext("running");
    const second = createLifecycleContext("running");
    const contexts = [first.context, second.context];
    const director = new GameAudioDirector(() => contexts.shift() ?? null);

    expect(await director.resumeFromGesture()).toBe(true);
    first.setState("closed");
    expect(director.diagnostics()).toMatchObject({ graphNodes: 0, state: "idle" });

    expect(await director.resumeFromGesture()).toBe(true);
    expect(director.diagnostics()).toMatchObject({ graphNodes: 2, state: "ready" });
    director.destroy();
  });

  it("finishes a pending suspension before confirming a rapid gesture resume", async () => {
    const context = createLifecycleContext("running", true);
    const director = new GameAudioDirector(() => context.context);

    expect(await director.resumeFromGesture()).toBe(true);
    const suspension = director.suspendForBackground();
    const resumed = director.resumeFromGesture();
    context.finishPendingSuspend();

    await suspension;
    expect(await resumed).toBe(true);
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(director.diagnostics().state).toBe("ready");
    director.destroy();
  });

  it("re-suspends a stale pending resume after the page is hidden", async () => {
    const context = createLifecycleContext("suspended", false, true);
    const director = new GameAudioDirector(() => context.context);

    const staleResume = director.resumeFromGesture();
    await director.suspendForBackground();
    context.finishPendingResume();

    expect(await staleResume).toBe(false);
    await vi.waitFor(() => expect(context.suspend).toHaveBeenCalledOnce());
    expect(context.currentState()).toBe("suspended");
    expect(director.diagnostics().state).toBe("suspended");
    director.destroy();
  });

  it("hard-limits the graph, preempts active cues on transitions and reset, and closes it", () => {
    const masterValues: number[] = [];
    let gainNodeCount = 0;
    const gainNodes: Array<{
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    const oscillators: Array<{
      addEventListener: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }> = [];
    const limiter = {
      connect: vi.fn(),
      curve: null,
      disconnect: vi.fn(),
      oversample: "none",
    };
    const close = vi.fn(() => Promise.resolve());
    const context = {
      addEventListener: vi.fn(),
      close,
      createGain: vi.fn(() => {
        const isMaster = gainNodeCount === 0;
        gainNodeCount += 1;
        const node = {
          connect: vi.fn(),
          disconnect: vi.fn(),
          gain: {
            cancelScheduledValues: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
            linearRampToValueAtTime: vi.fn(),
            setValueAtTime: vi.fn((value: number) => {
              if (isMaster) {
                masterValues.push(value);
              }
            }),
          },
        };
        gainNodes.push(node);
        return node as unknown as GainNode;
      }),
      createOscillator: vi.fn(() => {
        const oscillator = {
          addEventListener: vi.fn(),
          connect: vi.fn(),
          disconnect: vi.fn(),
          frequency: {
            exponentialRampToValueAtTime: vi.fn(),
            setValueAtTime: vi.fn(),
          },
          start: vi.fn(),
          stop: vi.fn(),
          type: "sine",
        };
        oscillators.push(oscillator);
        return oscillator as unknown as OscillatorNode;
      }),
      createWaveShaper: vi.fn(() => limiter as unknown as WaveShaperNode),
      currentTime: 1,
      destination: {} as AudioDestinationNode,
      resume: vi.fn(() => Promise.resolve()),
      removeEventListener: vi.fn(),
      state: "running",
      suspend: vi.fn(() => Promise.resolve()),
    } as unknown as AudioContext;
    const director = new GameAudioDirector(() => context);
    const jump = {
      ...BASE_SNAPSHOT,
      chicken: { ...BASE_SNAPSHOT.chicken, animation: "jump" as const, grounded: false },
    };
    const landing = {
      ...BASE_SNAPSHOT,
      tick: 2,
      landingCount: 1,
    };

    director.render(BASE_SNAPSHOT, {
      muted: false,
      reducedMotion: false,
      screenShakeEnabled: true,
    });
    director.render(jump, {
      muted: false,
      reducedMotion: false,
      screenShakeEnabled: true,
    });
    expect(director.diagnostics()).toMatchObject({ cueCount: 1, lastCue: "jump", state: "ready" });
    expect(context.createWaveShaper).toHaveBeenCalledOnce();
    expect(limiter.oversample).toBe("none");
    expect(Math.max(...(limiter.curve as unknown as Float32Array))).toBeLessThanOrEqual(
      MAX_GAME_AUDIO_OUTPUT_GAIN,
    );
    expect(limiter.connect).toHaveBeenCalledWith(gainNodes[0]);
    expect(gainNodes[1]?.connect).toHaveBeenCalledWith(limiter);

    director.render(landing, {
      muted: false,
      reducedMotion: false,
      screenShakeEnabled: true,
    });
    expect(oscillators[0]?.stop).toHaveBeenLastCalledWith(context.currentTime);
    expect(oscillators[0]?.disconnect).toHaveBeenCalledOnce();
    expect(gainNodes[1]?.disconnect).toHaveBeenCalledOnce();
    expect(director.diagnostics()).toMatchObject({ cueCount: 2, lastCue: "land" });

    director.render(
      { ...landing, tick: 3 },
      {
        muted: true,
        reducedMotion: false,
        screenShakeEnabled: true,
      },
    );
    expect(masterValues.at(-1)).toBe(0);
    expect(oscillators[1]?.stop).toHaveBeenLastCalledWith(context.currentTime);
    expect(director.diagnostics().cueCount).toBe(2);

    director.render(
      { ...jump, tick: 4, landingCount: 1 },
      {
        muted: false,
        reducedMotion: false,
        screenShakeEnabled: true,
      },
    );
    expect(masterValues.at(-1)).toBe(1);
    expect(director.diagnostics()).toMatchObject({ cueCount: 3, lastCue: "jump" });

    director.reset(BASE_SNAPSHOT);
    expect(oscillators[2]?.stop).toHaveBeenLastCalledWith(context.currentTime);
    expect(oscillators[2]?.disconnect).toHaveBeenCalledOnce();
    expect(gainNodes[3]?.disconnect).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(director.diagnostics()).toMatchObject({ cueCount: 3, state: "ready" });

    director.destroy();
    expect(close).toHaveBeenCalledOnce();
    expect(limiter.disconnect).toHaveBeenCalledOnce();
    expect(gainNodes[0]?.disconnect).toHaveBeenCalledOnce();
    expect(director.diagnostics().state).toBe("destroyed");
  });
});

function createLifecycleContext(
  initialState: AudioContextState,
  deferSuspend = false,
  deferResume = false,
) {
  const events = new EventTarget();
  let state = initialState;
  let finishResume: (() => void) | null = null;
  let finishSuspend: (() => void) | null = null;
  const gain = {
    cancelScheduledValues: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
  };
  const makeNode = () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  const resume = vi.fn(() => {
    if (!deferResume) {
      state = "running";
      events.dispatchEvent(new Event("statechange"));
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      finishResume = () => {
        state = "running";
        events.dispatchEvent(new Event("statechange"));
        resolve();
      };
    });
  });
  const suspend = vi.fn(() => {
    if (!deferSuspend) {
      state = "suspended";
      events.dispatchEvent(new Event("statechange"));
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      finishSuspend = () => {
        state = "suspended";
        events.dispatchEvent(new Event("statechange"));
        resolve();
      };
    });
  });
  const context = {
    addEventListener: events.addEventListener.bind(events),
    close: vi.fn(async () => {
      state = "closed";
      events.dispatchEvent(new Event("statechange"));
    }),
    createGain: vi.fn(() => ({ ...makeNode(), gain }) as unknown as GainNode),
    createOscillator: vi.fn(() => {
      const node = makeNode();
      return {
        ...node,
        addEventListener: vi.fn(),
        frequency: {
          exponentialRampToValueAtTime: vi.fn(),
          setValueAtTime: vi.fn(),
        },
        start: vi.fn(),
        stop: vi.fn(),
        type: "sine",
      } as unknown as OscillatorNode;
    }),
    createWaveShaper: vi.fn(
      () =>
        ({
          ...makeNode(),
          curve: null,
          oversample: "none",
        }) as unknown as WaveShaperNode,
    ),
    currentTime: 0,
    destination: {} as AudioDestinationNode,
    removeEventListener: events.removeEventListener.bind(events),
    resume,
    get state() {
      return state;
    },
    suspend,
  } as unknown as AudioContext;

  return {
    context,
    currentState() {
      return state;
    },
    finishPendingResume() {
      finishResume?.();
    },
    finishPendingSuspend() {
      finishSuspend?.();
    },
    resume,
    setState(next: AudioContextState) {
      state = next;
      events.dispatchEvent(new Event("statechange"));
    },
    suspend,
  };
}
