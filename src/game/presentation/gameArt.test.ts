import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GAME_ART_ATLAS_BUDGET_BYTES,
  GAME_ART_ATLAS_HEIGHT,
  GAME_ART_ATLAS_PATH,
  GAME_ART_ATLAS_WIDTH,
  GAME_ART_FRAME_BUDGET,
  GAME_ART_FRAMES,
  GAME_ART_FRAME_RECTS,
  ORIGINAL_ASSET_RECORDS,
  gameArtAtlasUrl,
  selectChickenArtFrame,
} from "./gameArt";

describe("original game art", () => {
  it("assigns a distinct, bounded frame to every animation state", () => {
    expect(selectChickenArtFrame("idle", 0, false)).toBe("chicken-idle");
    expect(selectChickenArtFrame("run", 0, false)).toBe("chicken-run-a");
    expect(selectChickenArtFrame("run", 7, false)).toBe("chicken-run-b");
    expect(selectChickenArtFrame("jump", 0, false)).toBe("chicken-jump");
    expect(selectChickenArtFrame("flap", 0, false)).toBe("chicken-flap-a");
    expect(selectChickenArtFrame("flap", 5, false)).toBe("chicken-flap-b");
    expect(selectChickenArtFrame("death", 0, false)).toBe("chicken-death");

    expect(new Set(GAME_ART_FRAMES).size).toBe(GAME_ART_FRAMES.length);
    expect(GAME_ART_FRAMES).toHaveLength(GAME_ART_FRAME_BUDGET);
    for (const frame of GAME_ART_FRAME_RECTS) {
      expect(frame.x + frame.width).toBeLessThanOrEqual(GAME_ART_ATLAS_WIDTH);
      expect(frame.y + frame.height).toBeLessThanOrEqual(GAME_ART_ATLAS_HEIGHT);
    }
  });

  it("freezes animated poses to one readable frame in reduced motion", () => {
    expect(selectChickenArtFrame("run", 0, true)).toBe(selectChickenArtFrame("run", 1_000, true));
    expect(selectChickenArtFrame("flap", 0, true)).toBe(selectChickenArtFrame("flap", 1_000, true));
  });

  it("keeps the single Pages-relative vector atlas inside its compressed load budget", async () => {
    const bytes = await readFile(resolve(process.cwd(), "public", GAME_ART_ATLAS_PATH));
    const text = bytes.toString("utf8");

    expect(bytes.byteLength).toBeLessThanOrEqual(GAME_ART_ATLAS_BUDGET_BYTES);
    expect(text).toContain(`viewBox="0 0 ${GAME_ART_ATLAS_WIDTH} ${GAME_ART_ATLAS_HEIGHT}"`);
    expect(text).not.toMatch(/<image\b|data:image|tiktok|watermark|logo/i);
    expect(gameArtAtlasUrl("./", "https://example.test/shouting-chickens/")).toBe(
      "https://example.test/shouting-chickens/assets/shouting-chickens-atlas.svg",
    );
  });

  it("documents origin and a compatible license for every asset source", () => {
    expect(ORIGINAL_ASSET_RECORDS).toHaveLength(GAME_ART_FRAMES.length + 4);
    for (const record of ORIGINAL_ASSET_RECORDS) {
      expect(record.origin).toContain("Original");
      expect(record.license).toBe("Apache-2.0");
      expect(record.path).not.toMatch(/image[123]|reference|capture|recording/i);
      expect(record.component).toBeTruthy();
    }
  });
});
