/**
 * Tiny in-memory idempotency cache for the agent bridge.
 *
 * proof-sdk's pattern: callers pass an `Idempotency-Key` header on every
 * mutation. We hash the (key, body) pair; if the same key is replayed
 * with the SAME body, we return the cached response. If the body differs,
 * we surface IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY (409). Entries TTL
 * after `maxAgeMs`.
 */

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

  /** Lookup; returns cached entry or null. Sweeps expired entries lazily. */
  get(key: string): Entry<T> | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    // `<=` so a TTL of 0 expires immediately (matches “do not cache” intent).
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  /** Store a response under (key, bodyHash). Replaces any prior entry. */
  put(key: string, bodyHash: string, status: number, response: T): void {
    if (this.store.size >= this.maxEntries) {
      // Drop the oldest insertion-ordered entry. Map preserves insertion order.
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

  /** Quick byte-stable hash so callers don't have to import a crypto lib. */
  static hashBody(value: unknown): string {
    const json = JSON.stringify(value, sortKeys);
    // FNV-1a 32-bit; collisions matter only if a caller intentionally tries to
    // bypass the check, which the policy already disallows.
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < json.length; i++) {
      h = ((h ^ json.charCodeAt(i)) * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /** For tests / restarts. */
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
