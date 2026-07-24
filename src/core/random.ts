import type { RandomSource } from "./contracts";

const UINT32_RANGE = 4_294_967_296;

function hashSeed(seed: string) {
  let hash = 0x811c9dc5;

  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

export class SeededRandom implements RandomSource {
  private state: number;

  constructor(seed: string) {
    if (seed.length === 0) {
      throw new TypeError("Seed must not be empty");
    }

    this.state = hashSeed(seed) || 0x6d2b79f5;
  }

  next() {
    let value = (this.state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    this.state = value >>> 0;
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
  }

  integer(minimum: number, maximum: number) {
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)) {
      throw new TypeError("Random integer bounds must be safe integers");
    }

    if (maximum < minimum) {
      throw new RangeError("Random integer maximum must be at least the minimum");
    }

    return minimum + Math.floor(this.next() * (maximum - minimum + 1));
  }

  pick<T>(values: readonly T[]) {
    if (values.length === 0) {
      throw new RangeError("Cannot pick from an empty collection");
    }

    const value = values[this.integer(0, values.length - 1)];

    if (value === undefined) {
      throw new RangeError("Random selection was outside the collection");
    }

    return value;
  }
}
