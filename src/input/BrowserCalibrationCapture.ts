import { SystemClock, type CalibrationProfile, type Clock, type SignalQuality } from "../core";
import {
  BrowserCalibrationClipRecorder,
  type CalibrationClipRecorder,
  type CalibrationClipSnapshot,
} from "../platform/audio/BrowserCalibrationClipRecorder";
import {
  BrowserScalarEnergySource,
  type VoiceEnergyDependencies,
} from "../platform/audio/BrowserScalarEnergySource";
import type { BrowserMediaSession } from "../platform/media";
import {
  createCalibrationProfile,
  MIN_STAGE_SAMPLES,
  validateCalibrationStage,
  type CalibrationFailure,
  type CalibrationResult,
  type CalibrationTrace,
} from "./calibration";
import { clamp, type EnergyScalarFrame } from "./energy";

export type CalibrationStage = "quiet" | "normal" | "loud";
export type CalibrationCaptureStatus =
  "idle" | "capturing" | "stage-complete" | "complete" | "failed" | "stopped";

export type CalibrationCaptureSnapshot = {
  readonly status: CalibrationCaptureStatus;
  readonly stage: CalibrationStage;
  readonly completedStages: readonly CalibrationStage[];
  readonly sampleCount: number;
  readonly targetSamples: number;
  readonly elapsedMs: number;
  readonly targetDurationMs: number;
  readonly progress: number;
  readonly level: number;
  readonly hasSignal: boolean;
  readonly quality: SignalQuality;
  readonly clip: CalibrationClipSnapshot;
  readonly result: CalibrationResult | null;
};

export interface CalibrationCapture {
  start(): Promise<void>;
  beginStage(stage: CalibrationStage): void;
  finalize(): CalibrationResult;
  reset(): void;
  stop(): void;
  getSnapshot(): CalibrationCaptureSnapshot;
  subscribe(listener: () => void): () => void;
}

interface ScalarEnergySource {
  start(sink: (frame: EnergyScalarFrame) => void): Promise<void>;
  stop(): void;
}

const STAGES: readonly CalibrationStage[] = ["quiet", "normal", "loud"];
export const DEFAULT_CALIBRATION_STAGE_DURATION_MS = 1_500;

export class BrowserCalibrationCapture implements CalibrationCapture {
  private readonly listeners = new Set<() => void>();
  private readonly traces: Record<CalibrationStage, EnergyScalarFrame[]> = {
    loud: [],
    normal: [],
    quiet: [],
  };
  private readonly source: ScalarEnergySource;
  private readonly clipRecorder: CalibrationClipRecorder;
  private readonly unsubscribeClip: () => void;
  private snapshotValue: CalibrationCaptureSnapshot;
  private started = false;
  private lastPublishedAtMs = Number.NEGATIVE_INFINITY;
  private stageStartedAtMs: number | null = null;

  constructor(
    session: BrowserMediaSession,
    dependencies: VoiceEnergyDependencies = {},
    private readonly clock: Clock = new SystemClock(),
    private readonly targetSamples = MIN_STAGE_SAMPLES,
    private readonly publishIntervalMs = 100,
    source?: ScalarEnergySource,
    private readonly minimumStageDurationMs = DEFAULT_CALIBRATION_STAGE_DURATION_MS,
    clipRecorder?: CalibrationClipRecorder,
  ) {
    if (!Number.isInteger(targetSamples) || targetSamples < MIN_STAGE_SAMPLES) {
      throw new RangeError(`Calibration requires at least ${MIN_STAGE_SAMPLES} samples per stage`);
    }
    if (!Number.isFinite(publishIntervalMs) || publishIntervalMs < 0) {
      throw new RangeError("Calibration publish interval must be non-negative");
    }
    if (!Number.isFinite(minimumStageDurationMs) || minimumStageDurationMs <= 0) {
      throw new RangeError("Calibration stage duration must be a positive finite number");
    }

    this.source = source ?? new BrowserScalarEnergySource(session, dependencies);
    this.clipRecorder = clipRecorder ?? new BrowserCalibrationClipRecorder(session);
    this.snapshotValue = this.createSnapshot("idle", "quiet");
    this.unsubscribeClip = this.clipRecorder.subscribe(() => {
      this.snapshotValue = Object.freeze({
        ...this.snapshotValue,
        clip: this.clipRecorder.getSnapshot(),
      });
      this.publish(true);
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    try {
      await this.source.start(this.handleEnergy);
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  beginStage(stage: CalibrationStage): void {
    if (!this.started) {
      throw new Error("Calibration capture must start before a stage begins");
    }

    const expected = STAGES[this.completedStages().length];
    if (stage !== expected) {
      throw new Error(`Calibration expected the ${expected ?? "finished"} stage`);
    }

    this.traces[stage] = [];
    this.stageStartedAtMs = this.clock.now();
    if (stage === "quiet") {
      this.clipRecorder.discard();
    } else {
      this.clipRecorder.beginStage(stage);
    }
    this.snapshotValue = this.createSnapshot("capturing", stage);
    this.publish(true);
  }

  finalize(): CalibrationResult {
    const result = createCalibrationProfile(this.trace());
    const stage = result.ok ? "loud" : (STAGES[this.completedStages().length] ?? "loud");
    this.snapshotValue = {
      ...this.createSnapshot(result.ok ? "complete" : "failed", stage),
      result,
    };
    this.publish(true);
    return result;
  }

  reset(): void {
    for (const stage of STAGES) {
      this.traces[stage] = [];
    }
    this.stageStartedAtMs = null;
    this.clipRecorder.discard();
    this.lastPublishedAtMs = Number.NEGATIVE_INFINITY;
    this.snapshotValue = this.createSnapshot("idle", "quiet");
    this.publish(true);
  }

  stop(): void {
    if (this.snapshotValue.status === "stopped") {
      return;
    }

    this.clipRecorder.stop();
    this.unsubscribeClip();
    this.source.stop();
    this.started = false;
    this.snapshotValue = {
      ...this.snapshotValue,
      status: "stopped",
    };
    this.publish(true);
  }

  readonly getSnapshot = (): CalibrationCaptureSnapshot => this.snapshotValue;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private readonly handleEnergy = (frame: EnergyScalarFrame) => {
    if (!this.started) {
      return;
    }

    const quality = qualityFor(frame);
    const level = clamp((frame.dbfs + 90) / 90, 0, 1);
    const hasSignal = frame.dbfs > -85;

    if (this.snapshotValue.status !== "capturing" || this.stageStartedAtMs === null) {
      this.snapshotValue = Object.freeze({
        ...this.snapshotValue,
        hasSignal,
        level,
        quality,
      });
      this.publish(false);
      return;
    }

    const stage = this.snapshotValue.stage;
    const samples = this.traces[stage];
    const now = this.clock.now();
    const sampleIntervalMs = this.minimumStageDurationMs / (this.targetSamples - 1);
    const nextSampleAtMs = this.stageStartedAtMs + samples.length * sampleIntervalMs;
    if (samples.length < this.targetSamples && now >= nextSampleAtMs) {
      samples.push({ ...frame });
    }

    const elapsedMs = Math.max(0, now - this.stageStartedAtMs);
    const stageComplete =
      samples.length >= this.targetSamples && elapsedMs >= this.minimumStageDurationMs;

    if (stageComplete) {
      const invalid = validateCalibrationStage(this.trace(), stage);
      if (invalid) {
        this.traces[stage] = [];
        this.stageStartedAtMs = null;
        if (stage === "quiet") {
          this.clipRecorder.discard();
        } else {
          this.clipRecorder.finishStage();
        }
        this.snapshotValue = Object.freeze({
          ...this.createSnapshot("failed", stage),
          hasSignal,
          level,
          quality,
          result: invalid,
        });
        this.publish(true);
        return;
      }

      this.stageStartedAtMs = null;
      if (stage !== "quiet") {
        this.clipRecorder.finishStage();
      }
    }

    this.snapshotValue = Object.freeze({
      ...this.createSnapshot(stageComplete ? "stage-complete" : "capturing", stage),
      elapsedMs: Math.min(elapsedMs, this.minimumStageDurationMs),
      hasSignal,
      level,
      quality,
    });

    if (stageComplete && stage === "loud") {
      this.finalize();
      return;
    }

    this.publish(stageComplete);
  };

  private publish(force: boolean) {
    const now = this.clock.now();
    if (!force && now - this.lastPublishedAtMs < this.publishIntervalMs) {
      return;
    }

    this.lastPublishedAtMs = now;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private createSnapshot(
    status: CalibrationCaptureStatus,
    stage: CalibrationStage,
  ): CalibrationCaptureSnapshot {
    const sampleCount = this.traces[stage].length;
    const elapsedMs =
      this.stageStartedAtMs === null
        ? status === "stage-complete" || status === "complete"
          ? this.minimumStageDurationMs
          : 0
        : Math.min(this.minimumStageDurationMs, this.clock.now() - this.stageStartedAtMs);
    const sampleProgress = sampleCount / this.targetSamples;
    const timeProgress = elapsedMs / this.minimumStageDurationMs;
    return Object.freeze({
      clip: this.clipRecorder.getSnapshot(),
      completedStages: Object.freeze(this.completedStages()),
      elapsedMs,
      hasSignal: false,
      level: 0,
      progress: Math.min(1, sampleProgress, timeProgress),
      quality: "weak" as const,
      result: null,
      sampleCount,
      stage,
      status,
      targetDurationMs: this.minimumStageDurationMs,
      targetSamples: this.targetSamples,
    });
  }

  private completedStages(): CalibrationStage[] {
    return STAGES.filter((stage) => this.traces[stage].length >= this.targetSamples);
  }

  private trace(): CalibrationTrace {
    return {
      loud: this.traces.loud.map((frame) => ({ ...frame })),
      normal: this.traces.normal.map((frame) => ({ ...frame })),
      quiet: this.traces.quiet.map((frame) => ({ ...frame })),
    };
  }
}

function qualityFor(frame: EnergyScalarFrame): SignalQuality {
  if (frame.clipped || frame.dbfs >= -0.25) {
    return "clipped";
  }
  return frame.dbfs < -55 ? "weak" : "good";
}

export function calibrationFailureMessage(failure: CalibrationFailure): string {
  return `${failure.message} ${failure.guidance}`;
}

export function calibrationProfileFrom(
  snapshot: CalibrationCaptureSnapshot,
): CalibrationProfile | null {
  return snapshot.result?.ok ? snapshot.result.profile : null;
}
