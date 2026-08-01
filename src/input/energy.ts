const MIN_DBFS = -120;
const CLIPPING_AMPLITUDE = 0.995;

export type EnergyScalarFrame = {
  readonly capturedAtMs: number;
  readonly rms: number;
  readonly dbfs: number;
  readonly peak: number;
  readonly clipped: boolean;
};

export function rootMeanSquare(samples: ArrayLike<number>): number {
  if (samples.length === 0) {
    return 0;
  }

  let squaredTotal = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const candidate = samples[index] ?? 0;
    const sample = Number.isFinite(candidate) ? clamp(candidate, -1, 1) : 0;
    squaredTotal += sample * sample;
  }

  return Math.sqrt(squaredTotal / samples.length);
}

export function amplitudeToDbfs(amplitude: number): number {
  if (!Number.isFinite(amplitude) || amplitude <= 0) {
    return MIN_DBFS;
  }

  return clamp(20 * Math.log10(amplitude), MIN_DBFS, 0);
}

export function energyScalarFromSamples(
  samples: ArrayLike<number>,
  capturedAtMs = 0,
): EnergyScalarFrame {
  let peak = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const candidate = samples[index] ?? 0;
    if (Number.isFinite(candidate)) {
      peak = Math.max(peak, Math.abs(candidate));
    }
  }

  const rms = rootMeanSquare(samples);
  return {
    capturedAtMs,
    clipped: peak >= CLIPPING_AMPLITUDE,
    dbfs: amplitudeToDbfs(rms),
    peak,
    rms,
  };
}

export function parseEnergyScalarFrame(value: unknown): EnergyScalarFrame | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "voice-energy" ||
    typeof candidate.rms !== "number" ||
    typeof candidate.dbfs !== "number" ||
    typeof candidate.peak !== "number" ||
    typeof candidate.clipped !== "boolean" ||
    typeof candidate.capturedAtMs !== "number" ||
    !Number.isFinite(candidate.rms) ||
    !Number.isFinite(candidate.dbfs) ||
    !Number.isFinite(candidate.peak) ||
    !Number.isFinite(candidate.capturedAtMs) ||
    candidate.capturedAtMs < 0 ||
    candidate.rms < 0 ||
    candidate.rms > 1 ||
    candidate.dbfs < MIN_DBFS ||
    candidate.dbfs > 0 ||
    candidate.peak < 0
  ) {
    return null;
  }

  return {
    capturedAtMs: candidate.capturedAtMs,
    clipped: candidate.clipped,
    dbfs: candidate.dbfs,
    peak: candidate.peak,
    rms: candidate.rms,
  };
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export { CLIPPING_AMPLITUDE, MIN_DBFS };
