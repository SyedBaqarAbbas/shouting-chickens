import { describe, expect, it, vi } from "vitest";

import { ManualClock, ScriptedInputSource, type InputSource } from "../../core";
import { ChickenSimulation, type PlatformDefinition } from "../simulation";
import {
  CombinedInputSource,
  KeyboardInputSource,
  OptionalInputSource,
  TouchInputSource,
} from "./BrowserInputSources";

const ENDLESS_PLATFORM: readonly PlatformDefinition[] = [
  { id: "endless", x: -500, width: 10_000, top: 584 },
];

async function firstJumpSnapshot(source: InputSource, trigger?: () => void) {
  const simulation = new ChickenSimulation({ platforms: ENDLESS_PLATFORM });
  await source.start();
  trigger?.();
  simulation.start();
  const snapshot = simulation.step(source.latest());
  source.stop();

  return {
    y: snapshot.chicken.y,
    velocityY: snapshot.chicken.velocityY,
    grounded: snapshot.chicken.grounded,
  };
}

describe("browser ControlIntent sources", () => {
  it("turns keyboard press edges and holds into one shared intent shape", async () => {
    const clock = new ManualClock(40);
    const target = new EventTarget();
    const source = new KeyboardInputSource(clock, target);
    await source.start();
    expect(source.diagnostics()).toEqual({ activeListeners: 2 });

    target.dispatchEvent(
      withEventTimestamp(new KeyboardEvent("keydown", { key: " ", cancelable: true }), 25),
    );
    clock.advance(35);

    expect(source.latest()).toEqual({
      atMs: 25,
      jumpPressed: true,
      lift: 1,
    });
    expect(source.consumeInputLatencyMs()).toBe(15);
    expect(source.consumeInputLatencyMs()).toBeNull();
    expect(source.latest()).toEqual({
      atMs: 75,
      jumpPressed: false,
      lift: 1,
    });

    target.dispatchEvent(new KeyboardEvent("keyup", { key: " ", cancelable: true }));
    expect(source.latest().lift).toBe(0);

    source.stop();
    expect(source.diagnostics()).toEqual({ activeListeners: 0 });
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(source.latest()).toEqual({ atMs: 0, jumpPressed: false, lift: 0 });
  });

  it("does not turn Space on an interactive control into gameplay input", async () => {
    const clock = new ManualClock(40);
    const button = document.createElement("button");
    document.body.append(button);
    const source = new KeyboardInputSource(clock, window);
    await source.start();

    const down = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: " ",
    });
    button.dispatchEvent(down);
    button.dispatchEvent(
      new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: " ",
      }),
    );

    expect(down.defaultPrevented).toBe(false);
    expect(source.latest()).toEqual({
      atMs: 40,
      jumpPressed: false,
      lift: 0,
    });
    source.stop();
    button.remove();
  });

  it("turns a touch press into one edge and clears listeners on stop", async () => {
    const clock = new ManualClock(75);
    const target = new EventTarget();
    const source = new TouchInputSource(clock, target);
    await source.start();
    expect(source.diagnostics()).toEqual({ activeListeners: 3 });

    target.dispatchEvent(new Event("pointerdown", { cancelable: true }));
    expect(source.latest()).toEqual({
      atMs: 75,
      jumpPressed: true,
      lift: 1,
    });
    expect(source.latest().jumpPressed).toBe(false);

    target.dispatchEvent(new Event("pointerup", { cancelable: true }));
    expect(source.latest().lift).toBe(0);

    source.stop();
    expect(source.diagnostics()).toEqual({ activeListeners: 0 });
    target.dispatchEvent(new Event("pointerdown"));
    expect(source.latest()).toEqual({ atMs: 0, jumpPressed: false, lift: 0 });
  });

  it("combines keyboard and touch without creating a second control path", async () => {
    const clock = new ManualClock(100);
    const keyboardTarget = new EventTarget();
    const touchTarget = new EventTarget();
    const source = new CombinedInputSource([
      new KeyboardInputSource(clock, keyboardTarget),
      new TouchInputSource(clock, touchTarget),
    ]);
    await source.start();
    expect(source.diagnostics()).toEqual({ activeListeners: 5 });

    touchTarget.dispatchEvent(
      withEventTimestamp(new Event("pointerdown", { cancelable: true }), 72),
    );
    clock.advance(28);
    expect(source.latest()).toEqual({
      atMs: 72,
      jumpPressed: true,
      lift: 1,
    });
    expect(source.consumeInputLatencySamples()).toEqual([
      { latencyMs: 28, provenance: "keyboard-touch" },
    ]);

    source.stop();
    expect(source.diagnostics()).toEqual({ activeListeners: 0 });
  });

  it("clears held state and queued edges across a run restart", async () => {
    const clock = new ManualClock(100);
    const keyboardTarget = new EventTarget();
    const touchTarget = new EventTarget();
    const source = new CombinedInputSource([
      new KeyboardInputSource(clock, keyboardTarget),
      new TouchInputSource(clock, touchTarget),
    ]);
    await source.start();

    keyboardTarget.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    touchTarget.dispatchEvent(new Event("pointerdown"));
    source.resetRunState();

    expect(source.latest()).toEqual({
      atMs: 100,
      jumpPressed: false,
      lift: 0,
    });

    keyboardTarget.dispatchEvent(new KeyboardEvent("keyup", { key: " " }));
    keyboardTarget.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(source.latest().jumpPressed).toBe(true);
    source.stop();
  });

  it("reports the strongest actual contributor independently from combined lift", async () => {
    const clock = new ManualClock(100);
    const keyboardTarget = new EventTarget();
    const voice: InputSource = {
      async start() {},
      latest() {
        return { atMs: 100, jumpPressed: false, lift: 0 };
      },
      getFeedback() {
        return { normalizedLevel: 0.4, provenance: "voice" };
      },
      stop() {},
    };
    const source = new CombinedInputSource([new KeyboardInputSource(clock, keyboardTarget), voice]);
    await source.start();

    expect(source.latest()).toMatchObject({ jumpPressed: false, lift: 0 });
    expect(source.getFeedback()).toEqual({
      normalizedLevel: 0.4,
      provenance: "voice",
    });

    keyboardTarget.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(source.latest()).toMatchObject({ jumpPressed: true, lift: 1 });
    expect(source.getFeedback()).toEqual({
      normalizedLevel: 1,
      provenance: "keyboard-touch",
    });
    source.stop();
  });

  it("drives identical first-step physics from scripted, keyboard, and touch input", async () => {
    const scriptedClock = new ManualClock();
    const scripted = new ScriptedInputSource(scriptedClock, [
      { atMs: 0, jumpPressed: true, lift: 1 },
    ]);

    const keyboardClock = new ManualClock();
    const keyboardTarget = new EventTarget();
    const keyboard = new KeyboardInputSource(keyboardClock, keyboardTarget);

    const touchClock = new ManualClock();
    const touchTarget = new EventTarget();
    const touch = new TouchInputSource(touchClock, touchTarget);

    const [scriptedSnapshot, keyboardSnapshot, touchSnapshot] = await Promise.all([
      firstJumpSnapshot(scripted),
      firstJumpSnapshot(keyboard, () => {
        keyboardTarget.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
      }),
      firstJumpSnapshot(touch, () => {
        touchTarget.dispatchEvent(new Event("pointerdown"));
      }),
    ]);

    expect(keyboardSnapshot).toEqual(scriptedSnapshot);
    expect(touchSnapshot).toEqual(scriptedSnapshot);
  });

  it("cancels an asynchronous combined start before later listeners can attach", async () => {
    let releaseFirst = () => {};
    let firstActive = false;
    let firstStopCount = 0;
    let secondStartCount = 0;

    const first: InputSource = {
      async start() {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        firstActive = true;
      },
      latest() {
        return { atMs: 0, jumpPressed: false, lift: 0 };
      },
      stop() {
        firstActive = false;
        firstStopCount += 1;
      },
    };
    const second: InputSource = {
      async start() {
        secondStartCount += 1;
      },
      latest() {
        return { atMs: 0, jumpPressed: false, lift: 0 };
      },
      stop() {},
    };
    const combined = new CombinedInputSource([first, second]);

    const starting = combined.start();
    await Promise.resolve();
    combined.stop();
    releaseFirst();
    await starting;

    expect(firstActive).toBe(false);
    expect(firstStopCount).toBeGreaterThanOrEqual(2);
    expect(secondStartCount).toBe(0);
    expect(combined.latest()).toEqual({ atMs: 0, jumpPressed: false, lift: 0 });
  });

  it("cleans the source whose startup rejects", async () => {
    let stopCount = 0;
    const failing: InputSource = {
      async start() {
        throw new Error("listener setup failed");
      },
      latest() {
        return { atMs: 0, jumpPressed: false, lift: 0 };
      },
      stop() {
        stopCount += 1;
      },
    };
    const combined = new CombinedInputSource([failing]);

    await expect(combined.start()).rejects.toThrow("listener setup failed");
    expect(stopCount).toBe(1);
    expect(combined.latest()).toEqual({ atMs: 0, jumpPressed: false, lift: 0 });
  });

  it("keeps required fallback sources active when an optional source rejects", async () => {
    const fallback = new ScriptedInputSource(new ManualClock(), [
      { atMs: 0, jumpPressed: true, lift: 1 },
    ]);
    const optionalFailure = new Error("voice setup failed");
    const voice: InputSource = {
      async start() {
        throw optionalFailure;
      },
      latest() {
        return { atMs: 0, jumpPressed: false, lift: 0 };
      },
      stop() {},
    };
    const unavailable = vi.fn();
    const combined = new CombinedInputSource([
      fallback,
      new OptionalInputSource(voice, unavailable),
    ]);

    await combined.start();

    expect(unavailable).toHaveBeenCalledExactlyOnceWith(optionalFailure);
    expect(combined.latest()).toEqual({
      atMs: 0,
      jumpPressed: true,
      lift: 1,
    });
    combined.stop();
  });
});

function withEventTimestamp<T extends Event>(event: T, timeStamp: number): T {
  Object.defineProperty(event, "timeStamp", { configurable: true, value: timeStamp });
  return event;
}
