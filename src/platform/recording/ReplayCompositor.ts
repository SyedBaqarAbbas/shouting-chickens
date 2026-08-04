export const COMPOSITOR_WIDTH = 720;
export const COMPOSITOR_HEIGHT = 1280;
export const COMPOSITOR_FPS = 30;

export type HudSnapshot = {
  readonly elapsedMs: number;
  readonly level: number;
  readonly score: number;
};

export interface ReplayCompositorOptions {
  readonly cameraVideoElement?: HTMLVideoElement | null;
  readonly fps?: number;
  readonly getHudSnapshot?: () => HudSnapshot | null;
  readonly phaserCanvasElement?: HTMLCanvasElement | null;
}

export class ReplayCompositor {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly fps: number;
  private cameraVideoElement: HTMLVideoElement | null;
  private phaserCanvasElement: HTMLCanvasElement | null;
  private getHudSnapshot: () => HudSnapshot | null;
  private animationFrameId: number | null = null;
  private running = false;
  private lastRenderMs = 0;

  constructor(options: ReplayCompositorOptions = {}) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = COMPOSITOR_WIDTH;
    this.canvas.height = COMPOSITOR_HEIGHT;
    this.ctx = this.canvas.getContext("2d");
    this.fps = options.fps ?? COMPOSITOR_FPS;
    this.cameraVideoElement = options.cameraVideoElement ?? null;
    this.phaserCanvasElement = options.phaserCanvasElement ?? null;
    this.getHudSnapshot = options.getHudSnapshot ?? (() => null);
  }

  updateSources(options: Partial<ReplayCompositorOptions>): void {
    if (options.cameraVideoElement !== undefined) {
      this.cameraVideoElement = options.cameraVideoElement;
    }
    if (options.phaserCanvasElement !== undefined) {
      this.phaserCanvasElement = options.phaserCanvasElement;
    }
    if (options.getHudSnapshot !== undefined) {
      this.getHudSnapshot = options.getHudSnapshot;
    }
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastRenderMs = performance.now();
    this.scheduleNextFrame();
  }

  stop(): void {
    this.running = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  getStream(): MediaStream | null {
    if (typeof this.canvas.captureStream === "function") {
      return this.canvas.captureStream(this.fps);
    }
    return null;
  }

  renderFrame(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, COMPOSITOR_WIDTH, COMPOSITOR_HEIGHT);

    // 1. Camera background or styled dark gradient
    let cameraDrawn = false;
    const video = this.cameraVideoElement;
    if (
      video &&
      video.readyState >= 2 &&
      !video.paused &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
    ) {
      ctx.save();
      // Mirror camera horizontally
      ctx.translate(COMPOSITOR_WIDTH, 0);
      ctx.scale(-1, 1);

      // Cover-fit camera into 720x1280
      const scale = Math.max(
        COMPOSITOR_WIDTH / video.videoWidth,
        COMPOSITOR_HEIGHT / video.videoHeight,
      );
      const drawW = video.videoWidth * scale;
      const drawH = video.videoHeight * scale;
      const drawX = (COMPOSITOR_WIDTH - drawW) / 2;
      const drawY = (COMPOSITOR_HEIGHT - drawH) / 2;

      ctx.drawImage(video, drawX, drawY, drawW, drawH);
      ctx.restore();
      cameraDrawn = true;
    }

    if (!cameraDrawn) {
      const bgGrad = ctx.createLinearGradient(0, 0, 0, COMPOSITOR_HEIGHT);
      bgGrad.addColorStop(0, "#0f172a");
      bgGrad.addColorStop(1, "#1e293b");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, COMPOSITOR_WIDTH, COMPOSITOR_HEIGHT);
    }

    // 2. Phaser Game Canvas Layer
    const phaserCanvas = this.phaserCanvasElement;
    if (phaserCanvas && phaserCanvas.width > 0 && phaserCanvas.height > 0) {
      ctx.drawImage(phaserCanvas, 0, 0, COMPOSITOR_WIDTH, COMPOSITOR_HEIGHT);
    }

    // 3. In-Run HUD Overlay
    const hud = this.getHudSnapshot();
    if (hud) {
      ctx.save();
      // Top bar background gradient
      ctx.fillStyle = "rgba(15, 23, 42, 0.75)";
      ctx.fillRect(0, 0, COMPOSITOR_WIDTH, 80);

      // Score
      ctx.fillStyle = "#f4ce64";
      ctx.font = "bold 32px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(`SCORE: ${hud.score.toLocaleString()}`, 24, 52);

      // Survival Time
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 28px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(`${(hud.elapsedMs / 1000).toFixed(1)}s`, COMPOSITOR_WIDTH - 24, 52);

      // Watermark badge
      ctx.fillStyle = "rgba(56, 189, 248, 0.9)";
      ctx.font = "bold 16px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("SHOUTING CHICKENS REPLAY", COMPOSITOR_WIDTH / 2, 1250);

      ctx.restore();
    }
  }

  destroy(): void {
    this.stop();
    this.cameraVideoElement = null;
    this.phaserCanvasElement = null;
    this.getHudSnapshot = () => null;
  }

  private scheduleNextFrame(): void {
    if (!this.running) {
      return;
    }

    const intervalMs = 1000 / this.fps;
    const loop = (now: number) => {
      if (!this.running) {
        return;
      }
      if (now - this.lastRenderMs >= intervalMs - 2) {
        this.lastRenderMs = now;
        this.renderFrame();
      }
      this.animationFrameId = requestAnimationFrame(loop);
    };

    this.animationFrameId = requestAnimationFrame(loop);
  }
}
