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
  type PresentationPreferences,
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
  presentationSnapshot(): PresentationPreferences;
};

export type PhaserGameHandle = {
  destroy(removeCanvas: boolean): void;
  diagnostics?(): {
    sceneObjects: number;
    activeTimers: number;
    pooledObjects: number;
    activeParticles?: number;
    artAtlasFrames?: number;
    artAtlasSource?: string;
    audioCueCount?: number;
    audioState?: "idle" | "ready" | "unavailable" | "destroyed";
    chickenArtFrame?: string;
    invalidVisibleArtObjects?: number;
    lastAudioCue?: string | null;
    renderedWarnings?: number;
    renderedQuietZones?: number;
    renderedCollectibles?: number;
    renderedMovingHazards?: number;
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
  activeParticles: number;
  artAtlasFrames: number;
  artAtlasSource: string;
  audioCueCount: number;
  audioState: "idle" | "ready" | "unavailable" | "destroyed";
  chickenArtFrame: string;
  collisionZones: number;
  pooledObjects: number;
  sceneObjects: number;
  renderedWarnings: number;
  renderedQuietZones: number;
  renderedCollectibles: number;
  renderedMovingHazards: number;
  inputListeners: number;
  invalidVisibleArtObjects: number;
  lastAudioCue: string | null;
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
  private presentationPreferences: PresentationPreferences = {
    muted: false,
    reducedMotion: false,
    screenShakeEnabled: true,
  };

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

  setPresentationPreferences(preferences: PresentationPreferences) {
    this.presentationPreferences = { ...preferences };
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

  presentationSnapshot() {
    return { ...this.presentationPreferences };
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
    const interactionEvents = this.simulation.drainInteractionEvents();

    for (const event of interactionEvents) {
      this.events.emit(event);
    }

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
          runId: this.runGeneration,
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
      activeParticles: scene?.activeParticles ?? 0,
      artAtlasFrames: scene?.artAtlasFrames ?? 0,
      artAtlasSource: scene?.artAtlasSource ?? "unmounted",
      audioCueCount: scene?.audioCueCount ?? 0,
      audioState: scene?.audioState ?? "idle",
      chickenArtFrame: scene?.chickenArtFrame ?? "",
      collisionZones: simulation.collisionZones,
      pooledObjects: scene?.pooledObjects ?? simulation.pooledObjects,
      sceneObjects: scene?.sceneObjects ?? 0,
      renderedWarnings: scene?.renderedWarnings ?? 0,
      renderedQuietZones: scene?.renderedQuietZones ?? 0,
      renderedCollectibles: scene?.renderedCollectibles ?? 0,
      renderedMovingHazards: scene?.renderedMovingHazards ?? 0,
      inputListeners: this.input?.diagnostics?.().activeListeners ?? 0,
      invalidVisibleArtObjects: scene?.invalidVisibleArtObjects ?? 0,
      lastAudioCue: scene?.lastAudioCue ?? null,
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
    this.container.dataset.activeParticles = String(diagnostics.activeParticles);
    this.container.dataset.artAtlasFrames = String(diagnostics.artAtlasFrames);
    this.container.dataset.artAtlasSource = diagnostics.artAtlasSource;
    this.container.dataset.audioCueCount = String(diagnostics.audioCueCount);
    this.container.dataset.audioState = diagnostics.audioState;
    this.container.dataset.chickenArtFrame = diagnostics.chickenArtFrame;
    this.container.dataset.collisionZones = String(diagnostics.collisionZones);
    this.container.dataset.pooledObjects = String(diagnostics.pooledObjects);
    this.container.dataset.sceneObjects = String(diagnostics.sceneObjects);
    this.container.dataset.renderedWarnings = String(diagnostics.renderedWarnings);
    this.container.dataset.renderedQuietZones = String(diagnostics.renderedQuietZones);
    this.container.dataset.renderedCollectibles = String(diagnostics.renderedCollectibles);
    this.container.dataset.renderedMovingHazards = String(diagnostics.renderedMovingHazards);
    this.container.dataset.inputListeners = String(diagnostics.inputListeners);
    this.container.dataset.invalidVisibleArtObjects = String(diagnostics.invalidVisibleArtObjects);
    this.container.dataset.lastAudioCue = diagnostics.lastAudioCue ?? "";
    this.container.dataset.activeInput = this.activeInput;
    this.container.dataset.configuredInput = this.configuredInput;
    this.container.dataset.inputLevel = this.normalizedInput.toFixed(3);
    this.container.dataset.appliedLift = this.appliedLift.toFixed(3);
    this.container.dataset.muted = this.presentationPreferences.muted ? "true" : "false";
    this.container.dataset.reducedMotion = this.presentationPreferences.reducedMotion
      ? "true"
      : "false";
    this.container.dataset.screenShakeEnabled = this.presentationPreferences.screenShakeEnabled
      ? "true"
      : "false";
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
    this.container.dataset.simulationTick = String(snapshot.tick);
    this.container.dataset.elapsedMs = String(snapshot.elapsedMs);
    this.container.dataset.courseDistance = String(snapshot.courseDistance);
    this.container.dataset.loopsCompleted = String(snapshot.loopsCompleted);
    this.container.dataset.currentChunkIndex = String(snapshot.currentChunkIndex);
    this.container.dataset.currentChunkId = snapshot.currentChunkId ?? "";
    const generatedSnapshot = this.generatedCourse?.snapshot(snapshot.tick);
    const currentChunk = generatedSnapshot?.chunks.find(
      (chunk) => chunk.chunkIndex === snapshot.currentChunkIndex,
    );
    const currentWarnings = generatedSnapshot?.warnings.filter(
      (warning) => warning.chunkIndex === snapshot.currentChunkIndex,
    );
    this.container.dataset.currentChunkTraversal = currentChunk?.requiredCapability ?? "";
    this.container.dataset.currentChunkVoiceSkills = currentChunk?.voiceSkills.join(",") ?? "";
    this.container.dataset.currentChunkMechanics = currentChunk?.mechanics.join(",") ?? "";
    this.container.dataset.currentChunkChallengeStage = currentChunk?.challengeStage ?? "";
    this.container.dataset.currentChunkDifficulty = currentChunk
      ? `${currentChunk.minimumDifficulty}-${currentChunk.maximumDifficulty}`
      : "";
    this.container.dataset.currentChunkWarning =
      currentWarnings?.map((warning) => `${warning.symbol} ${warning.text}`).join(" | ") ?? "";
    this.container.dataset.activeChunkIds =
      generatedSnapshot?.chunks.map((chunk) => chunk.templateId).join(",") ?? "";
    this.container.dataset.activeWarningCopy =
      generatedSnapshot?.warnings
        .map((warning) => `${warning.symbol} ${warning.text}`)
        .join(" | ") ?? "";
    this.container.dataset.activeWarningCount = String(generatedSnapshot?.warnings.length ?? 0);
    this.container.dataset.movingHazardPhases =
      generatedSnapshot?.spikes
        .filter((spike) => spike.kind === "moving-spike")
        .map((spike) => `${spike.id}@${spike.motion?.phaseTick ?? 0}`)
        .join(",") ?? "";
    this.container.dataset.movingHazardState =
      generatedSnapshot?.spikes
        .filter((spike) => spike.kind === "moving-spike")
        .map((spike) => `${spike.id}@${spike.x.toFixed(3)}`)
        .join(",") ?? "";
    this.container.dataset.collectedCollectibles = String(snapshot.collectedCollectibleIds.length);
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
