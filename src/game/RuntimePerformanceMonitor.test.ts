import { describe, expect, it } from "vitest";

import {
  PERFORMANCE_HISTOGRAM_MAX_MS,
  RuntimePerformanceMonitor,
} from "./RuntimePerformanceMonitor";

describe("RuntimePerformanceMonitor", () => {
  it("reports whole-session coarse percentiles and explicit budget states", () => {
    const monitor = new RuntimePerformanceMonitor();

    for (let sample = 1; sample <= 100; sample += 1) {
      monitor.recordFrame(sample / 5);
      monitor.recordInputToIntent(sample, sample % 2 === 0 ? "voice" : "keyboard-touch");
    }

    expect(monitor.diagnostics()).toEqual({
      frameBudgetMet: true,
      frameOverBudgetRatio: 0,
      frameP50Ms: 10,
      frameP95Ms: 19,
      frameSamples: 100,
      inputBudgetMet: true,
      inputToIntentP95Ms: 95,
      inputSamples: 100,
      voiceInputBudgetMet: true,
      voiceInputToIntentP95Ms: 96,
      voiceInputSamples: 50,
    });

    for (let sample = 0; sample < 10; sample += 1) {
      monitor.recordFrame(120);
      monitor.recordInputToIntent(200, "voice");
    }

    expect(monitor.diagnostics()).toMatchObject({
      frameBudgetMet: false,
      inputBudgetMet: false,
      voiceInputBudgetMet: false,
    });
  });

  it("uses constant-size buckets and ignores malformed samples", () => {
    const monitor = new RuntimePerformanceMonitor();

    for (let sample = 0; sample < 100_000; sample += 1) {
      monitor.recordFrame(16.2);
      monitor.recordInputToIntent(12.4);
    }
    monitor.recordFrame(PERFORMANCE_HISTOGRAM_MAX_MS * 2);
    monitor.recordFrame(Number.NaN);
    monitor.recordInputToIntent(-1);

    expect(monitor.diagnostics()).toMatchObject({
      frameBudgetMet: true,
      frameP50Ms: 17,
      frameP95Ms: 17,
      frameSamples: 100_001,
      inputBudgetMet: true,
      inputToIntentP95Ms: 13,
      inputSamples: 100_000,
      voiceInputBudgetMet: null,
      voiceInputToIntentP95Ms: null,
      voiceInputSamples: 0,
    });
  });
});
