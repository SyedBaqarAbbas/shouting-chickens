import { describe, expect, it } from "vitest";

import { HEAP_TREND_LIMIT_BYTES_PER_SAMPLE, linearHeapTrendBytesPerSample } from "./HeapTrend";

describe("restart-soak heap trend", () => {
  it("rejects a small monotonic leak that stays inside the endpoint allowance", () => {
    const samples = Array.from(
      { length: 50 },
      (_, index) => 20 * 1_024 * 1_024 + index * 0.08 * 1_024 * 1_024,
    );
    const slope = linearHeapTrendBytesPerSample(samples);

    expect(slope).not.toBeNull();
    expect(slope!).toBeGreaterThan(HEAP_TREND_LIMIT_BYTES_PER_SAMPLE);
    expect(samples.at(-1)! - samples[0]!).toBeLessThan(4 * 1_024 * 1_024);
  });

  it("tolerates bounded GC noise and a flat post-warmup heap", () => {
    const samples = [20, 21, 20.5, 21.5, 20.75, 21.25, 20.9, 21.1, 20.8, 21.2, 20.95, 21.05].map(
      (mib) => mib * 1_024 * 1_024,
    );

    expect(linearHeapTrendBytesPerSample(samples)).toBeLessThanOrEqual(
      HEAP_TREND_LIMIT_BYTES_PER_SAMPLE,
    );
    expect(linearHeapTrendBytesPerSample([samples[0]!])).toBeNull();
  });
});
