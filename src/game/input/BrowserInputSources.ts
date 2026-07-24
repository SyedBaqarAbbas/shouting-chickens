import type { Clock, ControlIntent, InputSource } from "../../core";

const JUMP_KEYS = new Set([" ", "ArrowUp"]);

type ListenerTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

abstract class BrowserIntentSource implements InputSource {
  protected running = false;
  protected held = false;
  protected pendingJump = false;

  constructor(protected readonly clock: Clock) {}

  abstract start(): Promise<void>;
  abstract stop(): void;

  latest(): ControlIntent {
    if (!this.running) {
      return {
        atMs: 0,
        jumpPressed: false,
        lift: 0,
      };
    }

    const intent = {
      atMs: this.clock.now(),
      jumpPressed: this.pendingJump,
      lift: this.held ? 1 : 0,
    };

    this.pendingJump = false;
    return intent;
  }
}

export class KeyboardInputSource extends BrowserIntentSource {
  private readonly onKeyDown = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;

    if (!JUMP_KEYS.has(keyboardEvent.key)) {
      return;
    }

    keyboardEvent.preventDefault();

    if (!this.held && !keyboardEvent.repeat) {
      this.pendingJump = true;
    }

    this.held = true;
  };

  private readonly onKeyUp = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;

    if (!JUMP_KEYS.has(keyboardEvent.key)) {
      return;
    }

    keyboardEvent.preventDefault();
    this.held = false;
  };

  constructor(
    clock: Clock,
    private readonly target: ListenerTarget,
  ) {
    super(clock);
  }

  async start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.target.addEventListener("keydown", this.onKeyDown);
    this.target.addEventListener("keyup", this.onKeyUp);
  }

  stop() {
    if (!this.running) {
      return;
    }

    this.target.removeEventListener("keydown", this.onKeyDown);
    this.target.removeEventListener("keyup", this.onKeyUp);
    this.running = false;
    this.held = false;
    this.pendingJump = false;
  }
}

export class TouchInputSource extends BrowserIntentSource {
  private readonly onPointerDown = (event: Event) => {
    event.preventDefault();

    if (!this.held) {
      this.pendingJump = true;
    }

    this.held = true;
  };

  private readonly onPointerUp = (event: Event) => {
    event.preventDefault();
    this.held = false;
  };

  constructor(
    clock: Clock,
    private readonly target: ListenerTarget,
  ) {
    super(clock);
  }

  async start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.target.addEventListener("pointerdown", this.onPointerDown);
    this.target.addEventListener("pointerup", this.onPointerUp);
    this.target.addEventListener("pointercancel", this.onPointerUp);
  }

  stop() {
    if (!this.running) {
      return;
    }

    this.target.removeEventListener("pointerdown", this.onPointerDown);
    this.target.removeEventListener("pointerup", this.onPointerUp);
    this.target.removeEventListener("pointercancel", this.onPointerUp);
    this.running = false;
    this.held = false;
    this.pendingJump = false;
  }
}

export class CombinedInputSource implements InputSource {
  private running = false;
  private generation = 0;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly sources: readonly InputSource[]) {}

  async start() {
    if (this.running) {
      return;
    }

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    const generation = ++this.generation;
    const startPromise = this.startSources(generation);
    this.startPromise = startPromise;

    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = null;
      }
    }
  }

  latest(): ControlIntent {
    if (!this.running) {
      return {
        atMs: 0,
        jumpPressed: false,
        lift: 0,
      };
    }

    return this.sources.reduce<ControlIntent>(
      (combined, source) => {
        const intent = source.latest();
        return {
          atMs: Math.max(combined.atMs, intent.atMs),
          jumpPressed: combined.jumpPressed || intent.jumpPressed,
          lift: Math.max(combined.lift, intent.lift),
        };
      },
      { atMs: 0, jumpPressed: false, lift: 0 },
    );
  }

  stop() {
    this.generation += 1;

    for (const source of [...this.sources].reverse()) {
      source.stop();
    }
    this.running = false;
  }

  private async startSources(generation: number) {
    const started: InputSource[] = [];

    try {
      for (const source of this.sources) {
        started.push(source);
        await source.start();

        if (generation !== this.generation) {
          for (const startedSource of started.reverse()) {
            startedSource.stop();
          }
          return;
        }
      }
      this.running = true;
    } catch (error) {
      for (const source of started.reverse()) {
        source.stop();
      }
      throw error;
    }
  }
}
