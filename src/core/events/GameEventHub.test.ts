import { describe, expect, it, vi } from "vitest";

import { ManualClock } from "../clock";
import type { GameSnapshot } from "../contracts";
import { GameEventHub } from "./GameEventHub";

const snapshot: GameSnapshot = {
  phase: "running",
  elapsedMs: 20,
  score: 20,
  distance: 4,
  normalizedInput: 0.5,
};

describe("GameEventHub", () => {
  it("throttles snapshots before they reach application listeners", () => {
    const clock = new ManualClock();
    const events = new GameEventHub(clock, 100);
    const listener = vi.fn();
    events.subscribe(listener);

    expect(events.publishSnapshot(snapshot)).toBe(true);
    clock.advance(30);
    expect(events.publishSnapshot({ ...snapshot, elapsedMs: 50 })).toBe(false);
    clock.advance(70);
    expect(events.publishSnapshot({ ...snapshot, elapsedMs: 120 })).toBe(true);

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("cleans subscriptions idempotently", () => {
    const events = new GameEventHub(new ManualClock());
    const listener = vi.fn();
    const unsubscribe = events.subscribe(listener);

    expect(events.listenerCount()).toBe(1);
    unsubscribe();
    unsubscribe();
    expect(events.listenerCount()).toBe(0);

    events.emit({
      type: "fatal-error",
      error: {
        code: "invalid-state",
        message: "ignored",
        recoverable: true,
      },
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("starts snapshot timing fresh for every run without growing listeners", () => {
    const clock = new ManualClock();
    const events = new GameEventHub(clock, 100);
    const listener = vi.fn();
    events.subscribe(listener);

    expect(events.publishSnapshot(snapshot)).toBe(true);
    expect(events.publishSnapshot(snapshot)).toBe(false);

    events.resetRunState();

    expect(events.publishSnapshot({ ...snapshot, elapsedMs: 0, score: 0 })).toBe(true);
    expect(events.listenerCount()).toBe(1);
  });
});
