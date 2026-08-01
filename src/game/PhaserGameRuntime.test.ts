import { describe, expect, it, vi } from "vitest";

import {
  ManualClock,
  ScriptedInputSource,
  type GameEvent,
  type InputFeedback,
  type InputSource,
} from "../core";
import { AUTHORED_CHUNK_TEMPLATES } from "../content";
import { GeneratedChunkCourse } from "./GeneratedChunkCourse";
import { PhaserGameRuntime, type PhaserMountFactory } from "./PhaserGameRuntime";
import { FIXED_STEP_MS } from "./simulation";
import {
  AUTHORED_COURSE_TRACES,
  toScriptedControlFrames,
  type AuthoredCourseTrace,
} from "./testing/courseTraces";

class LifecycleInput implements InputSource {
  startCount = 0;
  stopCount = 0;
  resetCount = 0;

  async start() {
    this.startCount += 1;
  }

  latest() {
    return { atMs: 0, jumpPressed: false, lift: 0 };
  }

  resetRunState() {
    this.resetCount += 1;
  }

  stop() {
    this.stopCount += 1;
  }
}

const RUN_OPTIONS = {
  seed: "runtime-test",
  calibration: null,
  gameplayVersion: "test",
} as const;

describe("PhaserGameRuntime", () => {
  it("repeatedly mounts, runs, restarts, and destroys without leaks", async () => {
    const destroyCalls: boolean[] = [];
    const phaserFactory: PhaserMountFactory = ({ host }) => {
      host.onSceneReady();
      return {
        game: {
          destroy(removeCanvas) {
            destroyCalls.push(removeCanvas);
          },
        },
        ready: Promise.resolve(),
      };
    };

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const input = new LifecycleInput();
      const runtime = new PhaserGameRuntime({
        phaserFactory,
        inputSourceFactory: () => input,
        renderResolution: 2,
        clock: new ManualClock(),
      });
      const container = document.createElement("div");
      runtime.subscribe(vi.fn());

      await runtime.mount(container);
      runtime.startRun(RUN_OPTIONS);
      expect(container.dataset.runGeneration).toBe("1");
      runtime.advanceFrame(FIXED_STEP_MS);
      expect(runtime.snapshot().tick).toBe(1);

      runtime.restart();
      expect(container.dataset.runGeneration).toBe("2");
      expect(runtime.snapshot()).toMatchObject({
        phase: "running",
        tick: 0,
        distance: 0,
        landingCount: 0,
      });
      expect(runtime.diagnostics()).toMatchObject({
        state: "mounted",
        activeBodies: 1,
        activeParticles: 0,
        activeTimers: 0,
        artAtlasFrames: 0,
        artAtlasSource: "unmounted",
        audioCueCount: 0,
        audioState: "idle",
        chickenArtFrame: "",
        collisionZones: 9,
        pooledObjects: 72,
        sceneObjects: 0,
        renderedWarnings: 0,
        renderedQuietZones: 0,
        renderedCollectibles: 0,
        renderedMovingHazards: 0,
        inputListeners: 0,
        invalidVisibleArtObjects: 0,
        lastAudioCue: null,
        eventListeners: 1,
        hasPhaserGame: true,
        failedRun: null,
      });

      runtime.destroy();
      runtime.destroy();

      expect(runtime.diagnostics()).toMatchObject({
        state: "destroyed",
        activeBodies: 0,
        activeParticles: 0,
        activeTimers: 0,
        artAtlasFrames: 0,
        artAtlasSource: "unmounted",
        audioCueCount: 0,
        audioState: "idle",
        chickenArtFrame: "",
        collisionZones: 0,
        pooledObjects: 0,
        sceneObjects: 0,
        renderedWarnings: 0,
        renderedQuietZones: 0,
        renderedCollectibles: 0,
        renderedMovingHazards: 0,
        inputListeners: 0,
        invalidVisibleArtObjects: 0,
        lastAudioCue: null,
        eventListeners: 0,
        hasPhaserGame: false,
        failedRun: null,
      });
      expect(input.startCount).toBe(1);
      expect(input.resetCount).toBe(2);
      expect(input.stopCount).toBe(1);
      expect(container.dataset.activeBodies).toBe("0");
    }

    expect(destroyCalls).toEqual([true, true, true, true, true]);
  });

  it("pauses deterministically and rejects a second mount", async () => {
    const runtime = new PhaserGameRuntime({
      phaserFactory: () => ({
        game: { destroy: vi.fn() },
        ready: Promise.resolve(),
      }),
      inputSourceFactory: () => new LifecycleInput(),
      renderResolution: 1,
      clock: new ManualClock(),
    });
    const container = document.createElement("div");

    await runtime.mount(container);
    await expect(runtime.mount(container)).rejects.toThrow("only be mounted once");
    runtime.startRun(RUN_OPTIONS);
    runtime.advanceFrame(FIXED_STEP_MS);
    runtime.pause();
    const paused = runtime.snapshot();
    runtime.advanceFrame(FIXED_STEP_MS * 5);

    expect(runtime.snapshot()).toEqual(paused);
    expect(container.dataset.simulationPhase).toBe("paused");

    runtime.resume();
    runtime.advanceFrame(FIXED_STEP_MS);
    expect(runtime.snapshot().tick).toBe(2);
    runtime.destroy();
  });

  it("forwards physical audio lifecycle calls only while mounted", async () => {
    const suspendGameAudioForBackground = vi.fn(async () => undefined);
    const resumeGameAudioFromGesture = vi.fn(async () => true);
    const runtime = new PhaserGameRuntime({
      phaserFactory: () => ({
        game: {
          destroy: vi.fn(),
          resumeGameAudioFromGesture,
          suspendGameAudioForBackground,
        },
        ready: Promise.resolve(),
      }),
      inputSourceFactory: () => new LifecycleInput(),
      renderResolution: 1,
      clock: new ManualClock(),
    });

    expect(await runtime.resumeGameAudioFromGesture()).toBe(false);
    await runtime.mount(document.createElement("div"));
    expect(await runtime.resumeGameAudioFromGesture()).toBe(true);
    await runtime.suspendGameAudioForBackground();
    expect(resumeGameAudioFromGesture).toHaveBeenCalledOnce();
    expect(suspendGameAudioForBackground).toHaveBeenCalledOnce();

    runtime.destroy();
    expect(await runtime.resumeGameAudioFromGesture()).toBe(false);
  });

  it("publishes coarse, privacy-safe local performance diagnostics", async () => {
    const clock = new ManualClock(100);
    let jumpPending = true;
    let inputLatencyPending = true;
    const input: InputSource = {
      async start() {},
      consumeInputLatencySamples() {
        if (!inputLatencyPending) {
          return [];
        }
        inputLatencyPending = false;
        return [{ latencyMs: 60, provenance: "voice" as const }];
      },
      latest() {
        if (jumpPending) {
          jumpPending = false;
          return { atMs: 40, jumpPressed: true, lift: 1 };
        }
        return { atMs: clock.now(), jumpPressed: false, lift: 0 };
      },
      stop() {},
    };
    const runtime = new PhaserGameRuntime({
      phaserFactory: () => ({
        game: {
          destroy: vi.fn(),
          diagnostics: () => ({
            activeTimers: 0,
            pooledObjects: 72,
            renderer: "webgl" as const,
            sceneObjects: 86,
          }),
        },
        ready: Promise.resolve(),
      }),
      inputSourceFactory: () => input,
      renderResolution: 1,
      clock,
    });
    const container = document.createElement("div");

    await runtime.mount(container);
    runtime.startRun(RUN_OPTIONS);
    runtime.advanceFrame(FIXED_STEP_MS, 18);
    const diagnostics = runtime.localDiagnostics();

    expect(diagnostics).toMatchObject({
      schemaVersion: 1,
      run: {
        gameplayVersion: RUN_OPTIONS.gameplayVersion,
        seed: RUN_OPTIONS.seed,
      },
      renderer: "webgl",
      performance: {
        frameBudgetMet: true,
        frameP95Ms: 18,
        frameSamples: 1,
        inputBudgetMet: true,
        inputSamples: 1,
        inputToIntentP95Ms: 60,
        voiceInputBudgetMet: true,
        voiceInputSamples: 1,
        voiceInputToIntentP95Ms: 60,
      },
      resources: {
        activeBodies: 1,
        sceneObjects: 86,
      },
    });
    expect(container.dataset.localDiagnostics).toBe(JSON.stringify(diagnostics));
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /dbfs|deviceId|normalizedInput|normalizedLevel|peak|raw|rms/i,
    );
    runtime.resetLocalPerformanceDiagnostics();
    expect(runtime.localDiagnostics().performance).toMatchObject({
      frameSamples: 0,
      inputSamples: 0,
      voiceInputSamples: 0,
    });
    runtime.destroy();
  });

  it("uses run seed and gameplay version to drive the live generated course", async () => {
    const runtime = new PhaserGameRuntime({
      phaserFactory: () => ({
        game: { destroy: vi.fn() },
        ready: Promise.resolve(),
      }),
      inputSourceFactory: () => new LifecycleInput(),
      renderResolution: 1,
      clock: new ManualClock(),
    });
    await runtime.mount(document.createElement("div"));

    runtime.startRun({
      ...RUN_OPTIONS,
      seed: "course-a",
      gameplayVersion: "generated-v1",
    });
    const first = runtime.courseSnapshot()!.chunks.map((chunk) => chunk.templateId);

    runtime.startRun({
      ...RUN_OPTIONS,
      seed: "course-b",
      gameplayVersion: "generated-v1",
    });
    const second = runtime.courseSnapshot()!.chunks.map((chunk) => chunk.templateId);
    expect(second).not.toEqual(first);

    runtime.restart();
    expect(runtime.courseSnapshot()!.chunks.map((chunk) => chunk.templateId)).toEqual(second);
    expect(runtime.snapshot()).toMatchObject({
      currentChunkIndex: 0,
      currentChunkId: second[0],
      phase: "running",
    });
    runtime.destroy();
  });

  it("applies presentation preferences without restarting the run", async () => {
    const runtime = new PhaserGameRuntime({
      phaserFactory: () => ({
        game: { destroy: vi.fn() },
        ready: Promise.resolve(),
      }),
      inputSourceFactory: () => new LifecycleInput(),
      renderResolution: 1,
      clock: new ManualClock(),
    });
    const container = document.createElement("div");
    await runtime.mount(container);
    runtime.startRun(RUN_OPTIONS);
    const generation = container.dataset.runGeneration;

    runtime.setPresentationPreferences({
      muted: true,
      reducedMotion: true,
      screenShakeEnabled: false,
    });

    expect(runtime.presentationSnapshot()).toEqual({
      muted: true,
      reducedMotion: true,
      screenShakeEnabled: false,
    });
    expect(container.dataset).toMatchObject({
      muted: "true",
      reducedMotion: "true",
      screenShakeEnabled: "false",
      runGeneration: generation,
    });
    runtime.destroy();
  });

  it("publishes real normalized input and active-control provenance to the HUD", async () => {
    const clock = new ManualClock();
    let feedback: InputFeedback = {
      normalizedLevel: 0.4,
      provenance: "voice" as const,
    };
    const input: InputSource = {
      async start() {},
      latest() {
        return { atMs: clock.now(), jumpPressed: false, lift: 0.4 };
      },
      getFeedback: () => feedback,
      stop() {},
    };
    const runtime = new PhaserGameRuntime({
      phaserFactory: () => ({
        game: { destroy: vi.fn() },
        ready: Promise.resolve(),
      }),
      inputSourceFactory: () => input,
      renderResolution: 1,
      clock,
    });
    const snapshots: GameEvent[] = [];
    runtime.subscribe((event) => snapshots.push(event));
    const container = document.createElement("div");
    await runtime.mount(container);
    runtime.setActiveInput("voice");
    runtime.startRun(RUN_OPTIONS);
    clock.advance(FIXED_STEP_MS);
    runtime.advanceFrame(FIXED_STEP_MS);

    expect(runtime.hudSnapshot()).toEqual({
      activeInput: "voice",
      configuredInput: "voice",
      normalizedInput: 0.4,
    });
    expect(container.dataset.activeInput).toBe("voice");
    expect(container.dataset.configuredInput).toBe("voice");
    expect(container.dataset.inputLevel).toBe("0.400");
    expect(container.dataset.appliedLift).toBe("0.400");
    expect(container.dataset.controlAccelerationY).toBe("820.000");
    expect(snapshots).toContainEqual({
      type: "snapshot",
      value: expect.objectContaining({ normalizedInput: 0.4 }),
    });

    feedback = {
      normalizedLevel: 1,
      provenance: "keyboard-touch",
    };
    clock.advance(FIXED_STEP_MS);
    runtime.advanceFrame(FIXED_STEP_MS);
    expect(runtime.hudSnapshot()).toEqual({
      activeInput: "keyboard-touch",
      configuredInput: "voice",
      normalizedInput: 1,
    });
    runtime.destroy();
  });

  it("can be destroyed while a scene is still booting", async () => {
    const input = new LifecycleInput();
    const destroy = vi.fn();
    const runtime = new PhaserGameRuntime({
      phaserFactory: () => ({
        game: { destroy },
        ready: new Promise(() => undefined),
      }),
      inputSourceFactory: () => input,
      renderResolution: 1,
    });

    const mounting = runtime.mount(document.createElement("div"));
    await Promise.resolve();
    runtime.destroy();
    await mounting;

    expect(input.stopCount).toBe(1);
    expect(destroy).toHaveBeenCalledWith(true);
    expect(runtime.diagnostics().state).toBe("destroyed");
  });

  it("stops an input again if it finishes starting after runtime destruction", async () => {
    let releaseInput = () => {};
    let inputActive = false;
    let stopCount = 0;
    const phaserFactory = vi.fn<PhaserMountFactory>();
    const input: InputSource = {
      async start() {
        await new Promise<void>((resolve) => {
          releaseInput = resolve;
        });
        inputActive = true;
      },
      latest() {
        return { atMs: 0, jumpPressed: false, lift: 0 };
      },
      stop() {
        inputActive = false;
        stopCount += 1;
      },
    };
    const runtime = new PhaserGameRuntime({
      phaserFactory,
      inputSourceFactory: () => input,
      renderResolution: 1,
    });

    const mounting = runtime.mount(document.createElement("div"));
    await Promise.resolve();
    runtime.destroy();
    releaseInput();
    await mounting;

    expect(inputActive).toBe(false);
    expect(stopCount).toBe(2);
    expect(phaserFactory).not.toHaveBeenCalled();
  });

  it("destroys an assigned Phaser game when scene readiness rejects", async () => {
    const input = new LifecycleInput();
    const destroy = vi.fn();
    const runtime = new PhaserGameRuntime({
      phaserFactory: () => ({
        game: { destroy },
        ready: Promise.reject(new Error("scene failed")),
      }),
      inputSourceFactory: () => input,
      renderResolution: 1,
    });

    await expect(runtime.mount(document.createElement("div"))).rejects.toThrow("scene failed");

    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith(true);
    expect(input.stopCount).toBe(1);
    expect(runtime.diagnostics()).toMatchObject({
      state: "idle",
      hasPhaserGame: false,
    });
  });

  it("fully resets after deterministic water death", async () => {
    const runtime = new PhaserGameRuntime({
      phaserFactory: () => ({
        game: { destroy: vi.fn() },
        ready: Promise.resolve(),
      }),
      inputSourceFactory: () => new LifecycleInput(),
      renderResolution: 1,
      clock: new ManualClock(),
      generatedCourse: null,
    });
    const events: GameEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    const container = document.createElement("div");
    await runtime.mount(container);
    runtime.startRun(RUN_OPTIONS);

    for (let frame = 0; frame < 600 && runtime.snapshot().phase !== "dead"; frame += 1) {
      runtime.advanceFrame(FIXED_STEP_MS);
    }

    expect(runtime.snapshot()).toMatchObject({
      phase: "dead",
      deathReason: "water",
      chicken: { animation: "death" },
    });
    expect(events.filter((event) => event.type === "ended")).toHaveLength(1);
    expect(runtime.diagnostics().failedRun).toEqual({
      seed: RUN_OPTIONS.seed,
      gameplayVersion: RUN_OPTIONS.gameplayVersion,
    });
    expect(Object.keys(runtime.diagnostics().failedRun!).sort()).toEqual([
      "gameplayVersion",
      "seed",
    ]);
    expect(container.dataset.failedRunSeed).toBe(RUN_OPTIONS.seed);
    expect(container.dataset.failedRunGameplayVersion).toBe(RUN_OPTIONS.gameplayVersion);
    const ended = events.find((event) => event.type === "ended");
    expect(ended).toEqual({
      type: "ended",
      value: {
        runId: 1,
        seed: RUN_OPTIONS.seed,
        gameplayVersion: RUN_OPTIONS.gameplayVersion,
        score: runtime.snapshot().score,
        scoreBreakdown: runtime.snapshot().scoreBreakdown,
        survivalMs: runtime.snapshot().elapsedMs,
        distance: runtime.snapshot().distance,
        statistics: runtime.snapshot().statistics,
        reason: "water",
      },
    });

    runtime.restart();
    expect(runtime.diagnostics().failedRun).toBeNull();
    expect(container.dataset.failedRunSeed).toBeUndefined();
    expect(container.dataset.failedRunGameplayVersion).toBeUndefined();
    expect(container.dataset.runGeneration).toBe("2");
    expect(runtime.snapshot()).toMatchObject({
      phase: "running",
      tick: 0,
      elapsedMs: 0,
      distance: 0,
      deathReason: null,
      landingCount: 0,
      chicken: {
        grounded: true,
        velocityY: 0,
        animation: "run",
      },
    });
    runtime.destroy();
  });

  it("never restarts a dead run from gameplay input behind semantic results", async () => {
    let jumpPressed = false;
    const input: InputSource = {
      async start() {},
      latest() {
        return { atMs: 0, jumpPressed, lift: jumpPressed ? 1 : 0 };
      },
      stop() {},
    };
    const runtime = new PhaserGameRuntime({
      phaserFactory: () => ({
        game: { destroy: vi.fn() },
        ready: Promise.resolve(),
      }),
      inputSourceFactory: () => input,
      renderResolution: 1,
      clock: new ManualClock(),
    });
    await runtime.mount(document.createElement("div"));
    runtime.startRun(RUN_OPTIONS);
    for (let tick = 0; tick < 600 && runtime.snapshot().phase === "running"; tick += 1) {
      runtime.advanceFrame(FIXED_STEP_MS);
    }
    const ended = runtime.snapshot();
    jumpPressed = true;

    runtime.advanceFrame(FIXED_STEP_MS * 4);

    expect(runtime.snapshot()).toEqual(ended);
    runtime.destroy();
  });

  it("soaks repeated complete runs without growing bodies, listeners, timers, or pools", async () => {
    const input = new LifecycleInput();
    const runtime = new PhaserGameRuntime({
      phaserFactory: () => ({
        game: { destroy: vi.fn() },
        ready: Promise.resolve(),
      }),
      inputSourceFactory: () => input,
      renderResolution: 1,
      clock: new ManualClock(),
    });
    const events: GameEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    const container = document.createElement("div");
    await runtime.mount(container);

    let stableDiagnostics: Omit<ReturnType<typeof runtime.diagnostics>, "performance"> | null =
      null;
    let stableCollisionId: string | null = null;

    for (let run = 0; run < 20; run += 1) {
      if (run === 0) {
        runtime.startRun(RUN_OPTIONS);
      } else {
        runtime.restart();
      }

      expect(runtime.snapshot()).toMatchObject({
        phase: "running",
        tick: 0,
        elapsedMs: 0,
        score: 0,
        distance: 0,
        courseDistance: 0,
        loopsCompleted: 0,
        deathReason: null,
        collisionId: null,
        landingCount: 0,
        chicken: {
          velocityY: 0,
          grounded: true,
          supportingPlatformId: expect.stringMatching(/^0:/),
        },
      });

      const resourceDiagnostics = { ...runtime.diagnostics() };
      delete (resourceDiagnostics as Partial<typeof resourceDiagnostics>).performance;
      stableDiagnostics ??= resourceDiagnostics;
      expect(resourceDiagnostics).toEqual(stableDiagnostics);

      for (let tick = 0; tick < 600 && runtime.snapshot().phase === "running"; tick += 1) {
        runtime.advanceFrame(FIXED_STEP_MS);
      }

      const ended = runtime.snapshot();
      expect(ended.phase).toBe("dead");
      expect(ended.deathReason).toBe("hazard");
      stableCollisionId ??= ended.collisionId;
      expect(ended.collisionId).toBe(stableCollisionId);
      expect(events.filter((event) => event.type === "ended")).toHaveLength(run + 1);
      expect(events.filter((event) => event.type === "hazard-collision")).toHaveLength(run + 1);
      expect(container.dataset.score).toBe(String(ended.score));
      expect(container.dataset.elapsedMs).toBe(String(ended.elapsedMs));
      expect(container.dataset.pooledObjects).toBe("72");

      for (let frozenFrame = 0; frozenFrame < 10; frozenFrame += 1) {
        runtime.advanceFrame(FIXED_STEP_MS);
      }
      expect(runtime.snapshot()).toEqual(ended);
      expect(events.filter((event) => event.type === "ended")).toHaveLength(run + 1);
    }

    expect(input.resetCount).toBe(20);
    runtime.destroy();
  });

  it("publishes a collectible once per run and recollects it after runtime restart", async () => {
    const featherTemplate = AUTHORED_CHUNK_TEMPLATES.find(
      (template) => template.id === "feather-path-intro",
    )!;
    const generatedCourse = new GeneratedChunkCourse({
      templates: [featherTemplate],
      slotCount: 4,
      repeatWindow: 0,
    });
    const clock = new ManualClock();
    const scripted = new ScriptedInputSource(clock, [
      { atMs: 1_800, jumpPressed: true, lift: 0 },
      { atMs: 1_817, jumpPressed: false, lift: 0 },
    ]);
    const runtime = new PhaserGameRuntime({
      phaserFactory: () => ({
        game: { destroy: vi.fn() },
        ready: Promise.resolve(),
      }),
      inputSourceFactory: () => scripted,
      renderResolution: 1,
      clock,
      generatedCourse,
    });
    const events: GameEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    const container = document.createElement("div");
    await runtime.mount(container);

    for (let run = 0; run < 2; run += 1) {
      if (run === 0) {
        runtime.startRun(RUN_OPTIONS);
      } else {
        runtime.restart();
      }

      for (let tick = 0; tick < 240; tick += 1) {
        clock.advance(FIXED_STEP_MS);
        runtime.advanceFrame(FIXED_STEP_MS);
      }

      const collections = events.filter(
        (event) =>
          event.type === "collectible-collected" &&
          event.value.id === "0:feather-path-intro:first-feather",
      );
      expect(collections).toHaveLength(run + 1);
      expect(container.dataset.collectedCollectibles).toBe("1");
    }

    runtime.destroy();
  });

  it.each([
    ["water", AUTHORED_COURSE_TRACES.water, "water"],
    ["fall", AUTHORED_COURSE_TRACES.fall, "fall"],
    ["spike", AUTHORED_COURSE_TRACES.spike, "hazard"],
  ] as const)(
    "emits one frozen runtime summary for the authored %s failure",
    async (_name, traceDefinition: AuthoredCourseTrace, reason) => {
      const clock = new ManualClock();
      const scripted = new ScriptedInputSource(clock, toScriptedControlFrames(traceDefinition));
      const runtime = new PhaserGameRuntime({
        phaserFactory: () => ({
          game: { destroy: vi.fn() },
          ready: Promise.resolve(),
        }),
        inputSourceFactory: () => scripted,
        renderResolution: 1,
        clock,
        generatedCourse: null,
      });
      const events: GameEvent[] = [];
      runtime.subscribe((event) => events.push(event));
      await runtime.mount(document.createElement("div"));
      runtime.startRun(RUN_OPTIONS);

      for (let tick = 0; tick < 1_100 && runtime.snapshot().phase === "running"; tick += 1) {
        clock.advance(FIXED_STEP_MS);
        runtime.advanceFrame(FIXED_STEP_MS);
      }

      const frozen = runtime.snapshot();
      const summaries = events.filter((event) => event.type === "ended");
      expect(frozen).toMatchObject({
        phase: "dead",
        deathReason: reason,
      });
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toEqual({
        type: "ended",
        value: {
          runId: 1,
          seed: RUN_OPTIONS.seed,
          gameplayVersion: RUN_OPTIONS.gameplayVersion,
          score: frozen.score,
          scoreBreakdown: frozen.scoreBreakdown,
          survivalMs: frozen.elapsedMs,
          distance: frozen.distance,
          statistics: frozen.statistics,
          reason,
        },
      });

      for (let tick = 0; tick < 120; tick += 1) {
        clock.advance(FIXED_STEP_MS);
        runtime.advanceFrame(FIXED_STEP_MS);
      }

      expect(runtime.snapshot()).toEqual(frozen);
      expect(events.filter((event) => event.type === "ended")).toHaveLength(1);
      runtime.destroy();
    },
  );

  it("replays short scripted edges identically under coarse and fine render frames", async () => {
    async function run(frameDeltas: readonly number[]) {
      const clock = new ManualClock();
      const scripted = new ScriptedInputSource(clock, [
        { atMs: 90, jumpPressed: true, lift: 0.7 },
        { atMs: 105, jumpPressed: false, lift: 0 },
      ]);
      const runtime = new PhaserGameRuntime({
        phaserFactory: () => ({
          game: { destroy: vi.fn() },
          ready: Promise.resolve(),
        }),
        inputSourceFactory: () => scripted,
        renderResolution: 1,
        clock,
      });

      await runtime.mount(document.createElement("div"));
      runtime.startRun(RUN_OPTIONS);

      for (const frameDelta of frameDeltas) {
        clock.advance(frameDelta);
        runtime.advanceFrame(frameDelta);
      }

      const snapshot = runtime.snapshot();
      runtime.destroy();
      return snapshot;
    }

    const coarse = await run(Array.from({ length: 10 }, () => 100));
    const fine = await run(Array.from({ length: 60 }, () => FIXED_STEP_MS));

    expect(coarse).toEqual(fine);
    expect(coarse.landingCount).toBe(1);
    expect(coarse.tick).toBe(60);
  });

  it("restarts the same instance with deterministic public summaries and complete progression reset", async () => {
    const runtime = new PhaserGameRuntime({
      phaserFactory: () => ({
        game: { destroy: vi.fn() },
        ready: Promise.resolve(),
      }),
      inputSourceFactory: () => new LifecycleInput(),
      renderResolution: 1,
      clock: new ManualClock(),
    });
    const events: GameEvent[] = [];
    const container = document.createElement("div");
    runtime.subscribe((event) => events.push(event));
    await runtime.mount(container);

    const finishRun = () => {
      for (let tick = 0; tick < 1_000 && runtime.snapshot().phase === "running"; tick += 1) {
        runtime.advanceFrame(FIXED_STEP_MS);
      }
      expect(runtime.snapshot().phase).toBe("dead");
      return events.filter((event) => event.type === "ended").at(-1)!.value;
    };

    runtime.startRun(RUN_OPTIONS);
    const initialSnapshot = runtime.snapshot();
    const initialChunks = runtime.courseSnapshot()!.chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      difficulty: chunk.difficulty,
      difficultyStage: chunk.difficultyStage,
      templateId: chunk.templateId,
      worldSpeed: chunk.worldSpeed,
    }));
    const first = finishRun();

    runtime.restart();
    expect(runtime.snapshot()).toEqual(initialSnapshot);
    expect(runtime.snapshot()).toMatchObject({
      phase: "running",
      tick: 0,
      elapsedMs: 0,
      score: 0,
      scoreBreakdown: {
        survival: 0,
        collectibles: 0,
        precision: 0,
        total: 0,
      },
      liftStamina: 1,
      effectiveLift: 0,
      difficultyStage: 1,
      difficulty: 1,
      worldSpeed: 144,
      statistics: {
        distance: 0,
        obstaclesCleared: 0,
        collectibles: 0,
        precisionLandings: 0,
        longestLiftMs: 0,
        highestDifficultyStage: 1,
      },
    });
    expect(container.dataset).toMatchObject({
      survivalScore: "0",
      collectibleScore: "0",
      precisionScore: "0",
      liftStamina: "1.000",
      effectiveLift: "0.000",
      difficultyStage: "1",
      worldSpeed: "144.000",
      obstaclesCleared: "0",
      precisionLandings: "0",
      longestLiftMs: "0",
    });
    expect(
      runtime.courseSnapshot()!.chunks.map((chunk) => ({
        chunkIndex: chunk.chunkIndex,
        difficulty: chunk.difficulty,
        difficultyStage: chunk.difficultyStage,
        templateId: chunk.templateId,
        worldSpeed: chunk.worldSpeed,
      })),
    ).toEqual(initialChunks);

    const second = finishRun();
    const { runId: firstRunId, ...firstPublicResult } = first;
    const { runId: secondRunId, ...secondPublicResult } = second;

    expect([firstRunId, secondRunId]).toEqual([1, 2]);
    expect(secondPublicResult).toEqual(firstPublicResult);
    expect(second.score).toBe(second.scoreBreakdown.total);
    expect(second.statistics.distance).toBe(second.distance);
    expect(second.statistics.obstaclesCleared).toBe(0);
    expect(Object.keys(second.statistics).sort()).toEqual([
      "collectibles",
      "distance",
      "highestDifficultyStage",
      "longestLiftMs",
      "obstaclesCleared",
      "precisionLandings",
    ]);
    runtime.destroy();
  });
});
