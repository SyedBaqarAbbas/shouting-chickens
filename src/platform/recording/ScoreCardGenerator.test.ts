import { describe, expect, it } from "vitest";
import type { RunSummary } from "../../core";
import {
  SCORE_CARD_HEIGHT,
  SCORE_CARD_WIDTH,
  generateScoreCardBlob,
  renderScoreCardToCanvas,
} from "./ScoreCardGenerator";

const SUMMARY: RunSummary = {
  distance: 850,
  gameplayVersion: "sho-22",
  reason: "hazard",
  runId: 1,
  score: 1250,
  scoreBreakdown: {
    collectibles: 200,
    precision: 150,
    survival: 900,
    total: 1250,
  },
  seed: "test-seed",
  statistics: {
    collectibles: 4,
    distance: 850,
    highestDifficultyStage: 3,
    longestLiftMs: 1200,
    obstaclesCleared: 5,
    precisionLandings: 3,
  },
  survivalMs: 15000,
};

describe("ScoreCardGenerator", () => {
  it("renders a 720x1280 canvas with run summary metrics", () => {
    const canvas = renderScoreCardToCanvas(SUMMARY);
    expect(canvas.width).toBe(SCORE_CARD_WIDTH);
    expect(canvas.height).toBe(SCORE_CARD_HEIGHT);
  });

  it("exports a non-empty image/png blob", async () => {
    // Mock toBlob if needed in jsdom
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type) {
      callback(new Blob(["fake-image-png"], { type: type || "image/png" }));
    };

    try {
      const blob = await generateScoreCardBlob(SUMMARY);
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe("image/png");
    } finally {
      HTMLCanvasElement.prototype.toBlob = origToBlob;
    }
  });
});
