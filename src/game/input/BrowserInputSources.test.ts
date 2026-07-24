import { describe, expect, it } from "vitest";

import { ManualClock, ScriptedInputSource, type InputSource } from "../../core";
import { ChickenSimulation, type PlatformDefinition } from "../simulation";
import { CombinedInputSource, KeyboardInputSource, TouchInputSource } from "./BrowserInputSources";

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

    target.dispatchEvent(new KeyboardEvent("keydown", { key: " ", cancelable: true }));

    expect(source.latest()).toEqual({
      atMs: 40,
      jumpPressed: true,
      lift: 1,
    });
    expect(source.latest()).toEqual({
      atMs: 40,
      jumpPressed: false,
      lift: 1,
    });

    target.dispatchEvent(new KeyboardEvent("keyup", { key: " ", cancelable: true }));
    expect(source.latest().lift).toBe(0);

    source.stop();
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(source.latest()).toEqual({ atMs: 0, jumpPressed: false, lift: 0 });
  });

  it("turns a touch press into one edge and clears listeners on stop", async () => {
    const clock = new ManualClock(75);
    const target = new EventTarget();
    const source = new TouchInputSource(clock, target);
    await source.start();

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

    touchTarget.dispatchEvent(new Event("pointerdown", { cancelable: true }));
    expect(source.latest()).toEqual({
      atMs: 100,
      jumpPressed: true,
      lift: 1,
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
});
