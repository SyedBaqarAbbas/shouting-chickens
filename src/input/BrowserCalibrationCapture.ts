import { SystemClock, type CalibrationProfile, type Clock, type SignalQuality } from "../core";
import {
  BrowserScalarEnergySource,
  type VoiceEnergyDependencies,
} from "../platform/audio/BrowserScalarEnergySource";
import type { BrowserMediaSession } from "../platform/media";
import {
  createCalibrationProfile,
  MIN_STAGE_SAMPLES,
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
  readonly progress: number;
  readonly level: number;
  readonly quality: SignalQuality;
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

export class BrowserCalibrationCapture implements CalibrationCapture {
  private readonly listeners = new Set<() => void>();
  private readonly traces: Record<CalibrationStage, EnergyScalarFrame[]> = {
    loud: [],
    normal: [],
    quiet: [],
  };
  private readonly source: ScalarEnergySource;
  private snapshotValue: CalibrationCaptureSnapshot;
  private started = false;
  private lastPublishedAtMs = Number.NEGATIVE_INFINITY;

  constructor(
    session: BrowserMediaSession,
    dependencies: VoiceEnergyDependencies = {},
    private readonly clock: Clock = new SystemClock(),
    private readonly targetSamples = MIN_STAGE_SAMPLES,
    private readonly publishIntervalMs = 100,
    source?: ScalarEnergySource,
  ) {
    if (!Number.isInteger(targetSamples) || targetSamples < MIN_STAGE_SAMPLES) {
      throw new RangeError(`Calibration requires at least ${MIN_STAGE_SAMPLES} samples per stage`);
    }
    if (!Number.isFinite(publishIntervalMs) || publishIntervalMs < 0) {
      throw new RangeError("Calibration publish interval must be non-negative");
    }

    this.source = source ?? new BrowserScalarEnergySource(session, dependencies);
    this.snapshotValue = this.createSnapshot("idle", "quiet");
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
    this.snapshotValue = this.createSnapshot("capturing", stage);
    this.publish(true);
  }

  finalize(): CalibrationResult {
    const result = createCalibrationProfile(this.trace());
    this.snapshotValue = {
      ...this.createSnapshot(result.ok ? "complete" : "failed", "loud"),
      result,
    };
    this.publish(true);
    return result;
  }

  reset(): void {
    for (const stage of STAGES) {
      this.traces[stage] = [];
    }
    this.lastPublishedAtMs = Number.NEGATIVE_INFINITY;
    this.snapshotValue = this.createSnapshot("idle", "quiet");
    this.publish(true);
  }

  stop(): void {
    if (this.snapshotValue.status === "stopped") {
      return;
    }

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
    if (!this.started || this.snapshotValue.status !== "capturing") {
      return;
    }

    const stage = this.snapshotValue.stage;
    const samples = this.traces[stage];
    if (samples.length < this.targetSamples) {
      samples.push({ ...frame });
    }

    const quality = qualityFor(frame);
    const level = clamp((frame.dbfs + 90) / 90, 0, 1);
    const stageComplete = samples.length >= this.targetSamples;

    this.snapshotValue = {
      ...this.createSnapshot(stageComplete ? "stage-complete" : "capturing", stage),
      level,
      quality,
    };

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
    return Object.freeze({
      completedStages: Object.freeze(this.completedStages()),
      level: 0,
      progress: Math.min(1, sampleCount / this.targetSamples),
      quality: "weak" as const,
      result: null,
      sampleCount,
      stage,
      status,
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
