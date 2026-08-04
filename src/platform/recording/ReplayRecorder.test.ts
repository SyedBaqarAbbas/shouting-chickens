import { describe, expect, it, vi } from "vitest";
import {
  REPLAY_MAX_DURATION_MS,
  ReplayRecorder,
  isReplaySupported,
  selectSupportedReplayMimeType,
} from "./ReplayRecorder";

describe("ReplayRecorder", () => {
  it("negotiates supported mimeTypes and detects browser capability", () => {
    expect(isReplaySupported()).toBe(false); // In node/jsdom without MediaRecorder mock

    const originalMediaRecorder = global.MediaRecorder;
    const originalCaptureStream = HTMLCanvasElement.prototype.captureStream;
    try {
      // Mock MediaRecorder and HTMLCanvasElement.prototype.captureStream
      const mockMediaRecorder = vi.fn() as unknown as typeof MediaRecorder;
      mockMediaRecorder.isTypeSupported = vi.fn((type: string) => type === "video/webm;codecs=vp8");
      global.MediaRecorder = mockMediaRecorder;
      HTMLCanvasElement.prototype.captureStream = vi.fn(
        () => new MediaStream(),
      ) as unknown as typeof HTMLCanvasElement.prototype.captureStream;

      expect(selectSupportedReplayMimeType()).toBe("video/webm;codecs=vp8");
      expect(isReplaySupported()).toBe(true);
    } finally {
      global.MediaRecorder = originalMediaRecorder;
      HTMLCanvasElement.prototype.captureStream = originalCaptureStream;
    }
  });

  it("bounds retained chunks to the final 15 seconds", () => {
    const recorder = new ReplayRecorder();
    const now = 20_000;

    // Simulate 20 1-second chunks (from t = 1000 to 20000)
    for (let i = 1; i <= 20; i += 1) {
      const timestampMs = i * 1_000;
      const chunk = new Blob([`chunk-${i}`], { type: "video/webm" });
      (recorder as unknown as { chunks: { blob: Blob; timestampMs: number }[] }).chunks.push({
        blob: chunk,
        timestampMs,
      });
    }

    expect(recorder.retainedChunksCount).toBe(20);
    recorder.pruneChunks(now, REPLAY_MAX_DURATION_MS); // Cutoff = 20000 - 15000 = 5000ms

    // Should drop chunks before cutoff (t < 5000), retaining chunks from t = 4000 (keyframe overlap) onwards
    const retained = (recorder as unknown as { chunks: { blob: Blob; timestampMs: number }[] })
      .chunks;
    expect(retained.every((c) => c.timestampMs >= 4_000)).toBe(true);
    expect(retained.length).toBeLessThan(20);
  });

  it("revokes object URLs and releases resources on dispose", () => {
    const recorder = new ReplayRecorder();
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    (recorder as unknown as { currentObjectUrl: string | null }).currentObjectUrl =
      "blob:test-replay-url";

    recorder.dispose();

    expect(revokeSpy).toHaveBeenCalledWith("blob:test-replay-url");
    expect(recorder.isRecording).toBe(false);
    expect(recorder.retainedChunksCount).toBe(0);

    revokeSpy.mockRestore();
  });
});
