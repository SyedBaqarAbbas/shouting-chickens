import type { PresentationPreferences } from "../../core";
import type { SimulationSnapshot } from "../simulation";

export type GameAudioCue = "jump" | "flap" | "land" | "feather" | "hazard";

export type SynthCue = Readonly<{
  attackMs: number;
  durationMs: number;
  endHz: number;
  peakOutputGain: number;
  startHz: number;
  waveform: OscillatorType;
}>;

export const MAX_GAME_AUDIO_OUTPUT_GAIN = 0.032;
export const MAX_GAME_AUDIO_DURATION_MS = 180;
export const CONSERVATIVE_SPEAKER_TO_MIC_COUPLING = 0.2;
export const MAX_MODELED_FEEDBACK_LEVEL = 0.09;
const HARD_LIMIT_CURVE_POINTS = 4_097;

export const GAME_AUDIO_CUES: Readonly<Record<GameAudioCue, SynthCue>> = Object.freeze({
  jump: {
    attackMs: 12,
    durationMs: 118,
    endHz: 660,
    peakOutputGain: 0.026,
    startHz: 430,
    waveform: "sine",
  },
  flap: {
    attackMs: 8,
    durationMs: 82,
    endHz: 390,
    peakOutputGain: 0.018,
    startHz: 560,
    waveform: "triangle",
  },
  land: {
    attackMs: 5,
    durationMs: 64,
    endHz: 118,
    peakOutputGain: 0.016,
    startHz: 190,
    waveform: "sine",
  },
  feather: {
    attackMs: 10,
    durationMs: 146,
    endHz: 1_060,
    peakOutputGain: 0.024,
    startHz: 720,
    waveform: "sine",
  },
  hazard: {
    attackMs: 6,
    durationMs: 174,
    endHz: 82,
    peakOutputGain: 0.032,
    startHz: 148,
    waveform: "sawtooth",
  },
});

type AudioContextConstructor = new () => AudioContext;
type AudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor;
  };

export type GameAudioDiagnostics = Readonly<{
  cueCount: number;
  lastCue: GameAudioCue | null;
  state: "idle" | "ready" | "unavailable" | "destroyed";
}>;

type ActiveVoice = {
  disposed: boolean;
  envelope: GainNode;
  oscillator: OscillatorNode;
};

export function audioCuesForTransition(
  previous: SimulationSnapshot | null,
  current: SimulationSnapshot,
): readonly GameAudioCue[] {
  if (!previous) {
    return [];
  }

  if (current.phase === "dead" && previous.phase !== "dead") {
    return ["hazard"];
  }
  if (current.collectedCollectibleIds.length > previous.collectedCollectibleIds.length) {
    return ["feather"];
  }
  if (current.landingCount > previous.landingCount) {
    return ["land"];
  }
  if (current.chicken.animation !== previous.chicken.animation) {
    if (current.chicken.animation === "jump") {
      return ["jump"];
    } else if (current.chicken.animation === "flap") {
      return ["flap"];
    }
  }

  return [];
}

export function createHardLimitCurve(
  limit = MAX_GAME_AUDIO_OUTPUT_GAIN,
  pointCount = HARD_LIMIT_CURVE_POINTS,
): Float32Array<ArrayBuffer> {
  const safeLimit = Math.min(1, Math.max(0, limit));
  // Stay at or below the public ceiling after the curve is quantized to Float32 samples.
  const float32Limit =
    safeLimit === 0
      ? 0
      : Math.max(0, Math.fround(safeLimit - Math.max(Number.EPSILON, safeLimit * 2 ** -23)));
  const safePointCount = Math.max(3, Math.floor(pointCount));
  const curve = new Float32Array(safePointCount);
  for (let index = 0; index < safePointCount; index += 1) {
    const input = (index / (safePointCount - 1)) * 2 - 1;
    curve[index] = Math.min(float32Limit, Math.max(-float32Limit, input));
  }
  return curve;
}

export function estimateModeledFeedbackLevel(
  cue: SynthCue,
  coupling = CONSERVATIVE_SPEAKER_TO_MIC_COUPLING,
): number {
  const envelopeRms = cue.peakOutputGain / Math.sqrt(6);
  const coupledRms = envelopeRms * Math.max(0, coupling);
  return Math.min(1, coupledRms / 0.03);
}

export class GameAudioDirector {
  private context: AudioContext | null = null;
  private limiter: WaveShaperNode | null = null;
  private master: GainNode | null = null;
  private activeVoice: ActiveVoice | null = null;
  private previous: SimulationSnapshot | null = null;
  private muted = false;
  private state: GameAudioDiagnostics["state"] = "idle";
  private cueCount = 0;
  private lastCue: GameAudioCue | null = null;

  constructor(
    private readonly contextFactory: (() => AudioContext | null) | null = defaultContextFactory,
  ) {}

  render(snapshot: SimulationSnapshot, presentation: PresentationPreferences) {
    if (this.state === "destroyed") {
      return;
    }

    this.setMuted(presentation.muted);
    const cues = audioCuesForTransition(this.previous, snapshot);
    this.previous = snapshot;

    if (this.muted) {
      return;
    }

    const cue = cues[0];
    if (cue) {
      this.play(cue);
    }
  }

  reset(snapshot: SimulationSnapshot | null = null) {
    if (this.context) {
      this.disposeActiveVoice(this.context.currentTime);
    }
    this.previous = snapshot;
  }

  diagnostics(): GameAudioDiagnostics {
    return Object.freeze({
      cueCount: this.cueCount,
      lastCue: this.lastCue,
      state: this.state,
    });
  }

  destroy() {
    if (this.state === "destroyed") {
      return;
    }

    const context = this.context;
    if (context) {
      this.disposeActiveVoice(context.currentTime);
    }
    this.limiter?.disconnect();
    this.master?.disconnect();
    this.context = null;
    this.limiter = null;
    this.master = null;
    this.previous = null;
    this.state = "destroyed";
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  }

  private setMuted(muted: boolean) {
    this.muted = muted;
    if (!this.master || !this.context) {
      return;
    }

    this.master.gain.cancelScheduledValues(this.context.currentTime);
    this.master.gain.setValueAtTime(muted ? 0 : 1, this.context.currentTime);
    if (muted) {
      this.disposeActiveVoice(this.context.currentTime);
    }
  }

  private play(cueName: GameAudioCue) {
    const context = this.ensureContext();
    const limiter = this.limiter;
    if (!context || !limiter) {
      return;
    }

    const cue = GAME_AUDIO_CUES[cueName];
    const startedAt = context.currentTime;
    const attackAt = startedAt + cue.attackMs / 1_000;
    const endsAt = startedAt + cue.durationMs / 1_000;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const voice: ActiveVoice = { disposed: false, envelope, oscillator };

    this.disposeActiveVoice(startedAt);
    oscillator.type = cue.waveform;
    oscillator.frequency.setValueAtTime(cue.startHz, startedAt);
    oscillator.frequency.exponentialRampToValueAtTime(cue.endHz, endsAt);
    envelope.gain.setValueAtTime(0.0001, startedAt);
    envelope.gain.linearRampToValueAtTime(cue.peakOutputGain, attackAt);
    envelope.gain.exponentialRampToValueAtTime(0.0001, endsAt);
    oscillator.connect(envelope);
    envelope.connect(limiter);
    this.activeVoice = voice;
    oscillator.start(startedAt);
    oscillator.stop(endsAt + 0.01);
    oscillator.addEventListener(
      "ended",
      () => {
        this.disposeVoice(voice);
      },
      { once: true },
    );

    this.cueCount += 1;
    this.lastCue = cueName;
  }

  private ensureContext(): AudioContext | null {
    if (this.context) {
      if (this.context.state === "suspended") {
        void this.context.resume().catch(() => undefined);
      }
      return this.context;
    }
    if (!this.contextFactory || this.state === "unavailable") {
      return null;
    }

    try {
      const context = this.contextFactory();
      if (!context) {
        this.state = "unavailable";
        return null;
      }
      const limiter = context.createWaveShaper();
      const master = context.createGain();
      limiter.curve = createHardLimitCurve();
      limiter.oversample = "none";
      master.gain.setValueAtTime(this.muted ? 0 : 1, context.currentTime);
      limiter.connect(master);
      master.connect(context.destination);
      this.context = context;
      this.limiter = limiter;
      this.master = master;
      this.state = "ready";
      if (context.state === "suspended") {
        void context.resume().catch(() => undefined);
      }
      return context;
    } catch {
      this.state = "unavailable";
      return null;
    }
  }

  private disposeActiveVoice(stopAt: number) {
    const voice = this.activeVoice;
    if (!voice) {
      return;
    }

    try {
      voice.oscillator.stop(stopAt);
    } catch {
      // A naturally ended oscillator is already silent and can still be disconnected.
    }
    this.disposeVoice(voice);
  }

  private disposeVoice(voice: ActiveVoice) {
    if (voice.disposed) {
      return;
    }

    voice.disposed = true;
    if (this.activeVoice === voice) {
      this.activeVoice = null;
    }
    voice.oscillator.disconnect();
    voice.envelope.disconnect();
  }
}

function defaultContextFactory(): AudioContext | null {
  const audioWindow = window as AudioWindow;
  const Constructor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  return Constructor ? new Constructor() : null;
}
