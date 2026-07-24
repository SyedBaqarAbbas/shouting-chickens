import type { Clock, GameEvent, GameEventListener, GameSnapshot } from "../contracts";

export class GameEventHub {
  private readonly listeners = new Set<GameEventListener>();
  private lastSnapshotAtMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly clock: Clock,
    private readonly snapshotIntervalMs = 100,
  ) {
    if (!Number.isFinite(snapshotIntervalMs) || snapshotIntervalMs < 0) {
      throw new RangeError("Snapshot interval must be a non-negative finite number");
    }
  }

  subscribe(listener: GameEventListener) {
    this.listeners.add(listener);
    let active = true;

    return () => {
      if (!active) {
        return;
      }

      active = false;
      this.listeners.delete(listener);
    };
  }

  publishSnapshot(snapshot: GameSnapshot) {
    const now = this.clock.now();

    if (now - this.lastSnapshotAtMs < this.snapshotIntervalMs) {
      return false;
    }

    this.lastSnapshotAtMs = now;
    this.dispatch({ type: "snapshot", value: snapshot });
    return true;
  }

  emit(event: Exclude<GameEvent, { type: "snapshot" }>) {
    this.dispatch(event);
  }

  resetRunState() {
    this.lastSnapshotAtMs = Number.NEGATIVE_INFINITY;
  }

  clear() {
    this.listeners.clear();
    this.resetRunState();
  }

  listenerCount() {
    return this.listeners.size;
  }

  private dispatch(event: GameEvent) {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}
