import {
  NEUTRAL_CONTROL_INTENT,
  type Clock,
  type ControlIntent,
  type InputSource,
} from "../contracts";

export type ScriptedControlFrame = {
  atMs: number;
  jumpPressed: boolean;
  lift: number;
};

function validateFrame(frame: ScriptedControlFrame, previousTime: number) {
  if (!Number.isFinite(frame.atMs) || frame.atMs < previousTime) {
    throw new RangeError("Scripted control frames must be sorted by a finite non-negative time");
  }

  if (!Number.isFinite(frame.lift) || frame.lift < 0 || frame.lift > 1) {
    throw new RangeError("Scripted control lift must be between 0 and 1");
  }
}

export class ScriptedInputSource implements InputSource {
  private readonly frames: readonly ScriptedControlFrame[];
  private startedAtMs: number | null = null;
  private cursor = -1;
  private current: ControlIntent = { ...NEUTRAL_CONTROL_INTENT };

  constructor(
    private readonly clock: Clock,
    frames: readonly ScriptedControlFrame[],
  ) {
    let previousTime = 0;

    for (const frame of frames) {
      validateFrame(frame, previousTime);
      previousTime = frame.atMs;
    }

    this.frames = frames.map((frame) => ({ ...frame }));
  }

  async start() {
    this.startedAtMs = this.clock.now();
    this.cursor = -1;
    this.current = {
      ...NEUTRAL_CONTROL_INTENT,
      atMs: this.startedAtMs,
    };
  }

  latest() {
    if (this.startedAtMs === null) {
      return { ...NEUTRAL_CONTROL_INTENT };
    }

    const elapsedMs = this.clock.now() - this.startedAtMs;

    while (this.cursor + 1 < this.frames.length) {
      const nextFrame = this.frames[this.cursor + 1];

      if (!nextFrame || nextFrame.atMs > elapsedMs) {
        break;
      }

      this.cursor += 1;
      this.current = {
        atMs: this.startedAtMs + nextFrame.atMs,
        jumpPressed: nextFrame.jumpPressed,
        lift: nextFrame.lift,
      };
    }

    const intent = { ...this.current };
    this.current.jumpPressed = false;
    return intent;
  }

  stop() {
    this.startedAtMs = null;
    this.cursor = -1;
    this.current = { ...NEUTRAL_CONTROL_INTENT };
  }
}

export class MutableInputSource implements InputSource {
  private running = false;
  private current: ControlIntent = { ...NEUTRAL_CONTROL_INTENT };

  async start() {
    this.running = true;
  }

  latest() {
    if (!this.running) {
      return { ...NEUTRAL_CONTROL_INTENT };
    }

    const intent = { ...this.current };
    this.current.jumpPressed = false;
    return intent;
  }

  set(intent: ControlIntent) {
    if (!Number.isFinite(intent.lift) || intent.lift < 0 || intent.lift > 1) {
      throw new RangeError("Control intent lift must be between 0 and 1");
    }

    this.current = { ...intent };
  }

  stop() {
    this.running = false;
    this.current = { ...NEUTRAL_CONTROL_INTENT };
  }
}
