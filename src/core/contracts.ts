export type SignalQuality = "good" | "weak" | "clipped";

export type VoiceFrame = {
  atMs: number;
  rawDb: number;
  normalizedLevel: number;
  onset: boolean;
  signalQuality: SignalQuality;
};

export type ControlIntent = {
  atMs: number;
  jumpPressed: boolean;
  lift: number;
};

export type ControlMode = "voice" | "keyboard-touch";
export type InputProvenance = ControlMode | "none";

export type InputFeedback = {
  normalizedLevel: number;
  provenance: InputProvenance;
};

export const NEUTRAL_CONTROL_INTENT: Readonly<ControlIntent> = Object.freeze({
  atMs: 0,
  jumpPressed: false,
  lift: 0,
});

export interface InputSource {
  start(): Promise<void>;
  latest(): ControlIntent;
  getFeedback?(): InputFeedback;
  resetRunState?(): void;
  diagnostics?(): { activeListeners: number };
  stop(): void;
}

export type CalibrationProfile = {
  schemaVersion: 1;
  noiseFloorDb: number;
  normalDb: number;
  loudDb: number;
  jumpEnterLevel: number;
  jumpExitLevel: number;
  liftStartLevel: number;
};

export type RunOptions = {
  seed: string;
  calibration: CalibrationProfile | null;
  gameplayVersion: string;
};

export type PresentationPreferences = {
  muted: boolean;
  reducedMotion: boolean;
  screenShakeEnabled: boolean;
};

export type GamePhase = "ready" | "countdown" | "running" | "paused" | "game-over";

export type GameSnapshot = {
  phase: GamePhase;
  elapsedMs: number;
  score: number;
  distance: number;
  normalizedInput: number;
};

export type RunEndReason = "water" | "hazard" | "fall" | "quit" | "completed";

export type RunSummary = {
  runId: number;
  seed: string;
  gameplayVersion: string;
  score: number;
  survivalMs: number;
  distance: number;
  reason: RunEndReason;
};

export type RuntimeErrorCode =
  "unsupported" | "input-unavailable" | "render-failed" | "invalid-state";

export type RuntimeError = {
  code: RuntimeErrorCode;
  message: string;
  recoverable: boolean;
  cause?: unknown;
};

export type GameEvent =
  | { type: "snapshot"; value: GameSnapshot }
  | { type: "ended"; value: RunSummary }
  | { type: "fatal-error"; error: RuntimeError };

export type GameEventListener = (event: GameEvent) => void;

export interface GameRuntime {
  mount(container: HTMLElement): Promise<void>;
  startRun(options: RunOptions): void;
  setActiveInput(mode: ControlMode): void;
  setPresentationPreferences?(preferences: PresentationPreferences): void;
  pause(): void;
  resume(): void;
  restart(): void;
  destroy(): void;
  subscribe(listener: GameEventListener): () => void;
}

export interface Clock {
  now(): number;
}

export interface RandomSource {
  next(): number;
  integer(minimum: number, maximum: number): number;
  pick<T>(values: readonly T[]): T;
}

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): readonly string[];
  clear(): void;
}

export type MediaKind = "microphone" | "camera";
export type MediaReadyState = "live" | "ended";

export interface MediaTrackPort {
  readonly id: string;
  readonly kind: MediaKind;
  readonly readyState: MediaReadyState;
  stop(): void;
  onEnded(listener: () => void): () => void;
}

export interface MediaStreamPort {
  getTracks(): readonly MediaTrackPort[];
  getTracks(kind: MediaKind): readonly MediaTrackPort[];
}

export type AudioContextState = "suspended" | "running" | "closed";

export interface AudioContextPort {
  readonly state: AudioContextState;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export type MediaCapabilities = {
  microphone: boolean;
  camera: boolean;
  audioContext: boolean;
};

export interface MediaGateway {
  capabilities(): MediaCapabilities;
  requestMicrophone(): Promise<MediaStreamPort>;
  requestCamera(): Promise<MediaStreamPort>;
  createAudioContext(): AudioContextPort;
}
