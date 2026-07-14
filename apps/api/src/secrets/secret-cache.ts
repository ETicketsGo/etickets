/**
 * Tiny TTL cache for resolved secret values (ADR-024). Holds values in memory for
 * a short window so rotation propagates within one TTL without a restart, and so a
 * config change can invalidate immediately. The clock is injectable for tests.
 *
 * Values live only in process memory and are never serialized or logged.
 */
export class SecretCache {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(reference: string): string | undefined {
    const entry = this.store.get(reference);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.store.delete(reference);
      return undefined;
    }
    return entry.value;
  }

  set(reference: string, value: string): void {
    // ttl <= 0 disables caching entirely (always miss).
    if (this.ttlMs <= 0) return;
    this.store.set(reference, { value, expiresAt: this.now() + this.ttlMs });
  }

  invalidate(reference?: string): void {
    if (reference === undefined) this.store.clear();
    else this.store.delete(reference);
  }

  get size(): number {
    return this.store.size;
  }
}
