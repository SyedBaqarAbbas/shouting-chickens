import {
  NEUTRAL_CONTROL_INTENT,
  type CalibrationProfile,
  type Clock,
  type ControlIntent,
  type InputFeedback,
  type InputSource,
  type VoiceFrame,
} from "../../core/contracts";
import type { EnergyScalarFrame } from "../../input";
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

  constructor(
    private readonly session: BrowserMediaSession,
    private readonly clock: Clock,
    profile: CalibrationProfile,
    dependencies: VoiceInputDependencies = {},
    processingOptions: VoiceProcessingOptions = {},
  ) {
    this.processor = new VoiceIntentProcessor(profile, processingOptions);
    this.energySource = new BrowserScalarEnergySource(session, dependencies);
  }

  get mode(): VoiceEnergyMode | null {
    return this.energySource.mode;
  }

  getLatestVoiceFrame(): VoiceFrame | null {
    return this.currentVoice ? { ...this.currentVoice } : null;
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
  }

  stop(): void {
    ++this.generation;
    this.startPromise = null;
    this.energySource.stop();
    this.running = false;
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.resetRunState();
  }

  private async startGeneration(generation: number): Promise<void> {
    if (!this.session.getMicrophoneAudioGraph()) {
      throw new Error("Microphone capture must be active before voice processing starts.");
    }

    this.processor.reset();
    const sink = (energy: EnergyScalarFrame) => {
      if (
        this.generation !== generation ||
        this.session.getSnapshot().microphone.status !== "active"
      ) {
        return;
      }

      const processed = this.processor.process(energy, this.clock.now());
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
      this.resetRunState();
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
}

export { ANALYSER_FFT_SIZE, DEFAULT_WORKLET_MODULE_URL, VOICE_RMS_PROCESSOR_NAME };
export type { VoiceEnergyMode };
