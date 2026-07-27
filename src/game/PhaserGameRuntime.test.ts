import { describe, expect, it, vi } from "vitest";

import {
  ManualClock,
  ScriptedInputSource,
  type GameEvent,
  type InputFeedback,
  type InputSource,
} from "../core";
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
      expect(runtime.diagnostics()).toEqual({
        state: "mounted",
        activeBodies: 1,
        activeTimers: 0,
        collisionZones: 9,
        pooledObjects: 42,
        sceneObjects: 0,
        inputListeners: 0,
        eventListeners: 1,
        hasPhaserGame: true,
        failedRun: null,
      });

      runtime.destroy();
      runtime.destroy();

      expect(runtime.diagnostics()).toEqual({
        state: "destroyed",
        activeBodies: 0,
        activeTimers: 0,
        collisionZones: 0,
        pooledObjects: 0,
        sceneObjects: 0,
        inputListeners: 0,
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
        seed: RUN_OPTIONS.seed,
        gameplayVersion: RUN_OPTIONS.gameplayVersion,
        score: runtime.snapshot().score,
        survivalMs: runtime.snapshot().elapsedMs,
        distance: runtime.snapshot().distance,
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

    let stableDiagnostics: ReturnType<typeof runtime.diagnostics> | null = null;

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

      const diagnostics = runtime.diagnostics();
      stableDiagnostics ??= diagnostics;
      expect(diagnostics).toEqual(stableDiagnostics);

      for (let tick = 0; tick < 600 && runtime.snapshot().phase === "running"; tick += 1) {
        runtime.advanceFrame(FIXED_STEP_MS);
      }

      const ended = runtime.snapshot();
      expect(ended.phase).toBe("dead");
      expect(ended.deathReason).toBe("water");
      expect(events.filter((event) => event.type === "ended")).toHaveLength(run + 1);
      expect(container.dataset.score).toBe(String(ended.score));
      expect(container.dataset.elapsedMs).toBe(String(ended.elapsedMs));
      expect(container.dataset.pooledObjects).toBe("42");

      for (let frozenFrame = 0; frozenFrame < 10; frozenFrame += 1) {
        runtime.advanceFrame(FIXED_STEP_MS);
      }
      expect(runtime.snapshot()).toEqual(ended);
      expect(events.filter((event) => event.type === "ended")).toHaveLength(run + 1);
    }

    expect(input.resetCount).toBe(20);
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
          seed: RUN_OPTIONS.seed,
          gameplayVersion: RUN_OPTIONS.gameplayVersion,
          score: frozen.score,
          survivalMs: frozen.elapsedMs,
          distance: frozen.distance,
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
});
