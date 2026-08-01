import type {
  Clock,
  ControlIntent,
  InputFeedback,
  InputLatencySample,
  InputSource,
} from "../../core";

const JUMP_KEYS = new Set([" ", "ArrowUp"]);
const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, summary, [contenteditable]:not([contenteditable="false"]), [role="button"]';

type ListenerTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

abstract class BrowserIntentSource implements InputSource {
  protected running = false;
  protected held = false;
  protected pendingJump = false;
  protected pendingJumpAtMs = 0;
  private pendingInputLatencyMs: number | null = null;

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
      atMs: this.pendingJump ? this.pendingJumpAtMs : this.clock.now(),
      jumpPressed: this.pendingJump,
      lift: this.held ? 1 : 0,
    };

    this.pendingJump = false;
    this.pendingJumpAtMs = 0;
    return intent;
  }

  getFeedback(): InputFeedback {
    return {
      normalizedLevel: this.held ? 1 : 0,
      provenance: "keyboard-touch",
    };
  }

  consumeInputLatencyMs() {
    const latency = this.pendingInputLatencyMs;
    this.pendingInputLatencyMs = null;
    return latency;
  }

  consumeInputLatencySamples(): readonly InputLatencySample[] {
    const latencyMs = this.consumeInputLatencyMs();
    return latencyMs === null ? [] : [{ latencyMs, provenance: "keyboard-touch" }];
  }

  protected markInputCreated(event: Event, createdAtMs = this.clock.now()) {
    const eventAtMs = eventTimestampInClockDomain(event, createdAtMs);
    const latencyMs = Math.max(0, createdAtMs - eventAtMs);
    this.pendingInputLatencyMs =
      this.pendingInputLatencyMs === null
        ? latencyMs
        : Math.max(this.pendingInputLatencyMs, latencyMs);
    return eventAtMs;
  }

  resetRunState() {
    this.held = false;
    this.pendingJump = false;
    this.pendingJumpAtMs = 0;
    this.pendingInputLatencyMs = null;
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
      const createdAtMs = this.clock.now();
      this.pendingJumpAtMs = this.markInputCreated(keyboardEvent, createdAtMs);
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
      this.markInputCreated(keyboardEvent);
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
    this.pendingJumpAtMs = 0;
    this.consumeInputLatencyMs();
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

  consumeInputLatencyMs() {
    return this.available ? (this.source.consumeInputLatencyMs?.() ?? null) : null;
  }

  consumeInputLatencySamples(): readonly InputLatencySample[] {
    if (!this.available) {
      return [];
    }
    if (this.source.consumeInputLatencySamples) {
      return this.source.consumeInputLatencySamples();
    }
    const latencyMs = this.source.consumeInputLatencyMs?.();
    if (latencyMs === undefined || latencyMs === null) {
      return [];
    }
    return [
      {
        latencyMs,
        provenance: this.source.getFeedback?.().provenance ?? "none",
      },
    ];
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
      const createdAtMs = this.clock.now();
      this.pendingJumpAtMs = this.markInputCreated(event, createdAtMs);
    }

    this.held = true;
  };

  private readonly onPointerUp = (event: Event) => {
    event.preventDefault();
    this.held = false;
    this.markInputCreated(event);
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
    this.pendingJumpAtMs = 0;
    this.consumeInputLatencyMs();
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
    let firstJumpAtMs: number | null = null;
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
      if (intent.jumpPressed) {
        firstJumpAtMs = firstJumpAtMs === null ? intent.atMs : Math.min(firstJumpAtMs, intent.atMs);
      }
      if (activity > feedback.normalizedLevel) {
        feedback = {
          normalizedLevel: activity,
          provenance: sourceFeedback.provenance,
        };
      }
    }

    if (firstJumpAtMs !== null) {
      combined.atMs = firstJumpAtMs;
    }
    this.feedback = feedback;
    return combined;
  }

  getFeedback(): InputFeedback {
    return { ...this.feedback };
  }

  consumeInputLatencyMs() {
    let latency: number | null = null;
    for (const source of this.sources) {
      const sample = source.consumeInputLatencyMs?.();
      if (sample !== undefined && sample !== null) {
        latency = latency === null ? sample : Math.max(latency, sample);
      }
    }
    return latency;
  }

  consumeInputLatencySamples(): readonly InputLatencySample[] {
    const samples: InputLatencySample[] = [];
    for (const source of this.sources) {
      if (source.consumeInputLatencySamples) {
        samples.push(...source.consumeInputLatencySamples());
        continue;
      }
      const latencyMs = source.consumeInputLatencyMs?.();
      if (latencyMs !== undefined && latencyMs !== null) {
        samples.push({
          latencyMs,
          provenance: source.getFeedback?.().provenance ?? "none",
        });
      }
    }
    return samples;
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

function eventTimestampInClockDomain(event: Event, nowMs: number): number {
  const rawTimestamp = event.timeStamp;
  if (!Number.isFinite(rawTimestamp) || rawTimestamp < 0) {
    return nowMs;
  }

  const candidates = [rawTimestamp];
  const timeOrigin = globalThis.performance?.timeOrigin;
  if (Number.isFinite(timeOrigin)) {
    candidates.push(timeOrigin + rawTimestamp);
  }

  let closest = nowMs;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(nowMs - candidate);
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }

  return closestDistance <= 60_000 ? Math.min(nowMs, Math.max(0, closest)) : nowMs;
}
