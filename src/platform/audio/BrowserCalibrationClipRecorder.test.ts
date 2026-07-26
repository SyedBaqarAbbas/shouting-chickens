import { describe, expect, it, vi } from "vitest";

import type { BrowserMediaSession } from "../media";
import {
  BrowserCalibrationClipRecorder,
  CLIP_TIMESLICE_MS,
  FINALIZE_TIMEOUT_MS,
  MAX_RECORDING_DURATION_MS,
} from "./BrowserCalibrationClipRecorder";

class FakeMediaRecorder extends EventTarget {
  readonly mimeType = "audio/test";
  state: RecordingState = "inactive";
  timeslice: number | undefined;

  constructor(private readonly emitStopEvent = true) {
    super();
  }

  start(timeslice?: number) {
    this.state = "recording";
    this.timeslice = timeslice;
  }

  stop() {
    this.state = "inactive";
    if (this.emitStopEvent) {
      this.completeStop();
    }
  }

  emitData(blob: Blob) {
    const event = new Event("dataavailable") as Event & { data: Blob };
    Object.defineProperty(event, "data", { value: blob });
    this.dispatchEvent(event);
  }

  completeStop() {
    this.dispatchEvent(new Event("stop"));
  }
}

function createHarness(options: { emitStopEvent?: boolean } = {}) {
  const stream = {} as MediaStream;
  const recorders: FakeMediaRecorder[] = [];
  const createMediaRecorder = vi.fn(() => {
    const recorder = new FakeMediaRecorder(options.emitStopEvent);
    recorders.push(recorder);
    return recorder as unknown as MediaRecorder;
  });
  const createObjectURL = vi.fn(() => `blob:clip-${recorders.length}`);
  const revokeObjectURL = vi.fn();
  const session = {
    getMicrophoneAudioGraph: () => ({
      context: {} as AudioContext,
      source: {} as MediaStreamAudioSourceNode,
      stream,
    }),
  } as BrowserMediaSession;
  const recorder = new BrowserCalibrationClipRecorder(session, {
    createMediaRecorder,
    createObjectURL,
    revokeObjectURL,
  });

  return {
    createMediaRecorder,
    createObjectURL,
    recorder,
    recorders,
    revokeObjectURL,
    stream,
  };
}

describe("BrowserCalibrationClipRecorder", () => {
  it("records from the existing microphone stream and exposes only an object URL", () => {
    const harness = createHarness();
    const listener = vi.fn();
    harness.recorder.subscribe(listener);

    harness.recorder.beginStage("normal");
    expect(harness.createMediaRecorder).toHaveBeenCalledWith(harness.stream);
    expect(harness.recorders[0]!.timeslice).toBe(CLIP_TIMESLICE_MS);
    expect(harness.recorder.getSnapshot()).toEqual({
      stage: "normal",
      status: "recording",
      url: null,
    });

    harness.recorders[0]!.emitData(new Blob(["voice"], { type: "audio/test" }));
    harness.recorder.finishStage();

    expect(harness.createObjectURL).toHaveBeenCalledOnce();
    expect(harness.recorder.getSnapshot()).toEqual({
      stage: "normal",
      status: "ready",
      url: "blob:clip-1",
    });
    expect(listener).toHaveBeenCalled();
  });

  it("revokes the previous clip when another stage starts or capture stops", () => {
    const harness = createHarness();

    harness.recorder.beginStage("normal");
    harness.recorders[0]!.emitData(new Blob(["normal"]));
    harness.recorder.finishStage();
    harness.recorder.beginStage("loud");

    expect(harness.revokeObjectURL).toHaveBeenCalledWith("blob:clip-1");
    harness.recorders[1]!.emitData(new Blob(["loud"]));
    harness.recorder.finishStage();
    harness.recorder.stop();
    harness.recorder.stop();

    expect(harness.revokeObjectURL).toHaveBeenLastCalledWith("blob:clip-2");
    expect(harness.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(harness.recorder.getSnapshot()).toEqual({
      stage: null,
      status: "idle",
      url: null,
    });
  });

  it("degrades to unavailable when recording support or an active stream is absent", () => {
    const recorder = new BrowserCalibrationClipRecorder({} as BrowserMediaSession, {
      createMediaRecorder: undefined,
      createObjectURL: vi.fn(),
      revokeObjectURL: vi.fn(),
    });

    recorder.beginStage("normal");

    expect(recorder.getSnapshot()).toEqual({
      stage: "normal",
      status: "unavailable",
      url: null,
    });
  });

  it("rejects an oversized in-memory clip without creating a URL", () => {
    const harness = createHarness();
    harness.recorder.beginStage("normal");

    harness.recorders[0]!.emitData(new Blob([new Uint8Array(2 * 1024 * 1024 + 1)]));

    expect(harness.createObjectURL).not.toHaveBeenCalled();
    expect(harness.recorder.getSnapshot()).toEqual({
      stage: "normal",
      status: "failed",
      url: null,
    });
  });

  it("bounds a recording even when MediaRecorder never delivers data", () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ emitStopEvent: false });
      harness.recorder.beginStage("normal");

      vi.advanceTimersByTime(MAX_RECORDING_DURATION_MS - 1);
      expect(harness.recorder.getSnapshot().status).toBe("recording");
      vi.advanceTimersByTime(1);

      expect(harness.recorders[0]!.state).toBe("inactive");
      expect(harness.recorder.getSnapshot()).toEqual({
        stage: "normal",
        status: "failed",
        url: null,
      });

      harness.recorders[0]!.completeStop();
      expect(harness.createObjectURL).not.toHaveBeenCalled();
      expect(harness.recorder.getSnapshot().status).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes playback nonblocking when MediaRecorder never emits its stop event", () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ emitStopEvent: false });
      harness.recorder.beginStage("loud");
      harness.recorders[0]!.emitData(new Blob(["voice"]));
      harness.recorder.finishStage();

      vi.advanceTimersByTime(FINALIZE_TIMEOUT_MS - 1);
      expect(harness.recorder.getSnapshot().status).toBe("processing");
      vi.advanceTimersByTime(1);

      expect(harness.recorder.getSnapshot()).toEqual({
        stage: "loud",
        status: "failed",
        url: null,
      });

      harness.recorders[0]!.completeStop();
      expect(harness.createObjectURL).not.toHaveBeenCalled();
      expect(harness.recorder.getSnapshot().status).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });
});

type RecordingState = "inactive" | "recording" | "paused";
