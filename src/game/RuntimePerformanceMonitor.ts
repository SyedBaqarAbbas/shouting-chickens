import type { InputProvenance } from "../core";

export const INPUT_TO_INTENT_BUDGET_MS = 100;
export const FRAME_TIME_BUDGET_MS = 20;
export const PERFORMANCE_HISTOGRAM_MAX_MS = 1_000;

export type RuntimePerformanceDiagnostics = Readonly<{
  frameBudgetMet: boolean | null;
  frameOverBudgetRatio: number | null;
  frameP50Ms: number | null;
  frameP95Ms: number | null;
  frameSamples: number;
  inputBudgetMet: boolean | null;
  inputToIntentP95Ms: number | null;
  inputSamples: number;
  voiceInputBudgetMet: boolean | null;
  voiceInputToIntentP95Ms: number | null;
  voiceInputSamples: number;
}>;

/**
 * Whole-session timings without retaining individual samples. Each bucket is
 * one millisecond wide and the overflow bucket represents values above one
 * second, so memory remains constant during long runs.
 */
class CoarseTimingHistogram {
  private readonly bins = new Uint32Array(PERFORMANCE_HISTOGRAM_MAX_MS + 2);
  private samples = 0;
  private overBudget = 0;

  constructor(private readonly budgetMs: number) {}

  add(valueMs: number) {
    if (!Number.isFinite(valueMs) || valueMs < 0) {
      return;
    }

    const bucket = Math.min(PERFORMANCE_HISTOGRAM_MAX_MS + 1, Math.ceil(valueMs));
    this.bins[bucket] = Math.min(0xffff_ffff, (this.bins[bucket] ?? 0) + 1);
    this.samples += 1;
    if (valueMs > this.budgetMs) {
      this.overBudget += 1;
    }
  }

  count() {
    return this.samples;
  }

  overBudgetRatio() {
    return this.samples === 0 ? null : this.overBudget / this.samples;
  }

  percentile(percentile: number) {
    if (this.samples === 0) {
      return null;
    }

    const target = Math.max(1, Math.ceil(this.samples * percentile));
    let observed = 0;
    for (let bucket = 0; bucket < this.bins.length; bucket += 1) {
      observed += this.bins[bucket] ?? 0;
      if (observed >= target) {
        return bucket;
      }
    }

    return PERFORMANCE_HISTOGRAM_MAX_MS + 1;
  }
}

export class RuntimePerformanceMonitor {
  private readonly frameTimings = new CoarseTimingHistogram(FRAME_TIME_BUDGET_MS);
  private readonly inputTimings = new CoarseTimingHistogram(INPUT_TO_INTENT_BUDGET_MS);
  private readonly voiceInputTimings = new CoarseTimingHistogram(INPUT_TO_INTENT_BUDGET_MS);

  recordFrame(frameDeltaMs: number) {
    this.frameTimings.add(frameDeltaMs);
  }

  recordInputToIntent(latencyMs: number, provenance: InputProvenance = "none") {
    this.inputTimings.add(latencyMs);
    if (provenance === "voice") {
      this.voiceInputTimings.add(latencyMs);
    }
  }

  diagnostics(): RuntimePerformanceDiagnostics {
    const frameP50Ms = this.frameTimings.percentile(0.5);
    const frameP95Ms = this.frameTimings.percentile(0.95);
    const inputToIntentP95Ms = this.inputTimings.percentile(0.95);
    const voiceInputToIntentP95Ms = this.voiceInputTimings.percentile(0.95);

    return Object.freeze({
      frameBudgetMet: frameP95Ms === null ? null : frameP95Ms <= FRAME_TIME_BUDGET_MS,
      frameOverBudgetRatio: this.frameTimings.overBudgetRatio(),
      frameP50Ms,
      frameP95Ms,
      frameSamples: this.frameTimings.count(),
      inputBudgetMet:
        inputToIntentP95Ms === null ? null : inputToIntentP95Ms <= INPUT_TO_INTENT_BUDGET_MS,
      inputToIntentP95Ms,
      inputSamples: this.inputTimings.count(),
      voiceInputBudgetMet:
        voiceInputToIntentP95Ms === null
          ? null
          : voiceInputToIntentP95Ms <= INPUT_TO_INTENT_BUDGET_MS,
      voiceInputToIntentP95Ms,
      voiceInputSamples: this.voiceInputTimings.count(),
    });
  }
}
