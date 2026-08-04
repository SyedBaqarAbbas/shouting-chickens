import { useCallback, useState } from "react";
import type { RunSummary } from "../core";
import {
  downloadBlob,
  generateScoreCardBlob,
  shareBlob,
  type RecordedReplay,
} from "../platform/recording";

export interface ReplayPreviewProps {
  readonly onDeleteReplay?: () => void;
  readonly onLiveStatusChange?: (status: string) => void;
  readonly replay: RecordedReplay | null;
  readonly summary: RunSummary;
}

export function ReplayPreview({
  onDeleteReplay,
  onLiveStatusChange,
  replay,
  summary,
}: ReplayPreviewProps) {
  const [sharing, setSharing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState("");

  const handleShareReplay = useCallback(async () => {
    if (!replay) {
      return;
    }
    setSharing(true);
    setNotice("");
    const ext = replay.mimeType.includes("mp4") ? "mp4" : "webm";
    const filename = `shouting-chickens-replay.${ext}`;
    const title = "Shouting Chickens Replay";
    const text = `I scored ${summary.score} points on Shouting Chickens!`;

    const success = await shareBlob(replay.blob, filename, title, text);
    setSharing(false);

    if (success) {
      const msg = "Replay shared successfully!";
      setNotice(msg);
      onLiveStatusChange?.(msg);
    } else {
      downloadBlob(replay.blob, filename);
      const msg = "Web Share unavailable; replay downloaded instead.";
      setNotice(msg);
      onLiveStatusChange?.(msg);
    }
  }, [onLiveStatusChange, replay, summary.score]);

  const handleDownloadReplay = useCallback(() => {
    if (!replay) {
      return;
    }
    setDownloading(true);
    const ext = replay.mimeType.includes("mp4") ? "mp4" : "webm";
    const filename = `shouting-chickens-replay.${ext}`;
    downloadBlob(replay.blob, filename);
    setDownloading(false);
    const msg = "Replay download started.";
    setNotice(msg);
    onLiveStatusChange?.(msg);
  }, [onLiveStatusChange, replay]);

  const handleDeleteReplay = useCallback(() => {
    onDeleteReplay?.();
    const msg = "Replay deleted and memory freed.";
    setNotice(msg);
    onLiveStatusChange?.(msg);
  }, [onDeleteReplay, onLiveStatusChange]);

  const handleShareScoreCard = useCallback(async () => {
    setSharing(true);
    setNotice("");
    try {
      const blob = await generateScoreCardBlob(summary);
      const filename = `shouting-chickens-scorecard-${summary.runId}.png`;
      const title = "Shouting Chickens Score Card";
      const text = `I scored ${summary.score} points on Shouting Chickens!`;

      const success = await shareBlob(blob, filename, title, text);
      setSharing(false);

      if (success) {
        const msg = "Score card shared successfully!";
        setNotice(msg);
        onLiveStatusChange?.(msg);
      } else {
        downloadBlob(blob, filename);
        const msg = "Web Share unavailable; score card downloaded instead.";
        setNotice(msg);
        onLiveStatusChange?.(msg);
      }
    } catch {
      setSharing(false);
      const msg = "Failed to generate score card image.";
      setNotice(msg);
      onLiveStatusChange?.(msg);
    }
  }, [onLiveStatusChange, summary]);

  const handleDownloadScoreCard = useCallback(async () => {
    setDownloading(true);
    setNotice("");
    try {
      const blob = await generateScoreCardBlob(summary);
      const filename = `shouting-chickens-scorecard-${summary.runId}.png`;
      downloadBlob(blob, filename);
      setDownloading(false);
      const msg = "Score card download started.";
      setNotice(msg);
      onLiveStatusChange?.(msg);
    } catch {
      setDownloading(false);
      const msg = "Failed to generate score card image.";
      setNotice(msg);
      onLiveStatusChange?.(msg);
    }
  }, [onLiveStatusChange, summary]);

  return (
    <section className="replay-section" aria-label="Run replay and score export">
      <div className="replay-card">
        <h3 className="replay-card__title">
          {replay ? "Run Replay (15s Local Capture)" : "Run Score Card"}
        </h3>

        {replay ? (
          <div className="replay-preview-container">
            <video
              className="replay-video-player"
              data-testid="replay-preview-video"
              src={replay.objectUrl}
              controls
              playsInline
              autoPlay
              loop
              aria-label="Preview of final 15 seconds of run"
            />
            <p className="replay-privacy-note">
              This 15s replay is held only in your browser memory and will be erased when deleted or
              restarted.
            </p>
            <div className="replay-actions">
              <button
                className="action-button action-button--primary"
                type="button"
                aria-label="Share replay video"
                disabled={sharing}
                onClick={handleShareReplay}
              >
                {sharing ? "Sharing…" : "Share replay"}
              </button>
              <button
                className="action-button action-button--secondary"
                type="button"
                aria-label="Download replay video"
                disabled={downloading}
                onClick={handleDownloadReplay}
              >
                Download replay
              </button>
              <button
                className="action-button action-button--danger"
                type="button"
                aria-label="Delete replay video"
                onClick={handleDeleteReplay}
              >
                Delete replay
              </button>
            </div>
          </div>
        ) : (
          <div className="scorecard-fallback-container">
            <p className="scorecard-fallback-note">
              Replay video was not captured or was deleted. You can share or download a static score
              card image of your flight summary.
            </p>
            <div className="replay-actions">
              <button
                className="action-button action-button--primary"
                type="button"
                aria-label="Share score card image"
                disabled={sharing}
                onClick={handleShareScoreCard}
              >
                {sharing ? "Sharing…" : "Share score card"}
              </button>
              <button
                className="action-button action-button--secondary"
                type="button"
                aria-label="Download score card image"
                disabled={downloading}
                onClick={handleDownloadScoreCard}
              >
                Download score card
              </button>
            </div>
          </div>
        )}

        {notice ? (
          <p className="replay-notice" role="status" aria-live="polite">
            {notice}
          </p>
        ) : null}
      </div>
    </section>
  );
}
