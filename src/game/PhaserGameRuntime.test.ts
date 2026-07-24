import { describe, expect, it, vi } from "vitest";

import { ManualClock, ScriptedInputSource, type GameEvent, type InputSource } from "../core";
import { PhaserGameRuntime, type PhaserMountFactory } from "./PhaserGameRuntime";
import { FIXED_STEP_MS } from "./simulation";

class LifecycleInput implements InputSource {
  startCount = 0;
  stopCount = 0;

  async start() {
    this.startCount += 1;
  }

  latest() {
    return { atMs: 0, jumpPressed: false, lift: 0 };
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
      runtime.advanceFrame(FIXED_STEP_MS);
      expect(runtime.snapshot().tick).toBe(1);

      runtime.restart();
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
        eventListeners: 1,
        hasPhaserGame: true,
      });

      runtime.destroy();
      runtime.destroy();

      expect(runtime.diagnostics()).toEqual({
        state: "destroyed",
        activeBodies: 0,
        activeTimers: 0,
        eventListeners: 0,
        hasPhaserGame: false,
      });
      expect(input.startCount).toBe(1);
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
    await runtime.mount(document.createElement("div"));
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

    runtime.restart();
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
