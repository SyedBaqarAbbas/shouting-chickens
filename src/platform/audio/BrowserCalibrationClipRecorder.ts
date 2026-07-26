import type { BrowserMediaSession } from "../media";

export type CalibrationClipStage = "normal" | "loud";
export type CalibrationClipStatus =
  "idle" | "recording" | "processing" | "ready" | "unavailable" | "failed";

export type CalibrationClipSnapshot = {
  readonly stage: CalibrationClipStage | null;
  readonly status: CalibrationClipStatus;
  readonly url: string | null;
};

export interface CalibrationClipRecorder {
  beginStage(stage: CalibrationClipStage): void;
  finishStage(): void;
  discard(): void;
  stop(): void;
  getSnapshot(): CalibrationClipSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface CalibrationClipRecorderDependencies {
  readonly createMediaRecorder?: (stream: MediaStream) => MediaRecorder;
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

const MAX_CLIP_BYTES = 2 * 1024 * 1024;
const CLIP_TIMESLICE_MS = 250;
const MAX_RECORDING_DURATION_MS = 3_000;
const FINALIZE_TIMEOUT_MS = 1_000;

export class BrowserCalibrationClipRecorder implements CalibrationClipRecorder {
  private readonly listeners = new Set<() => void>();
  private readonly createMediaRecorder:
    CalibrationClipRecorderDependencies["createMediaRecorder"] | undefined;
  private readonly createObjectURL: ((blob: Blob) => string) | undefined;
  private readonly revokeObjectURL: ((url: string) => void) | undefined;
  private readonly scheduleTimeout: typeof globalThis.setTimeout;
  private readonly cancelTimeout: typeof globalThis.clearTimeout;
  private snapshotValue: CalibrationClipSnapshot = snapshot("idle");
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private chunkBytes = 0;
  private generation = 0;
  private recordingWatchdog: ReturnType<typeof globalThis.setTimeout> | null = null;
  private finalizeWatchdog: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor(
    private readonly session: BrowserMediaSession,
    dependencies: CalibrationClipRecorderDependencies = {},
  ) {
    this.createMediaRecorder =
      dependencies.createMediaRecorder ??
      (typeof globalThis.MediaRecorder === "function"
        ? (stream) => new globalThis.MediaRecorder(stream)
        : undefined);
    this.createObjectURL =
      dependencies.createObjectURL ??
      (typeof URL.createObjectURL === "function" ? URL.createObjectURL.bind(URL) : undefined);
    this.revokeObjectURL =
      dependencies.revokeObjectURL ??
      (typeof URL.revokeObjectURL === "function" ? URL.revokeObjectURL.bind(URL) : undefined);
    this.scheduleTimeout = dependencies.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.cancelTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  }

  beginStage(stage: CalibrationClipStage): void {
    this.releaseCurrent();
    const generation = ++this.generation;
    const stream = this.session.getMicrophoneAudioGraph?.()?.stream;

    if (!stream || !this.createMediaRecorder || !this.createObjectURL || !this.revokeObjectURL) {
      this.setSnapshot(snapshot("unavailable", stage));
      return;
    }

    let recorder: MediaRecorder;
    try {
      // Let the browser choose its native format. This avoids forcing a codec
      // that may not exist on Safari or another supported mobile browser.
      recorder = this.createMediaRecorder(stream);
    } catch {
      this.setSnapshot(snapshot("unavailable", stage));
      return;
    }

    this.recorder = recorder;
    this.chunks = [];
    this.chunkBytes = 0;

    recorder.addEventListener("dataavailable", (event) => {
      if (generation !== this.generation || event.data.size === 0) {
        return;
      }

      if (this.chunkBytes + event.data.size > MAX_CLIP_BYTES) {
        this.failGeneration(generation);
        return;
      }

      this.chunks.push(event.data);
      this.chunkBytes += event.data.size;
    });
    recorder.addEventListener("error", () => this.failGeneration(generation));
    recorder.addEventListener("stop", () => this.completeGeneration(generation, recorder));

    this.setSnapshot(snapshot("recording", stage));
    try {
      this.recordingWatchdog = this.scheduleTimeout(
        () => this.failGeneration(generation),
        MAX_RECORDING_DURATION_MS,
      );
      recorder.start(CLIP_TIMESLICE_MS);
    } catch {
      this.failGeneration(generation);
    }
  }

  finishStage(): void {
    const recorder = this.recorder;
    if (!recorder || this.snapshotValue.status !== "recording") {
      return;
    }

    this.setSnapshot(snapshot("processing", this.snapshotValue.stage));
    this.clearRecordingWatchdog();
    try {
      const generation = this.generation;
      this.finalizeWatchdog = this.scheduleTimeout(
        () => this.failGeneration(generation),
        FINALIZE_TIMEOUT_MS,
      );
      if (recorder.state === "inactive") {
        this.completeGeneration(generation, recorder);
      } else {
        recorder.stop();
      }
    } catch {
      this.failGeneration(this.generation);
    }
  }

  discard(): void {
    this.releaseCurrent();
    this.setSnapshot(snapshot("idle"));
  }

  stop(): void {
    this.discard();
  }

  readonly getSnapshot = (): CalibrationClipSnapshot => this.snapshotValue;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private completeGeneration(generation: number, recorder: MediaRecorder): void {
    if (generation !== this.generation || recorder !== this.recorder) {
      return;
    }

    this.clearWatchdogs();
    this.recorder = null;
    const stage = this.snapshotValue.stage;
    const chunks = this.chunks;
    this.chunks = [];
    this.chunkBytes = 0;

    if (!stage || chunks.length === 0 || !this.createObjectURL) {
      this.setSnapshot(snapshot("unavailable", stage));
      return;
    }

    try {
      const nativeType = recorder.mimeType || chunks[0]?.type;
      const blob = nativeType ? new Blob(chunks, { type: nativeType }) : new Blob(chunks);
      const url = this.createObjectURL(blob);
      this.setSnapshot(snapshot("ready", stage, url));
    } catch {
      this.setSnapshot(snapshot("failed", stage));
    }
  }

  private failGeneration(generation: number): void {
    if (generation !== this.generation) {
      return;
    }

    const stage = this.snapshotValue.stage;
    this.releaseCurrent();
    this.setSnapshot(snapshot("failed", stage));
  }

  private releaseCurrent(): void {
    ++this.generation;
    this.clearWatchdogs();
    const recorder = this.recorder;
    this.recorder = null;
    this.chunks = [];
    this.chunkBytes = 0;

    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // The recorder is already being released; stale events are ignored by
        // the generation guard.
      }
    }

    if (this.snapshotValue.url) {
      this.revokeObjectURL?.(this.snapshotValue.url);
    }
  }

  private setSnapshot(next: CalibrationClipSnapshot): void {
    this.snapshotValue = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private clearWatchdogs(): void {
    this.clearRecordingWatchdog();
    if (this.finalizeWatchdog !== null) {
      this.cancelTimeout(this.finalizeWatchdog);
      this.finalizeWatchdog = null;
    }
  }

  private clearRecordingWatchdog(): void {
    if (this.recordingWatchdog !== null) {
      this.cancelTimeout(this.recordingWatchdog);
      this.recordingWatchdog = null;
    }
  }
}

function snapshot(
  status: CalibrationClipStatus,
  stage: CalibrationClipStage | null = null,
  url: string | null = null,
): CalibrationClipSnapshot {
  return Object.freeze({ stage, status, url });
}

export { CLIP_TIMESLICE_MS, FINALIZE_TIMEOUT_MS, MAX_CLIP_BYTES, MAX_RECORDING_DURATION_MS };
