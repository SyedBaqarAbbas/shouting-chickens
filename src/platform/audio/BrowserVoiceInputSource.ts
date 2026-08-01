import {
  NEUTRAL_CONTROL_INTENT,
  type CalibrationProfile,
  type Clock,
  type ControlIntent,
  type InputFeedback,
  type InputLatencySample,
  type InputSource,
  type VoiceFrame,
} from "../../core/contracts";
import { normalizeDbfs, type EnergyScalarFrame } from "../../input";
import {
  VoiceIntentProcessor,
  type VoiceProcessingOptions,
} from "../../input/VoiceIntentProcessor";
import type { BrowserMediaSession } from "../media/BrowserMediaSession";
import {
  ANALYSER_FFT_SIZE,
  BrowserScalarEnergySource,
  DEFAULT_WORKLET_MODULE_URL,
  VOICE_RMS_PROCESSOR_NAME,
  type VoiceEnergyDependencies,
  type VoiceEnergyMode,
} from "./BrowserScalarEnergySource";

export type VoiceInputDependencies = VoiceEnergyDependencies;

export class BrowserVoiceInputSource implements InputSource {
  private readonly processor: VoiceIntentProcessor;
  private readonly energySource: BrowserScalarEnergySource;
  private current: ControlIntent = { ...NEUTRAL_CONTROL_INTENT };
  private currentVoice: VoiceFrame | null = null;
  private running = false;
  private unsubscribeSession: (() => void) | null = null;
  private generation = 0;
  private startPromise: Promise<void> | null = null;
  private captureTimeOriginMs = 0;
  private captureClockNeedsRebase = true;
  private pendingInputLatencyMs: number | null = null;
  private voiceOnsetCapturedAtMs: number | null = null;
  private liftActive = false;

  constructor(
    private readonly session: BrowserMediaSession,
    private readonly clock: Clock,
    private readonly profile: CalibrationProfile,
    dependencies: VoiceInputDependencies = {},
    processingOptions: VoiceProcessingOptions = {},
  ) {
    this.processor = new VoiceIntentProcessor(this.profile, processingOptions);
    this.energySource = new BrowserScalarEnergySource(session, dependencies);
  }

  get mode(): VoiceEnergyMode | null {
    return this.energySource.mode;
  }

  getLatestVoiceFrame(): VoiceFrame | null {
    return this.currentVoice ? { ...this.currentVoice } : null;
  }

  consumeInputLatencyMs(): number | null {
    const latency = this.pendingInputLatencyMs;
    this.pendingInputLatencyMs = null;
    return latency;
  }

  consumeInputLatencySamples(): readonly InputLatencySample[] {
    const latencyMs = this.consumeInputLatencyMs();
    return latencyMs === null ? [] : [{ latencyMs, provenance: "voice" }];
  }

  start(): Promise<void> {
    if (this.running) {
      return Promise.resolve();
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const generation = ++this.generation;
    const starting = this.startGeneration(generation);
    this.startPromise = starting;
    void starting.then(
      () => {
        if (this.startPromise === starting) {
          this.startPromise = null;
        }
      },
      () => {
        if (this.startPromise === starting) {
          this.startPromise = null;
        }
      },
    );
    return starting;
  }

  latest(): ControlIntent {
    if (!this.running) {
      return { ...NEUTRAL_CONTROL_INTENT };
    }

    const intent = { ...this.current };
    this.current.jumpPressed = false;
    return intent;
  }

  getFeedback(): InputFeedback {
    const normalizedLevel = this.running ? (this.currentVoice?.normalizedLevel ?? 0) : 0;
    return {
      normalizedLevel,
      provenance: normalizedLevel > 0 ? "voice" : "none",
    };
  }

  resetRunState(): void {
    this.processor.reset();
    this.current = {
      ...NEUTRAL_CONTROL_INTENT,
      atMs: this.running ? this.clock.now() : 0,
    };
    this.currentVoice = null;
    this.pendingInputLatencyMs = null;
    this.voiceOnsetCapturedAtMs = null;
    this.liftActive = false;
  }

  stop(): void {
    ++this.generation;
    this.startPromise = null;
    this.energySource.stop();
    this.running = false;
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.captureClockNeedsRebase = true;
    this.pendingInputLatencyMs = null;
    this.resetRunState();
  }

  private async startGeneration(generation: number): Promise<void> {
    const graph = this.session.getMicrophoneAudioGraph();
    if (!graph) {
      throw new Error("Microphone capture must be active before voice processing starts.");
    }
    this.rebaseCaptureClock(graph.context);

    this.processor.reset();
    const sink = (energy: EnergyScalarFrame) => {
      if (
        this.generation !== generation ||
        this.session.getSnapshot().microphone.status !== "active"
      ) {
        return;
      }

      const receivedAtMs = this.clock.now();
      const capturedAtMs =
        energy.capturedAtMs > 0
          ? Math.min(receivedAtMs, this.captureTimeOriginMs + energy.capturedAtMs)
          : receivedAtMs;
      const processed = this.processor.process(energy, capturedAtMs);
      const rawLevel = normalizeDbfs(energy.dbfs, this.profile);
      if (rawLevel >= this.profile.jumpEnterLevel && this.voiceOnsetCapturedAtMs === null) {
        this.voiceOnsetCapturedAtMs = capturedAtMs;
      }
      const nextLiftActive = processed.intent.lift > 0;
      if ((!this.liftActive && nextLiftActive) || processed.intent.jumpPressed) {
        this.recordInputLatency(receivedAtMs - (this.voiceOnsetCapturedAtMs ?? capturedAtMs));
      }
      this.liftActive = nextLiftActive;
      if (rawLevel <= this.profile.jumpExitLevel && !nextLiftActive) {
        this.voiceOnsetCapturedAtMs = null;
      }
      const hasPendingJump = this.current.jumpPressed;
      this.current = {
        ...processed.intent,
        atMs: hasPendingJump ? this.current.atMs : processed.intent.atMs,
        jumpPressed: hasPendingJump || processed.intent.jumpPressed,
      };
      this.currentVoice = processed.voice;
    };
    await this.energySource.start(sink);

    if (this.generation !== generation) {
      return;
    }

    this.running = true;
    this.current = {
      ...NEUTRAL_CONTROL_INTENT,
      atMs: this.clock.now(),
    };
    this.unsubscribeSession = this.session.subscribe(this.handleSessionState);
    this.handleSessionState();
  }

  private readonly handleSessionState = () => {
    const status = this.session.getSnapshot().microphone.status;
    if (status === "suspended") {
      this.captureClockNeedsRebase = true;
      this.resetRunState();
      return;
    }

    if (status === "active" && this.captureClockNeedsRebase) {
      const graph = this.session.getMicrophoneAudioGraph();
      if (graph) {
        this.rebaseCaptureClock(graph.context);
      }
      return;
    }

    if (
      status === "closed" ||
      status === "device-lost" ||
      status === "fallback" ||
      status === "unavailable" ||
      status === "unsupported" ||
      status === "denied"
    ) {
      this.stop();
    }
  };

  private rebaseCaptureClock(context: AudioContext) {
    const contextTimeMs = Number.isFinite(context.currentTime) ? context.currentTime * 1_000 : 0;
    this.captureTimeOriginMs = this.clock.now() - contextTimeMs;
    this.captureClockNeedsRebase = false;
  }

  private recordInputLatency(latencyMs: number) {
    const bounded = Math.max(0, latencyMs);
    this.pendingInputLatencyMs =
      this.pendingInputLatencyMs === null ? bounded : Math.max(this.pendingInputLatencyMs, bounded);
  }
}

export { ANALYSER_FFT_SIZE, DEFAULT_WORKLET_MODULE_URL, VOICE_RMS_PROCESSOR_NAME };
export type { VoiceEnergyMode };
