import type {
  CalibrationProfile,
  ControlIntent,
  SignalQuality,
  VoiceFrame,
} from "../core/contracts";
import { isCalibrationProfile, normalizeDbfs } from "./calibration";
import { clamp, type EnergyScalarFrame } from "./energy";

export type VoiceProcessingOptions = {
  readonly attackMs?: number;
  readonly releaseMs?: number;
  readonly cooldownMs?: number;
};

export type ProcessedVoiceFrame = {
  readonly voice: VoiceFrame;
  readonly intent: ControlIntent;
};

const DEFAULT_ATTACK_MS = 35;
const DEFAULT_RELEASE_MS = 180;
const DEFAULT_COOLDOWN_MS = 260;

export class AttackReleaseSmoother {
  private value = 0;
  private previousAtMs: number | null = null;

  constructor(
    private readonly attackMs = DEFAULT_ATTACK_MS,
    private readonly releaseMs = DEFAULT_RELEASE_MS,
  ) {
    if (attackMs <= 0 || releaseMs <= 0) {
      throw new RangeError("Attack and release times must be greater than zero");
    }
  }

  update(target: number, atMs: number): number {
    if (!Number.isFinite(target) || !Number.isFinite(atMs)) {
      throw new RangeError("Smoother input and time must be finite");
    }
    if (this.previousAtMs !== null && atMs < this.previousAtMs) {
      throw new RangeError("Voice frames must have non-decreasing timestamps");
    }

    const boundedTarget = clamp(target, 0, 1);
    if (this.previousAtMs === null) {
      this.value = boundedTarget;
      this.previousAtMs = atMs;
      return this.value;
    }

    const elapsedMs = atMs - this.previousAtMs;
    const timeConstant = boundedTarget > this.value ? this.attackMs : this.releaseMs;
    const blend = 1 - Math.exp(-elapsedMs / timeConstant);
    this.value += (boundedTarget - this.value) * blend;
    this.previousAtMs = atMs;
    return this.value;
  }

  reset(value = 0): void {
    this.value = clamp(value, 0, 1);
    this.previousAtMs = null;
  }
}

export class VoiceIntentProcessor {
  private readonly smoother: AttackReleaseSmoother;
  private readonly cooldownMs: number;
  private gateHigh = false;
  private armed = true;
  private releaseObserved = false;
  private cooldownUntilMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly profile: CalibrationProfile,
    options: VoiceProcessingOptions = {},
  ) {
    if (!isCalibrationProfile(profile)) {
      throw new RangeError("Voice thresholds are invalid");
    }

    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    if (this.cooldownMs < 0) {
      throw new RangeError("Voice cooldown cannot be negative");
    }

    this.smoother = new AttackReleaseSmoother(
      options.attackMs ?? DEFAULT_ATTACK_MS,
      options.releaseMs ?? DEFAULT_RELEASE_MS,
    );
  }

  process(energy: EnergyScalarFrame, atMs: number): ProcessedVoiceFrame {
    const normalized = normalizeDbfs(energy.dbfs, this.profile);
    const smoothed = this.smoother.update(normalized, atMs);

    if (this.gateHigh && smoothed <= this.profile.jumpExitLevel) {
      this.gateHigh = false;
      this.releaseObserved = true;
    }

    if (!this.armed && this.releaseObserved && !this.gateHigh && atMs >= this.cooldownUntilMs) {
      this.armed = true;
      this.releaseObserved = false;
    }

    let onset = false;
    if (!this.gateHigh && smoothed >= this.profile.jumpEnterLevel) {
      this.gateHigh = true;
      if (this.armed && atMs >= this.cooldownUntilMs) {
        onset = true;
        this.armed = false;
        this.cooldownUntilMs = atMs + this.cooldownMs;
      }
    }

    const lift = clamp(
      (smoothed - this.profile.liftStartLevel) / (1 - this.profile.liftStartLevel),
      0,
      1,
    );
    const signalQuality: SignalQuality =
      energy.clipped || energy.dbfs >= -0.25 ? "clipped" : smoothed < 0.08 ? "weak" : "good";
    const voice: VoiceFrame = {
      atMs,
      normalizedLevel: smoothed,
      onset,
      rawDb: energy.dbfs,
      signalQuality,
    };

    return {
      intent: {
        atMs,
        jumpPressed: onset,
        lift,
      },
      voice,
    };
  }

  reset(): void {
    this.gateHigh = false;
    this.armed = true;
    this.releaseObserved = false;
    this.cooldownUntilMs = Number.NEGATIVE_INFINITY;
    this.smoother.reset();
  }
}

export { DEFAULT_ATTACK_MS, DEFAULT_COOLDOWN_MS, DEFAULT_RELEASE_MS };
