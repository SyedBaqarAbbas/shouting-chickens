import type { KeyValueStorage } from "./contracts";

export class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();

  get(key: string) {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string) {
    this.values.set(key, value);
  }

  remove(key: string) {
    this.values.delete(key);
  }

  keys() {
    return [...this.values.keys()];
  }

  clear() {
    this.values.clear();
  }
}

export class JsonStore<T> {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly key: string,
    private readonly validate: (value: unknown) => value is T,
  ) {}

  read() {
    const rawValue = this.storage.get(this.key);

    if (rawValue === null) {
      return null;
    }

    try {
      const value: unknown = JSON.parse(rawValue);
      return this.validate(value) ? value : null;
    } catch {
      return null;
    }
  }

  write(value: T) {
    this.storage.set(this.key, JSON.stringify(value));
  }

  remove() {
    this.storage.remove(this.key);
  }
}
