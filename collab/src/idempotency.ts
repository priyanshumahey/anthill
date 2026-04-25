interface Entry<T> {
  bodyHash: string;
  response: T;
  status: number;
  expiresAt: number;
}

export class IdempotencyCache<T = unknown> {
  private readonly store = new Map<string, Entry<T>>();

  constructor(
    private readonly maxAgeMs: number = 10 * 60 * 1000,
    private readonly maxEntries: number = 5_000,
  ) {}

  get(key: string): Entry<T> | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  put(key: string, bodyHash: string, status: number, response: T): void {
    if (this.store.size >= this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
    this.store.set(key, {
      bodyHash,
      status,
      response,
      expiresAt: Date.now() + this.maxAgeMs,
    });
  }

  static hashBody(value: unknown): string {
    const json = JSON.stringify(value, sortKeys);
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < json.length; i++) {
      h = ((h ^ json.charCodeAt(i)) * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  clear(): void {
    this.store.clear();
  }
}

function sortKeys(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  ) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}
