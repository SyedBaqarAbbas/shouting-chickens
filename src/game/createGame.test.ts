import { describe, expect, it } from "vitest";

import { getCappedRenderResolution } from "./renderResolution";

describe("getCappedRenderResolution", () => {
  it.each([
    [Number.NaN, 1],
    [0, 1],
    [0.75, 1],
    [1, 1],
    [1.5, 1.5],
    [2, 2],
    [3, 2],
  ])("caps device pixel ratio %s to %s", (pixelRatio, expected) => {
    expect(getCappedRenderResolution(pixelRatio)).toBe(expected);
  });
});
