import type { Clock, ControlIntent, InputFeedback, InputSource } from "../../core";

const JUMP_KEYS = new Set([" ", "ArrowUp"]);
const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, summary, [contenteditable]:not([contenteditable="false"]), [role="button"]';

type ListenerTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

abstract class BrowserIntentSource implements InputSource {
  protected running = false;
  protected held = false;
  protected pendingJump = false;

  constructor(
    protected readonly clock: Clock,
    private readonly listenerCount: number,
  ) {}

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

  getFeedback(): InputFeedback {
    return {
      normalizedLevel: this.held ? 1 : 0,
      provenance: "keyboard-touch",
    };
  }

  resetRunState() {
    this.held = false;
    this.pendingJump = false;
  }

  diagnostics() {
    return {
      activeListeners: this.running ? this.listenerCount : 0,
    };
  }
}

export class KeyboardInputSource extends BrowserIntentSource {
  private readonly onKeyDown = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;

    if (!JUMP_KEYS.has(keyboardEvent.key) || isInteractiveTarget(keyboardEvent.target)) {
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

    this.held = false;
    if (!isInteractiveTarget(keyboardEvent.target)) {
      keyboardEvent.preventDefault();
    }
  };

  constructor(
    clock: Clock,
    private readonly target: ListenerTarget,
  ) {
    super(clock, 2);
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

export class OptionalInputSource implements InputSource {
  private available = false;

  constructor(
    private readonly source: InputSource,
    private readonly onUnavailable: (error: unknown) => void = () => undefined,
  ) {}

  async start() {
    try {
      await this.source.start();
      this.available = true;
    } catch (error) {
      // Keep the wrapper live so an explicit external retry can revive the
      // underlying source without rebuilding the keyboard/touch stack.
      this.available = true;
      this.source.stop();
      this.onUnavailable(error);
    }
  }

  latest(): ControlIntent {
    return this.available ? this.source.latest() : { atMs: 0, jumpPressed: false, lift: 0 };
  }

  getFeedback(): InputFeedback {
    return this.available
      ? (this.source.getFeedback?.() ?? { normalizedLevel: 0, provenance: "none" })
      : { normalizedLevel: 0, provenance: "none" };
  }

  resetRunState() {
    this.source.resetRunState?.();
  }

  diagnostics() {
    return {
      activeListeners: this.available ? (this.source.diagnostics?.().activeListeners ?? 0) : 0,
    };
  }

  stop() {
    this.available = false;
    this.source.stop();
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
    super(clock, 3);
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
  private feedback: InputFeedback = {
    normalizedLevel: 0,
    provenance: "none",
  };

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

    let combined: ControlIntent = { atMs: 0, jumpPressed: false, lift: 0 };
    let feedback: InputFeedback = { normalizedLevel: 0, provenance: "none" };

    for (const source of this.sources) {
      const intent = source.latest();
      const sourceFeedback = source.getFeedback?.() ?? {
        normalizedLevel: 0,
        provenance: "none",
      };
      const activity = Math.max(
        clampInputLevel(sourceFeedback.normalizedLevel),
        clampInputLevel(intent.lift),
        intent.jumpPressed ? 1 : 0,
      );

      combined = {
        atMs: Math.max(combined.atMs, intent.atMs),
        jumpPressed: combined.jumpPressed || intent.jumpPressed,
        lift: Math.max(combined.lift, intent.lift),
      };
      if (activity > feedback.normalizedLevel) {
        feedback = {
          normalizedLevel: activity,
          provenance: sourceFeedback.provenance,
        };
      }
    }

    this.feedback = feedback;
    return combined;
  }

  getFeedback(): InputFeedback {
    return { ...this.feedback };
  }

  resetRunState() {
    this.feedback = {
      normalizedLevel: 0,
      provenance: "none",
    };
    for (const source of this.sources) {
      source.resetRunState?.();
    }
  }

  diagnostics() {
    return {
      activeListeners: this.sources.reduce(
        (total, source) => total + (source.diagnostics?.().activeListeners ?? 0),
        0,
      ),
    };
  }

  stop() {
    this.generation += 1;
    this.feedback = {
      normalizedLevel: 0,
      provenance: "none",
    };

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

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null;
}

function clampInputLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}
