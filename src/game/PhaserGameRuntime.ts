import {
  GameEventHub,
  SystemClock,
  type Clock,
  type ControlMode,
  type GameEventListener,
  type GameRuntime,
  type InputProvenance,
  type InputSource,
  type ControlIntent,
  type RunOptions,
} from "../core";
import { FixedStepRunner } from "./FixedStepRunner";
import { DEFAULT_PLAYER_CONTROLLER_TUNING } from "./FixedStepPlayerController";
import { GeneratedChunkCourse, type GeneratedCourseSnapshot } from "./GeneratedChunkCourse";
import { ChickenSimulation, FIXED_STEP_MS, type SimulationSnapshot } from "./simulation";

export type PhaserFrameHost = {
  onSceneReady(): void;
  advanceFrame(deltaMs: number): SimulationSnapshot;
  snapshot(): SimulationSnapshot;
  courseSnapshot(): GeneratedCourseSnapshot | null;
  hudSnapshot(): {
    activeInput: InputProvenance;
    configuredInput: ControlMode;
    normalizedInput: number;
  };
};

export type PhaserGameHandle = {
  destroy(removeCanvas: boolean): void;
  diagnostics?(): {
    sceneObjects: number;
    activeTimers: number;
    pooledObjects: number;
  };
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
  collisionZones: number;
  pooledObjects: number;
  sceneObjects: number;
  inputListeners: number;
  eventListeners: number;
  hasPhaserGame: boolean;
  failedRun: FailedRunDiagnostic | null;
};

export type FailedRunDiagnostic = Readonly<{
  seed: string;
  gameplayVersion: string;
}>;

type PhaserGameRuntimeOptions = {
  phaserFactory: PhaserMountFactory;
  inputSourceFactory: InputSourceFactory;
  renderResolution: number;
  clock?: Clock;
  generatedCourse?: GeneratedChunkCourse | null;
};

type SimulationTimedInputSource = InputSource & {
  sampleAt(elapsedMs: number): ControlIntent;
  resetSimulationTime?: () => void;
};

function supportsSimulationTime(input: InputSource): input is SimulationTimedInputSource {
  return "sampleAt" in input && typeof input.sampleAt === "function";
}

export class PhaserGameRuntime implements GameRuntime, PhaserFrameHost {
  private readonly generatedCourse: GeneratedChunkCourse | null;
  private readonly simulation: ChickenSimulation;
  private readonly runner: FixedStepRunner;
  private readonly events: GameEventHub;
  private readonly resolveDestroyed: () => void;
  private readonly destroyedPromise: Promise<void>;

  private stateValue: RuntimeDiagnostics["state"] = "idle";
  private input: InputSource | null = null;
  private game: PhaserGameHandle | null = null;
  private container: HTMLElement | null = null;
  private lastRunOptions: RunOptions | null = null;
  private endedEventSent = false;
  private activeInput: InputProvenance = "none";
  private configuredInput: ControlMode = "keyboard-touch";
  private normalizedInput = 0;
  private appliedLift = 0;
  private runGeneration = 0;
  private failedRun: FailedRunDiagnostic | null = null;

  constructor(private readonly options: PhaserGameRuntimeOptions) {
    if (
      !Number.isFinite(options.renderResolution) ||
      options.renderResolution < 1 ||
      options.renderResolution > 2
    ) {
      throw new RangeError("Render resolution must be between 1 and 2");
    }

    this.generatedCourse =
      options.generatedCourse === undefined ? new GeneratedChunkCourse() : options.generatedCourse;
    this.simulation = new ChickenSimulation(
      this.generatedCourse ? { generatedCourse: this.generatedCourse } : {},
    );
    this.runner = new FixedStepRunner(this.simulation);
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
    this.generatedCourse?.reset(options.seed, options.gameplayVersion);
    this.lastRunOptions = { ...options };
    this.endedEventSent = false;
    this.failedRun = null;
    this.runGeneration += 1;
    this.runner.reset();
    this.events.resetRunState();
    this.input?.resetRunState?.();

    if (this.input && supportsSimulationTime(this.input)) {
      this.input.resetSimulationTime?.();
    }

    this.simulation.reset();
    this.simulation.start();
    this.activeInput = "none";
    this.normalizedInput = 0;
    this.appliedLift = 0;
    this.updateContainerState();
  }

  setActiveInput(mode: ControlMode) {
    this.configuredInput = mode;
    this.activeInput = "none";
    this.normalizedInput = 0;
    this.appliedLift = 0;
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
    this.failedRun = null;
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

    if (before.phase !== "dead" && input) {
      this.runner.advance(deltaMs, () => this.readFixedStepIntent(input));
    }

    const after = this.simulation.snapshot();

    const snapshotPublished = this.events.publishSnapshot({
      phase: after.phase === "dead" ? "game-over" : after.phase,
      elapsedMs: after.elapsedMs,
      score: after.score,
      distance: after.distance,
      normalizedInput: this.normalizedInput,
    });

    if (after.phase === "dead" && !this.endedEventSent && this.lastRunOptions) {
      this.endedEventSent = true;
      this.failedRun = Object.freeze({
        seed: this.lastRunOptions.seed,
        gameplayVersion: this.lastRunOptions.gameplayVersion,
      });
      this.events.emit({
        type: "ended",
        value: {
          seed: this.lastRunOptions.seed,
          gameplayVersion: this.lastRunOptions.gameplayVersion,
          score: after.score,
          survivalMs: after.elapsedMs,
          distance: after.distance,
          reason: after.deathReason ?? "fall",
        },
      });
    }

    if (snapshotPublished || before.phase !== after.phase || before.score !== after.score) {
      this.updateContainerState();
    }

    return after;
  }

  snapshot() {
    return this.simulation.snapshot();
  }

  courseSnapshot() {
    return this.generatedCourse?.snapshot() ?? null;
  }

  hudSnapshot() {
    return {
      activeInput: this.activeInput,
      configuredInput: this.configuredInput,
      normalizedInput: this.normalizedInput,
    };
  }

  diagnostics(): RuntimeDiagnostics {
    const simulation = this.simulation.diagnostics();
    const scene = this.game?.diagnostics?.();

    return {
      state: this.stateValue,
      activeBodies: simulation.activeBodies,
      activeTimers: simulation.activeTimers + (scene?.activeTimers ?? 0),
      collisionZones: simulation.collisionZones,
      pooledObjects: scene?.pooledObjects ?? simulation.pooledObjects,
      sceneObjects: scene?.sceneObjects ?? 0,
      inputListeners: this.input?.diagnostics?.().activeListeners ?? 0,
      eventListeners: this.events.listenerCount(),
      hasPhaserGame: this.game !== null,
      failedRun: this.failedRun ? { ...this.failedRun } : null,
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
    let intent: ControlIntent;

    if (supportsSimulationTime(input)) {
      intent = input.sampleAt(this.simulation.snapshot().elapsedMs + FIXED_STEP_MS);
    } else {
      intent = input.latest();
    }

    const feedback = input.getFeedback?.();
    const fallbackLevel = Math.max(intent.lift, intent.jumpPressed ? 1 : 0);
    this.appliedLift = clampInputLevel(intent.lift);
    this.normalizedInput = clampInputLevel(feedback?.normalizedLevel ?? fallbackLevel);
    this.activeInput =
      feedback?.provenance ??
      (this.normalizedInput > 0 ? this.configuredInput : ("none" satisfies InputProvenance));
    return intent;
  }

  private updateContainerState() {
    if (!this.container) {
      return;
    }

    const diagnostics = this.diagnostics();
    const snapshot = this.simulation.snapshot();

    this.container.dataset.runtimeState = diagnostics.state;
    this.container.dataset.runGeneration = String(this.runGeneration);
    this.container.dataset.simulationPhase = snapshot.phase;
    this.container.dataset.logicalWidth = "432";
    this.container.dataset.logicalHeight = "768";
    this.container.dataset.renderResolution = String(this.options.renderResolution);
    this.container.dataset.activeBodies = String(diagnostics.activeBodies);
    this.container.dataset.activeTimers = String(diagnostics.activeTimers);
    this.container.dataset.collisionZones = String(diagnostics.collisionZones);
    this.container.dataset.pooledObjects = String(diagnostics.pooledObjects);
    this.container.dataset.sceneObjects = String(diagnostics.sceneObjects);
    this.container.dataset.inputListeners = String(diagnostics.inputListeners);
    this.container.dataset.activeInput = this.activeInput;
    this.container.dataset.configuredInput = this.configuredInput;
    this.container.dataset.inputLevel = this.normalizedInput.toFixed(3);
    this.container.dataset.appliedLift = this.appliedLift.toFixed(3);
    this.container.dataset.controlAccelerationY = (
      DEFAULT_PLAYER_CONTROLLER_TUNING.gravityPerSecond -
      this.appliedLift * DEFAULT_PLAYER_CONTROLLER_TUNING.liftAccelerationPerSecond
    ).toFixed(3);
    this.container.dataset.playerY = snapshot.chicken.y.toFixed(3);
    this.container.dataset.playerVelocityY = snapshot.chicken.velocityY.toFixed(3);
    this.container.dataset.playerGrounded = snapshot.chicken.grounded ? "true" : "false";
    this.container.dataset.playerAnimation = snapshot.chicken.animation;
    this.container.dataset.supportingPlatform = snapshot.chicken.supportingPlatformId ?? "";
    this.container.dataset.score = String(snapshot.score);
    this.container.dataset.elapsedMs = String(snapshot.elapsedMs);
    this.container.dataset.courseDistance = String(snapshot.courseDistance);
    this.container.dataset.loopsCompleted = String(snapshot.loopsCompleted);
    this.container.dataset.currentChunkIndex = String(snapshot.currentChunkIndex);
    this.container.dataset.currentChunkId = snapshot.currentChunkId ?? "";
    this.container.dataset.deathReason = snapshot.deathReason ?? "";
    this.container.dataset.collisionId = snapshot.collisionId ?? "";

    if (diagnostics.failedRun) {
      this.container.dataset.failedRunSeed = diagnostics.failedRun.seed;
      this.container.dataset.failedRunGameplayVersion = diagnostics.failedRun.gameplayVersion;
    } else {
      delete this.container.dataset.failedRunSeed;
      delete this.container.dataset.failedRunGameplayVersion;
    }
  }
}

function clampInputLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}
