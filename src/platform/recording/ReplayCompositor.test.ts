import { describe, expect, it, vi } from "vitest";
import { COMPOSITOR_HEIGHT, COMPOSITOR_WIDTH, ReplayCompositor } from "./ReplayCompositor";

function createMockContext2D(): CanvasRenderingContext2D {
  return {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    createLinearGradient: vi.fn(() => ({
      addColorStop: vi.fn(),
    })),
    drawImage: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    restore: vi.fn(),
    roundRect: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    translate: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe("ReplayCompositor", () => {
  it("initializes canvas with 720x1280 dimensions", () => {
    const compositor = new ReplayCompositor();
    expect(compositor.canvas.width).toBe(COMPOSITOR_WIDTH);
    expect(compositor.canvas.height).toBe(COMPOSITOR_HEIGHT);
  });

  it("renders frame without error when no video or game surface is attached", () => {
    const compositor = new ReplayCompositor();
    expect(() => compositor.renderFrame()).not.toThrow();
  });

  it("draws HUD overlay when getHudSnapshot returns data", () => {
    const getHudSnapshot = vi.fn(() => ({
      elapsedMs: 15_200,
      level: 0.65,
      score: 1_250,
    }));

    const compositor = new ReplayCompositor({ getHudSnapshot });
    (compositor as unknown as { ctx: CanvasRenderingContext2D }).ctx = createMockContext2D();

    compositor.renderFrame();

    expect(getHudSnapshot).toHaveBeenCalled();
  });

  it("cleans up resources on destroy", () => {
    const compositor = new ReplayCompositor();
    compositor.start();
    compositor.destroy();

    expect(() => compositor.renderFrame()).not.toThrow();
  });
});
