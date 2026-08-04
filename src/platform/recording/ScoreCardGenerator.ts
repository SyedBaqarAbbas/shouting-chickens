import type { RunSummary } from "../../core";

export const SCORE_CARD_WIDTH = 720;
export const SCORE_CARD_HEIGHT = 1280;

export function renderScoreCardToCanvas(
  summary: RunSummary,
  targetCanvas?: HTMLCanvasElement,
): HTMLCanvasElement {
  const canvas = targetCanvas ?? document.createElement("canvas");
  canvas.width = SCORE_CARD_WIDTH;
  canvas.height = SCORE_CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }

  // Background gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, SCORE_CARD_HEIGHT);
  bgGrad.addColorStop(0, "#0f172a");
  bgGrad.addColorStop(0.5, "#1e293b");
  bgGrad.addColorStop(1, "#0f172a");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, SCORE_CARD_WIDTH, SCORE_CARD_HEIGHT);

  // Decorative border
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 8;
  ctx.strokeRect(20, 20, SCORE_CARD_WIDTH - 40, SCORE_CARD_HEIGHT - 40);

  // Inner frame
  ctx.strokeStyle = "rgba(244, 206, 100, 0.4)";
  ctx.lineWidth = 2;
  ctx.strokeRect(32, 32, SCORE_CARD_WIDTH - 64, SCORE_CARD_HEIGHT - 64);

  // Title Eyebrow
  ctx.fillStyle = "#38bdf8";
  ctx.font = "bold 24px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("SHOUTING CHICKENS", SCORE_CARD_WIDTH / 2, 110);

  // Main Heading
  ctx.fillStyle = "#f4ce64";
  ctx.font = "900 48px system-ui, -apple-system, sans-serif";
  const outcomeText = summary.reason === "quit" ? "RUN SUMMARY" : "NICE FLIGHT!";
  ctx.fillText(outcomeText, SCORE_CARD_WIDTH / 2, 170);

  // Score Badge Circle
  ctx.fillStyle = "rgba(30, 41, 59, 0.8)";
  ctx.beginPath();
  ctx.arc(SCORE_CARD_WIDTH / 2, 340, 120, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#f4ce64";
  ctx.lineWidth = 6;
  ctx.stroke();

  ctx.fillStyle = "#94a3b8";
  ctx.font = "bold 20px system-ui, -apple-system, sans-serif";
  ctx.fillText("TOTAL SCORE", SCORE_CARD_WIDTH / 2, 280);

  ctx.fillStyle = "#ffffff";
  ctx.font = "900 64px system-ui, -apple-system, sans-serif";
  ctx.fillText(summary.score.toLocaleString(), SCORE_CARD_WIDTH / 2, 360);

  // Breakdown Card
  const cardX = 60;
  const cardY = 510;
  const cardWidth = SCORE_CARD_WIDTH - 120;
  const cardHeight = 540;

  ctx.fillStyle = "rgba(15, 23, 42, 0.7)";
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardWidth, cardHeight, 16);
  ctx.fill();
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Score Breakdown Header
  ctx.fillStyle = "#38bdf8";
  ctx.font = "bold 28px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("SCORE BREAKDOWN", cardX + 32, cardY + 60);

  const lines = [
    {
      label: "Survival Time",
      detail: `${(summary.survivalMs / 1000).toFixed(1)}s`,
      pts: `+${summary.scoreBreakdown.survival} pts`,
    },
    {
      label: "Collectibles",
      detail: `${summary.statistics.collectibles} feathers`,
      pts: `+${summary.scoreBreakdown.collectibles} pts`,
    },
    {
      label: "Precision Landings",
      detail: `${summary.statistics.precisionLandings} landings`,
      pts: `+${summary.scoreBreakdown.precision} pts`,
    },
    {
      label: "Distance Traveled",
      detail: `${Math.round(summary.distance)} px`,
      pts: `Stage ${summary.statistics.highestDifficultyStage}`,
    },
    {
      label: "End Reason",
      detail: summary.reason,
      pts: "",
    },
  ];

  let currentY = cardY + 130;
  lines.forEach((line, index) => {
    if (index > 0) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cardX + 32, currentY - 30);
      ctx.lineTo(cardX + cardWidth - 32, currentY - 30);
      ctx.stroke();
    }

    ctx.fillStyle = "#94a3b8";
    ctx.font = "500 22px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(line.label, cardX + 32, currentY);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 22px system-ui, -apple-system, sans-serif";
    ctx.fillText(line.detail, cardX + 240, currentY);

    if (line.pts) {
      ctx.fillStyle = "#f4ce64";
      ctx.textAlign = "right";
      ctx.fillText(line.pts, cardX + cardWidth - 32, currentY);
    }
    currentY += 80;
  });

  // Footer text
  ctx.fillStyle = "#64748b";
  ctx.font = "18px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Local-first score card · Private & On-device", SCORE_CARD_WIDTH / 2, 1180);

  return canvas;
}

export function generateScoreCardBlob(summary: RunSummary): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    try {
      const canvas = renderScoreCardToCanvas(summary);
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Failed to export score card blob"));
        }
      }, "image/png");
    } catch (error) {
      reject(error);
    }
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function shareBlob(
  blob: Blob,
  filename: string,
  title: string,
  text: string,
): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.share) {
    return false;
  }

  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && !navigator.canShare({ files: [file] })) {
    return false;
  }

  try {
    await navigator.share({
      files: [file],
      text,
      title,
    });
    return true;
  } catch (error) {
    if ((error as DOMException)?.name === "AbortError") {
      return true;
    }
    return false;
  }
}
