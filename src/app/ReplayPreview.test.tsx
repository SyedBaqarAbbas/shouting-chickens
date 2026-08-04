import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RunSummary } from "../core";
import type { RecordedReplay } from "../platform/recording";
import { ReplayPreview } from "./ReplayPreview";

const SUMMARY: RunSummary = {
  distance: 500,
  gameplayVersion: "sho-22",
  reason: "water",
  runId: 1,
  score: 600,
  scoreBreakdown: {
    collectibles: 100,
    precision: 50,
    survival: 450,
    total: 600,
  },
  seed: "test-seed",
  statistics: {
    collectibles: 2,
    distance: 500,
    highestDifficultyStage: 2,
    longestLiftMs: 800,
    obstaclesCleared: 2,
    precisionLandings: 1,
  },
  survivalMs: 8000,
};

const REPLAY: RecordedReplay = {
  blob: new Blob(["fake-video"], { type: "video/webm" }),
  durationMs: 8000,
  mimeType: "video/webm",
  objectUrl: "blob:http://localhost/fake-video-url",
};

describe("ReplayPreview", () => {
  it("renders video preview player when replay blob is available", () => {
    render(<ReplayPreview summary={SUMMARY} replay={REPLAY} />);

    expect(screen.getByTestId("replay-preview-video")).toBeInTheDocument();
    expect(screen.getByLabelText("Share replay video")).toBeInTheDocument();
    expect(screen.getByLabelText("Download replay video")).toBeInTheDocument();
    expect(screen.getByLabelText("Delete replay video")).toBeInTheDocument();
  });

  it("renders static score card fallback when replay is null", () => {
    render(<ReplayPreview summary={SUMMARY} replay={null} />);

    expect(screen.queryByTestId("replay-preview-video")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Share score card image")).toBeInTheDocument();
    expect(screen.getByLabelText("Download score card image")).toBeInTheDocument();
  });

  it("invokes onDeleteReplay callback when delete button is clicked", () => {
    const onDeleteReplay = vi.fn();
    render(<ReplayPreview summary={SUMMARY} replay={REPLAY} onDeleteReplay={onDeleteReplay} />);

    fireEvent.click(screen.getByLabelText("Delete replay video"));
    expect(onDeleteReplay).toHaveBeenCalledTimes(1);
  });
});
