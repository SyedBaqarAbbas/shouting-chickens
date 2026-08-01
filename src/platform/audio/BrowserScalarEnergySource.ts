import {
  energyScalarFromSamples,
  parseEnergyScalarFrame,
  type EnergyScalarFrame,
} from "../../input/energy";
import type { BrowserMediaSession, MicrophoneAudioGraph } from "../media/BrowserMediaSession";

export const DEFAULT_WORKLET_MODULE_URL = `${import.meta.env.BASE_URL}audio/voice-rms-processor.js`;
export const VOICE_RMS_PROCESSOR_NAME = "voice-rms-processor";
export const ANALYSER_FFT_SIZE = 256;

export type VoiceEnergyMode = "audio-worklet" | "analyser";

export interface VoiceEnergyDependencies {
  readonly workletModuleUrl?: string;
  readonly createAudioWorkletNode?: (
    context: AudioContext,
    name: string,
    options: AudioWorkletNodeOptions,
  ) => AudioWorkletNode;
  readonly requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
}

interface EnergyCapture {
  readonly mode: VoiceEnergyMode;
  start(sink: (frame: EnergyScalarFrame) => void): Promise<void>;
  stop(): void;
}

export class BrowserScalarEnergySource {
  private capture: EnergyCapture | null = null;
  private generation = 0;
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly session: BrowserMediaSession,
    private readonly dependencies: VoiceEnergyDependencies = {},
  ) {}

  get mode(): VoiceEnergyMode | null {
    return this.capture?.mode ?? null;
  }

  start(sink: (frame: EnergyScalarFrame) => void): Promise<void> {
    if (this.capture) {
      return Promise.resolve();
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const generation = ++this.generation;
    const starting = this.startGeneration(generation, sink);
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

  stop(): void {
    ++this.generation;
    this.startPromise = null;
    this.capture?.stop();
    this.capture = null;
  }

  private async startGeneration(
    generation: number,
    sink: (frame: EnergyScalarFrame) => void,
  ): Promise<void> {
    const graph = this.session.getMicrophoneAudioGraph();
    if (!graph) {
      throw new Error("Microphone capture must be active before energy processing starts.");
    }

    let capture = await createEnergyCapture(this.session, graph, this.dependencies);
    try {
      await capture.start(sink);
    } catch (error) {
      capture.stop();
      if (capture.mode !== "audio-worklet") {
        throw error;
      }

      capture = new AnalyserEnergyCapture(this.session, graph, this.dependencies);
      try {
        await capture.start(sink);
      } catch (fallbackError) {
        capture.stop();
        throw fallbackError;
      }
    }

    if (this.generation !== generation) {
      capture.stop();
      return;
    }

    this.capture = capture;
  }
}

async function createEnergyCapture(
  session: BrowserMediaSession,
  graph: MicrophoneAudioGraph,
  dependencies: VoiceEnergyDependencies,
): Promise<EnergyCapture> {
  const audioWorklet = getAudioWorklet(graph.context);
  const createNode = resolveWorkletNodeFactory(dependencies.createAudioWorkletNode);

  if (audioWorklet && createNode) {
    try {
      await audioWorklet.addModule(dependencies.workletModuleUrl ?? DEFAULT_WORKLET_MODULE_URL);
      return new WorkletEnergyCapture(session, graph, createNode);
    } catch {
      // Some browsers expose AudioWorklet while blocking its module. The
      // analyser path preserves the scalar-only, inaudible contract.
    }
  }

  return new AnalyserEnergyCapture(session, graph, dependencies);
}

class WorkletEnergyCapture implements EnergyCapture {
  readonly mode = "audio-worklet";
  private node: AudioWorkletNode | null = null;
  private unregisterNode: (() => void) | null = null;
  private messageListener: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(
    private readonly session: BrowserMediaSession,
    private readonly graph: MicrophoneAudioGraph,
    private readonly createNode: NonNullable<VoiceEnergyDependencies["createAudioWorkletNode"]>,
  ) {}

  async start(sink: (frame: EnergyScalarFrame) => void): Promise<void> {
    const node = this.createNode(this.graph.context, VOICE_RMS_PROCESSOR_NAME, {
      channelCount: 1,
      channelCountMode: "explicit",
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    const messageListener = (event: MessageEvent<unknown>) => {
      const frame = parseEnergyScalarFrame(event.data);
      if (frame) {
        sink(frame);
      }
    };

    this.node = node;
    this.messageListener = messageListener;
    node.port.addEventListener("message", messageListener);
    node.port.start();

    try {
      this.unregisterNode = this.session.registerMicrophoneNode(node);
      this.graph.source.connect(node);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    const node = this.node;
    if (!node) {
      return;
    }

    if (this.messageListener) {
      node.port.removeEventListener("message", this.messageListener);
    }
    node.port.close();
    disconnectSourceFromNode(this.graph.source, node);
    this.unregisterNode?.();
    this.unregisterNode = null;
    this.messageListener = null;
    this.node = null;
  }
}

class AnalyserEnergyCapture implements EnergyCapture {
  readonly mode = "analyser";
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private frameHandle: number | null = null;
  private unregisterNode: (() => void) | null = null;
  private running = false;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;

  constructor(
    private readonly session: BrowserMediaSession,
    private readonly graph: MicrophoneAudioGraph,
    dependencies: VoiceEnergyDependencies,
  ) {
    this.requestFrame =
      dependencies.requestAnimationFrame ?? globalThis.requestAnimationFrame?.bind(globalThis);
    this.cancelFrame =
      dependencies.cancelAnimationFrame ?? globalThis.cancelAnimationFrame?.bind(globalThis);

    if (!this.requestFrame || !this.cancelFrame) {
      throw new Error("Animation frame scheduling is unavailable for analyser input.");
    }
  }

  async start(sink: (frame: EnergyScalarFrame) => void): Promise<void> {
    const analyser = this.graph.context.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    const buffer = new Float32Array(analyser.fftSize);

    this.analyser = analyser;
    this.buffer = buffer;
    this.running = true;

    try {
      this.unregisterNode = this.session.registerMicrophoneNode(analyser);
      this.graph.source.connect(analyser);
    } catch (error) {
      this.stop();
      throw error;
    }

    const sample = () => {
      if (!this.running || this.analyser !== analyser || this.buffer !== buffer) {
        return;
      }

      analyser.getFloatTimeDomainData(buffer);
      sink(energyScalarFromSamples(buffer, this.graph.context.currentTime * 1_000));
      this.frameHandle = this.requestFrame(sample);
    };
    this.frameHandle = this.requestFrame(sample);
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }

    if (this.analyser) {
      disconnectSourceFromNode(this.graph.source, this.analyser);
    }
    this.unregisterNode?.();
    this.unregisterNode = null;
    this.analyser = null;
    this.buffer = null;
  }
}

function getAudioWorklet(context: AudioContext): AudioWorklet | undefined {
  return (context as AudioContext & { audioWorklet?: AudioWorklet }).audioWorklet;
}

function resolveWorkletNodeFactory(
  factory: VoiceEnergyDependencies["createAudioWorkletNode"],
): VoiceEnergyDependencies["createAudioWorkletNode"] {
  if (factory) {
    return factory;
  }

  if (typeof globalThis.AudioWorkletNode !== "function") {
    return undefined;
  }

  return (context, name, options) => new AudioWorkletNode(context, name, options);
}

function disconnectSourceFromNode(source: MediaStreamAudioSourceNode, node: AudioNode): void {
  try {
    source.disconnect(node);
  } catch {
    // The media session may already have disconnected its source during cleanup.
  }
}
