export const REPLAY_MAX_DURATION_MS = 15_000;

export const CANDIDATE_MIME_TYPES: readonly string[] = Object.freeze([
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4;codecs=avc1",
  "video/mp4",
]);

export function selectSupportedReplayMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") {
    return null;
  }
  for (const type of CANDIDATE_MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    } catch {
      // Continue checking candidates
    }
  }
  return "";
}

export function isReplaySupported(): boolean {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof HTMLCanvasElement === "undefined" ||
    typeof HTMLCanvasElement.prototype.captureStream !== "function"
  ) {
    return false;
  }
  const mimeType = selectSupportedReplayMimeType();
  return mimeType !== null;
}

export type TimestampedChunk = {
  readonly blob: Blob;
  readonly timestampMs: number;
};

export type RecordedReplay = {
  readonly blob: Blob;
  readonly durationMs: number;
  readonly mimeType: string;
  readonly objectUrl: string;
};

export class ReplayRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: TimestampedChunk[] = [];
  private mimeType: string | null = null;
  private recording = false;
  private startTimeMs = 0;
  private currentObjectUrl: string | null = null;
  private currentBlob: Blob | null = null;

  get currentRecordedBlob(): Blob | null {
    return this.currentBlob;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  get retainedChunksCount(): number {
    return this.chunks.length;
  }

  start(stream: MediaStream, timesliceMs = 1_000): boolean {
    if (!isReplaySupported()) {
      return false;
    }

    this.dispose();

    const selectedMimeType = selectSupportedReplayMimeType();
    if (selectedMimeType === null) {
      return false;
    }

    try {
      const options: MediaRecorderOptions = {};
      if (selectedMimeType !== "") {
        options.mimeType = selectedMimeType;
      }

      const recorder = new MediaRecorder(stream, options);
      this.mimeType = recorder.mimeType || selectedMimeType;
      this.mediaRecorder = recorder;
      this.chunks = [];
      this.startTimeMs = performance.now();
      this.recording = true;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          const now = performance.now();
          this.chunks.push({ blob: event.data, timestampMs: now });
          this.pruneChunks(now);
        }
      };

      recorder.start(timesliceMs);
      return true;
    } catch {
      this.recording = false;
      this.mediaRecorder = null;
      return false;
    }
  }

  pruneChunks(nowMs: number, maxDurationMs = REPLAY_MAX_DURATION_MS): void {
    const cutoff = nowMs - maxDurationMs;
    // Retain chunks that overlap with the 15-second window
    let firstKeepIndex = 0;
    for (let index = 0; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      if (chunk && chunk.timestampMs >= cutoff) {
        // Keep one previous chunk if available to preserve keyframe boundary context
        firstKeepIndex = Math.max(0, index - 1);
        break;
      }
    }
    if (firstKeepIndex > 0) {
      this.chunks = this.chunks.slice(firstKeepIndex);
    }
  }

  async stop(): Promise<RecordedReplay | null> {
    if (!this.recording || !this.mediaRecorder) {
      return null;
    }

    this.recording = false;
    const recorder = this.mediaRecorder;
    const stopTimeMs = performance.now();

    return new Promise<RecordedReplay | null>((resolve) => {
      recorder.onstop = () => {
        this.pruneChunks(stopTimeMs);
        if (this.chunks.length === 0) {
          resolve(null);
          return;
        }

        const mimeType = this.mimeType || "video/webm";
        const blobParts = this.chunks.map((chunk) => chunk.blob);
        const blob = new Blob(blobParts, { type: mimeType });
        const objectUrl = URL.createObjectURL(blob);
        this.currentBlob = blob;
        this.currentObjectUrl = objectUrl;

        const durationMs = Math.min(
          REPLAY_MAX_DURATION_MS,
          Math.max(0, stopTimeMs - this.startTimeMs),
        );

        resolve({
          blob,
          durationMs,
          mimeType,
          objectUrl,
        });
      };

      try {
        if (recorder.state !== "inactive") {
          recorder.stop();
        } else if (typeof recorder.onstop === "function") {
          recorder.onstop(new Event("stop"));
        }
      } catch {
        resolve(null);
      }
    });
  }

  dispose(): void {
    this.recording = false;
    if (this.mediaRecorder) {
      try {
        if (this.mediaRecorder.state !== "inactive") {
          this.mediaRecorder.stop();
        }
      } catch {
        // Ignore stop errors during dispose
      }
      this.mediaRecorder = null;
    }

    if (this.currentObjectUrl) {
      try {
        URL.revokeObjectURL(this.currentObjectUrl);
      } catch {
        // Ignore revocation errors
      }
      this.currentObjectUrl = null;
    }

    this.currentBlob = null;
    this.chunks = [];
    this.mimeType = null;
  }
}
