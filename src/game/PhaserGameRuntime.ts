import {
  GameEventHub,
  SystemClock,
  type Clock,
  type GameEventListener,
  type GameRuntime,
  type InputSource,
  type ControlIntent,
  type RunOptions,
} from "../core";
import { FixedStepRunner } from "./FixedStepRunner";
import { ChickenSimulation, FIXED_STEP_MS, type SimulationSnapshot } from "./simulation";

export type PhaserFrameHost = {
  onSceneReady(): void;
  advanceFrame(deltaMs: number): SimulationSnapshot;
  snapshot(): SimulationSnapshot;
};

export type PhaserGameHandle = {
  destroy(removeCanvas: boolean): void;
};

export type PhaserMountResult = {
  game: PhaserGameHandle;
  ready: Promise<void>;
};

export type PhaserMountFactory = (options: {
  parent: HTMLElement;
  renderResolution: number;
  host: PhaserFrameHost;
}) => PhaserMountResult;

export type InputSourceFactory = (parent: HTMLElement) => InputSource;

export type RuntimeDiagnostics = {
  state: "idle" | "mounting" | "mounted" | "destroyed";
  activeBodies: number;
  activeTimers: number;
  eventListeners: number;
  hasPhaserGame: boolean;
};

type PhaserGameRuntimeOptions = {
  phaserFactory: PhaserMountFactory;
  inputSourceFactory: InputSourceFactory;
  renderResolution: number;
  clock?: Clock;
};

type SimulationTimedInputSource = InputSource & {
  sampleAt(elapsedMs: number): ControlIntent;
  resetSimulationTime?: () => void;
};

function supportsSimulationTime(input: InputSource): input is SimulationTimedInputSource {
  return "sampleAt" in input && typeof input.sampleAt === "function";
}

export class PhaserGameRuntime implements GameRuntime, PhaserFrameHost {
  private readonly simulation = new ChickenSimulation();
  private readonly runner = new FixedStepRunner(this.simulation);
  private readonly events: GameEventHub;
  private readonly resolveDestroyed: () => void;
  private readonly destroyedPromise: Promise<void>;

  private stateValue: RuntimeDiagnostics["state"] = "idle";
  private input: InputSource | null = null;
  private game: PhaserGameHandle | null = null;
  private container: HTMLElement | null = null;
  private lastRunOptions: RunOptions | null = null;
  private endedEventSent = false;

  constructor(private readonly options: PhaserGameRuntimeOptions) {
    if (
      !Number.isFinite(options.renderResolution) ||
      options.renderResolution < 1 ||
      options.renderResolution > 2
    ) {
      throw new RangeError("Render resolution must be between 1 and 2");
    }

    this.events = new GameEventHub(options.clock ?? new SystemClock());

    let resolveDestroyed: () => void = () => {};
    this.destroyedPromise = new Promise<void>((resolve) => {
      resolveDestroyed = () => resolve();
    });
    this.resolveDestroyed = resolveDestroyed;
  }

  async mount(container: HTMLElement) {
    if (this.stateValue !== "idle") {
      throw new Error("A game runtime can only be mounted once");
    }

    this.stateValue = "mounting";
    this.container = container;
    this.updateContainerState();

    let mountingInput: InputSource | null = null;

    try {
      mountingInput = this.options.inputSourceFactory(container);
      this.input = mountingInput;
      await mountingInput.start();

      if (this.isDestroyed()) {
        mountingInput.stop();
        return;
      }

      const mounted = this.options.phaserFactory({
        parent: container,
        renderResolution: this.options.renderResolution,
        host: this,
      });

      this.game = mounted.game;
      await Promise.race([mounted.ready, this.destroyedPromise]);

      if (this.isDestroyed()) {
        return;
      }

      this.stateValue = "mounted";
      this.updateContainerState();
    } catch (cause) {
      mountingInput?.stop();
      this.input = null;
      this.game?.destroy(true);
      this.game = null;

      if (!this.isDestroyed()) {
        this.stateValue = "idle";
        this.events.emit({
          type: "fatal-error",
          error: {
            code: "render-failed",
            message: "The game world could not be mounted",
            recoverable: true,
            cause,
          },
        });
        this.updateContainerState();
      }

      throw cause;
    }
  }

  startRun(options: RunOptions) {
    this.assertMounted();
    this.lastRunOptions = { ...options };
    this.endedEventSent = false;
    this.runner.reset();

    if (this.input && supportsSimulationTime(this.input)) {
      this.input.resetSimulationTime?.();
    }

    this.simulation.reset();
    this.simulation.start();
    this.updateContainerState();
  }

  pause() {
    if (this.stateValue !== "mounted") {
      return;
    }

    this.simulation.pause();
    this.runner.reset();
    this.updateContainerState();
  }

  resume() {
    if (this.stateValue !== "mounted") {
      return;
    }

    this.simulation.resume();
    this.runner.reset();
    this.updateContainerState();
  }

  restart() {
    this.assertMounted();

    if (!this.lastRunOptions) {
      throw new Error("A run must be started before it can be restarted");
    }

    this.startRun(this.lastRunOptions);
  }

  destroy() {
    if (this.stateValue === "destroyed") {
      return;
    }

    this.stateValue = "destroyed";
    this.resolveDestroyed();
    this.input?.stop();
    this.input = null;
    this.game?.destroy(true);
    this.game = null;
    this.runner.reset();
    this.simulation.destroy();
    this.events.clear();
    this.updateContainerState();
    this.container = null;
  }

  subscribe(listener: GameEventListener) {
    if (this.stateValue === "destroyed") {
      return () => undefined;
    }

    return this.events.subscribe(listener);
  }

  onSceneReady() {
    this.updateContainerState();
  }

  advanceFrame(deltaMs: number) {
    if (this.stateValue !== "mounted") {
      return this.simulation.snapshot();
    }

    const input = this.input;
    const before = this.simulation.snapshot();

    if (before.phase === "dead" && input?.latest().jumpPressed) {
      this.restart();
    } else if (input) {
      this.runner.advance(deltaMs, () => this.readFixedStepIntent(input));
    }

    const after = this.simulation.snapshot();

    this.events.publishSnapshot({
      phase: after.phase === "dead" ? "game-over" : after.phase,
      elapsedMs: after.elapsedMs,
      score: Math.floor(after.distance),
      distance: after.distance,
      normalizedInput: 0,
    });

    if (after.phase === "dead" && !this.endedEventSent && this.lastRunOptions) {
      this.endedEventSent = true;
      this.events.emit({
        type: "ended",
        value: {
          seed: this.lastRunOptions.seed,
          gameplayVersion: this.lastRunOptions.gameplayVersion,
          score: Math.floor(after.distance),
          survivalMs: after.elapsedMs,
          distance: after.distance,
          reason: "water",
        },
      });
    }

    if (before.phase !== after.phase) {
      this.updateContainerState();
    }

    return after;
  }

  snapshot() {
    return this.simulation.snapshot();
  }

  diagnostics(): RuntimeDiagnostics {
    const simulation = this.simulation.diagnostics();

    return {
      state: this.stateValue,
      activeBodies: simulation.activeBodies,
      activeTimers: simulation.activeTimers,
      eventListeners: this.events.listenerCount(),
      hasPhaserGame: this.game !== null,
    };
  }

  private assertMounted() {
    if (this.stateValue !== "mounted") {
      throw new Error("The game runtime must be mounted first");
    }
  }

  private isDestroyed() {
    return this.stateValue === "destroyed";
  }

  private readFixedStepIntent(input: InputSource) {
    if (supportsSimulationTime(input)) {
      return input.sampleAt(this.simulation.snapshot().elapsedMs + FIXED_STEP_MS);
    }

    return input.latest();
  }

  private updateContainerState() {
    if (!this.container) {
      return;
    }

    const diagnostics = this.diagnostics();
    const snapshot = this.simulation.snapshot();

    this.container.dataset.runtimeState = diagnostics.state;
    this.container.dataset.simulationPhase = snapshot.phase;
    this.container.dataset.logicalWidth = "432";
    this.container.dataset.logicalHeight = "768";
    this.container.dataset.renderResolution = String(this.options.renderResolution);
    this.container.dataset.activeBodies = String(diagnostics.activeBodies);
  }
}
