import { describe, expect, it } from "vitest";

import { SeededRandom } from "./random";

describe("SeededRandom", () => {
  it("replays an identical sequence for the same seed", () => {
    const first = new SeededRandom("run-42");
    const second = new SeededRandom("run-42");

    expect(Array.from({ length: 20 }, () => first.next())).toEqual(
      Array.from({ length: 20 }, () => second.next()),
    );
  });

  it("keeps integer values inside inclusive bounds", () => {
    const random = new SeededRandom("bounds");
    const values = Array.from({ length: 100 }, () => random.integer(-3, 3));

    expect(values.every((value) => value >= -3 && value <= 3)).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it("rejects invalid seeds and empty collections", () => {
    expect(() => new SeededRandom("")).toThrow("Seed must not be empty");
    expect(() => new SeededRandom("valid").pick([])).toThrow(
      "Cannot pick from an empty collection",
    );
  });
});
