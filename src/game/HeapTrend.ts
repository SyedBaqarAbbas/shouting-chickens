export const HEAP_TREND_LIMIT_BYTES_PER_SAMPLE = 64 * 1_024;

export function linearHeapTrendBytesPerSample(samples: readonly number[]) {
  if (samples.length < 2) {
    return null;
  }
  const center = (samples.length - 1) / 2;
  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const centeredIndex = index - center;
    numerator += centeredIndex * (samples[index]! - mean);
    denominator += centeredIndex * centeredIndex;
  }
  return denominator === 0 ? null : numerator / denominator;
}
