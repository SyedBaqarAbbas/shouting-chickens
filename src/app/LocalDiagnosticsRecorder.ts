import type { SafeLocalRuntimeDiagnostics } from "../game/PhaserGameRuntime";
import type { RuntimePerformanceDiagnostics } from "../game/RuntimePerformanceMonitor";
import type { MediaSessionDiagnostics } from "../platform/media";

export const REFERENCE_EVIDENCE_DURATION_MS = 600_000;
const MAX_QUALIFYING_SAMPLE_GAP_MS = 1_500;

type RuntimeResources = SafeLocalRuntimeDiagnostics["resources"];
type MediaResources = MediaSessionDiagnostics["resources"];

type ResourceAggregate<T> = Readonly<{
  baseline: T;
  final: T;
  max: T;
  stableMismatchCount: number;
}>;

export type ReferenceEvidenceObservation = Readonly<{
  controlModeValid: boolean;
  gameplayActive: boolean;
  media: MediaSessionDiagnostics | null;
  nowMs: number;
  nowUtc: string;
  qualifying: boolean;
  runtime: SafeLocalRuntimeDiagnostics | null;
  visible: boolean;
}>;

export type ReferenceEvidenceSnapshot = Readonly<{
  activeEvidenceMs: number;
  completedAtUtc: string | null;
  controlModeViolations: number;
  media: ResourceAggregate<MediaResources> | null;
  performance: RuntimePerformanceDiagnostics | null;
  qualifyingSamples: number;
  release: SafeLocalRuntimeDiagnostics["release"] | null;
  renderer: SafeLocalRuntimeDiagnostics["renderer"] | null;
  run: SafeLocalRuntimeDiagnostics["run"] | null;
  runtime: ResourceAggregate<RuntimeResources> | null;
  schemaVersion: 1;
  startedAtUtc: string;
  totalSamples: number;
  verdict: {
    duration: boolean;
    frame: boolean;
    input: boolean;
    mediaResources: boolean;
    pass: boolean;
    runtimeResources: boolean;
  };
  visibilityInterruptions: number;
  wallElapsedMs: number;
}>;

const RUNTIME_STABLE_KEYS = [
  "activeBodies",
  "activeTimers",
  "eventListeners",
  "inputListeners",
  "pooledObjects",
  "sceneObjects",
] as const satisfies readonly (keyof RuntimeResources)[];

const MEDIA_STABLE_KEYS = [
  "activeAudioNodes",
  "activeCameraTracks",
  "activeMicrophoneTracks",
  "activeTracks",
  "lifecycleListeners",
  "pendingAudioContexts",
  "sessionSubscribers",
  "trackListeners",
] as const satisfies readonly (keyof MediaResources)[];

/**
 * Constant-size physical-reference recorder. It retains baseline/final/max
 * aggregates only, never individual samples, media, voice levels, or device
 * identity.
 */
export class LocalDiagnosticsRecorder {
  private activeEvidenceMs = 0;
  private completedAtUtc: string | null = null;
  private controlModeViolations = 0;
  private lastQualifyingAtMs: number | null = null;
  private lastVisible = true;
  private media: ResourceAggregate<MediaResources> | null = null;
  private performance: RuntimePerformanceDiagnostics | null = null;
  private qualifyingSamples = 0;
  private release: SafeLocalRuntimeDiagnostics["release"] | null = null;
  private renderer: SafeLocalRuntimeDiagnostics["renderer"] | null = null;
  private run: SafeLocalRuntimeDiagnostics["run"] | null = null;
  private runtime: ResourceAggregate<RuntimeResources> | null = null;
  private totalSamples = 0;
  private visibilityInterruptions = 0;
  private wallElapsedMs = 0;

  constructor(
    private readonly startedAtMs: number,
    private readonly startedAtUtc: string,
  ) {}

  observe(observation: ReferenceEvidenceObservation): ReferenceEvidenceSnapshot {
    if (this.completedAtUtc) {
      return this.snapshot();
    }

    const nowMs = Number.isFinite(observation.nowMs)
      ? Math.max(this.startedAtMs, observation.nowMs)
      : this.startedAtMs;
    this.wallElapsedMs = Math.round(nowMs - this.startedAtMs);
    this.totalSamples += 1;

    if (!observation.visible && this.lastVisible) {
      this.visibilityInterruptions += 1;
    }
    this.lastVisible = observation.visible;

    if (
      this.lastQualifyingAtMs !== null &&
      observation.gameplayActive &&
      !observation.controlModeValid
    ) {
      this.controlModeViolations += 1;
    }

    if (observation.qualifying && observation.runtime && observation.media && observation.visible) {
      if (this.lastQualifyingAtMs !== null) {
        const gapMs = nowMs - this.lastQualifyingAtMs;
        if (gapMs >= 0 && gapMs <= MAX_QUALIFYING_SAMPLE_GAP_MS) {
          this.activeEvidenceMs += gapMs;
        }
      }
      this.lastQualifyingAtMs = nowMs;
      this.qualifyingSamples += 1;
      this.recordRuntime(observation.runtime);
      this.recordMedia(observation.media);
    } else {
      this.lastQualifyingAtMs = null;
    }

    if (this.activeEvidenceMs >= REFERENCE_EVIDENCE_DURATION_MS) {
      this.completedAtUtc = observation.nowUtc;
    }
    return this.snapshot();
  }

  snapshot(): ReferenceEvidenceSnapshot {
    const verdict = this.verdict();
    return Object.freeze({
      activeEvidenceMs: Math.round(this.activeEvidenceMs),
      completedAtUtc: this.completedAtUtc,
      controlModeViolations: this.controlModeViolations,
      media: this.media,
      performance: this.performance,
      qualifyingSamples: this.qualifyingSamples,
      release: this.release,
      renderer: this.renderer,
      run: this.run,
      runtime: this.runtime,
      schemaVersion: 1,
      startedAtUtc: this.startedAtUtc,
      totalSamples: this.totalSamples,
      verdict,
      visibilityInterruptions: this.visibilityInterruptions,
      wallElapsedMs: this.wallElapsedMs,
    });
  }

  private recordRuntime(diagnostics: SafeLocalRuntimeDiagnostics) {
    this.release ??= diagnostics.release;
    this.run ??= diagnostics.run;
    this.renderer = diagnostics.renderer;
    this.performance = diagnostics.performance;
    this.runtime = aggregateRuntime(this.runtime, diagnostics.resources);
  }

  private recordMedia(diagnostics: MediaSessionDiagnostics) {
    this.media = aggregateMedia(this.media, diagnostics.resources);
  }

  private verdict() {
    const duration =
      this.completedAtUtc !== null &&
      this.activeEvidenceMs >= REFERENCE_EVIDENCE_DURATION_MS &&
      this.visibilityInterruptions === 0 &&
      this.controlModeViolations === 0;
    const frame =
      this.performance?.frameBudgetMet === true &&
      this.performance.frameSamples >= 30_000 &&
      this.performance.frameP95Ms !== null &&
      this.performance.frameP95Ms <= 20;
    const input =
      this.performance?.voiceInputBudgetMet === true &&
      this.performance.voiceInputSamples >= 100 &&
      this.performance.voiceInputToIntentP95Ms !== null &&
      this.performance.voiceInputToIntentP95Ms <= 100;
    const runtimeResources = runtimeResourcesPass(this.runtime);
    const mediaResources = mediaResourcesPass(this.media);
    return Object.freeze({
      duration,
      frame,
      input,
      mediaResources,
      pass:
        duration &&
        frame &&
        input &&
        runtimeResources &&
        mediaResources &&
        (this.renderer === "webgl" || this.renderer === "canvas"),
      runtimeResources,
    });
  }
}

function aggregateRuntime(
  aggregate: ResourceAggregate<RuntimeResources> | null,
  current: RuntimeResources,
): ResourceAggregate<RuntimeResources> {
  if (!aggregate) {
    return Object.freeze({
      baseline: current,
      final: current,
      max: current,
      stableMismatchCount: 0,
    });
  }
  return Object.freeze({
    baseline: aggregate.baseline,
    final: current,
    max: maxRuntimeResources(aggregate.max, current),
    stableMismatchCount:
      aggregate.stableMismatchCount +
      Number(!sameKeys(aggregate.baseline, current, RUNTIME_STABLE_KEYS)),
  });
}

function aggregateMedia(
  aggregate: ResourceAggregate<MediaResources> | null,
  current: MediaResources,
): ResourceAggregate<MediaResources> {
  if (!aggregate) {
    return Object.freeze({
      baseline: current,
      final: current,
      max: current,
      stableMismatchCount: 0,
    });
  }
  return Object.freeze({
    baseline: aggregate.baseline,
    final: current,
    max: maxMediaResources(aggregate.max, current),
    stableMismatchCount:
      aggregate.stableMismatchCount +
      Number(!sameKeys(aggregate.baseline, current, MEDIA_STABLE_KEYS)),
  });
}

function sameKeys<T extends object>(baseline: T, current: T, keys: readonly (keyof T)[]) {
  return keys.every((key) => baseline[key] === current[key]);
}

function maxRuntimeResources(left: RuntimeResources, right: RuntimeResources): RuntimeResources {
  return {
    activeBodies: Math.max(left.activeBodies, right.activeBodies),
    activeParticles: Math.max(left.activeParticles, right.activeParticles),
    activeTimers: Math.max(left.activeTimers, right.activeTimers),
    audioActiveVoices: Math.max(left.audioActiveVoices, right.audioActiveVoices),
    audioGraphNodes: Math.max(left.audioGraphNodes, right.audioGraphNodes),
    eventListeners: Math.max(left.eventListeners, right.eventListeners),
    inputListeners: Math.max(left.inputListeners, right.inputListeners),
    pooledObjects: Math.max(left.pooledObjects, right.pooledObjects),
    retainedCollectibleIds: Math.max(left.retainedCollectibleIds, right.retainedCollectibleIds),
    retainedCollisionIds: Math.max(left.retainedCollisionIds, right.retainedCollisionIds),
    retainedObstacleIds: Math.max(left.retainedObstacleIds, right.retainedObstacleIds),
    retainedPrecisionLandingIds: Math.max(
      left.retainedPrecisionLandingIds,
      right.retainedPrecisionLandingIds,
    ),
    sceneObjects: Math.max(left.sceneObjects, right.sceneObjects),
  };
}

function maxMediaResources(left: MediaResources, right: MediaResources): MediaResources {
  return {
    activeAudioNodes: Math.max(left.activeAudioNodes, right.activeAudioNodes),
    activeCameraTracks: Math.max(left.activeCameraTracks, right.activeCameraTracks),
    activeMicrophoneTracks: Math.max(left.activeMicrophoneTracks, right.activeMicrophoneTracks),
    activeTracks: Math.max(left.activeTracks, right.activeTracks),
    lifecycleListeners: Math.max(left.lifecycleListeners, right.lifecycleListeners),
    pendingAudioContexts: Math.max(left.pendingAudioContexts, right.pendingAudioContexts),
    sessionSubscribers: Math.max(left.sessionSubscribers, right.sessionSubscribers),
    trackListeners: Math.max(left.trackListeners, right.trackListeners),
  };
}

function runtimeResourcesPass(aggregate: ResourceAggregate<RuntimeResources> | null) {
  if (!aggregate || aggregate.stableMismatchCount !== 0) {
    return false;
  }
  return (
    sameKeys(aggregate.baseline, aggregate.final, RUNTIME_STABLE_KEYS) &&
    aggregate.baseline.activeBodies === 1 &&
    aggregate.max.activeBodies <= 1 &&
    aggregate.max.activeTimers === 0 &&
    aggregate.max.eventListeners <= 1 &&
    aggregate.max.inputListeners <= 5 &&
    aggregate.max.pooledObjects <= 86 &&
    aggregate.max.sceneObjects <= 195 &&
    aggregate.max.activeParticles <= 24 &&
    aggregate.max.audioActiveVoices <= 1 &&
    aggregate.max.audioGraphNodes <= 4 &&
    aggregate.max.retainedCollectibleIds <= 12 &&
    aggregate.max.retainedCollisionIds <= 1 &&
    aggregate.max.retainedObstacleIds <= 24 &&
    aggregate.max.retainedPrecisionLandingIds <= 16
  );
}

function mediaResourcesPass(aggregate: ResourceAggregate<MediaResources> | null) {
  if (!aggregate || aggregate.stableMismatchCount !== 0) {
    return false;
  }
  const validEndpoints = [aggregate.baseline, aggregate.final].every(
    (resources) =>
      resources.activeAudioNodes > 0 &&
      resources.activeCameraTracks === 1 &&
      resources.activeMicrophoneTracks === 1 &&
      resources.activeTracks === 2 &&
      resources.pendingAudioContexts === 0,
  );
  return (
    validEndpoints &&
    sameKeys(aggregate.baseline, aggregate.final, MEDIA_STABLE_KEYS) &&
    aggregate.max.activeCameraTracks <= 1 &&
    aggregate.max.activeMicrophoneTracks <= 1 &&
    aggregate.max.activeTracks <= 2 &&
    aggregate.max.activeAudioNodes <= 2 &&
    aggregate.max.lifecycleListeners <= 3 &&
    aggregate.max.pendingAudioContexts === 0 &&
    aggregate.max.sessionSubscribers <= 3 &&
    aggregate.max.trackListeners <= 6
  );
}
