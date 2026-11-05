import type {
  OtpSmsArgs,
  OtpSmsCounterStore,
  OtpSmsKeys,
  OtpSmsScriptResult,
} from '../otp-sms-guard';

/**
 * TEST SUPPORT ONLY. Never imported by application code.
 *
 * An in-memory stand-in for Redis running `OTP_SMS_RESERVE_SCRIPT`, line for line, so the guard
 * can be exercised in unit tests with no Redis. Like a Redis script, `reserve` does all of its
 * work synchronously between two awaits, so concurrent callers are serialised exactly as Redis
 * serialises scripts. `otp-sms-guard.integration.spec.ts` holds the REAL script to the same
 * behaviour against a real Redis, so the two cannot quietly drift apart.
 *
 * The clock is injectable so a test can step over a cooldown or an hour without waiting.
 */
export class MemoryOtpSmsCounterStore implements OtpSmsCounterStore {
  private readonly values = new Map<string, { value: number; expiresAt: number | null }>();
  /** Commands seen, for asserting the guard asks once per request. */
  calls = 0;
  /** When set, every call rejects as an unreachable Redis does. */
  down = false;

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string) {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.values.delete(key);
      return null;
    }
    return entry;
  }
  private count(key: string): number {
    return this.live(key)?.value ?? 0;
  }
  private pttl(key: string): number {
    const entry = this.live(key);
    if (!entry) return -2;
    return entry.expiresAt === null ? -1 : entry.expiresAt - this.now();
  }
  private setNx(key: string, ttlMs: number): boolean {
    if (this.live(key)) return false;
    this.values.set(key, { value: 1, expiresAt: this.now() + ttlMs });
    return true;
  }
  private bump(key: string, windowMs: number): number {
    const entry = this.live(key) ?? { value: 0, expiresAt: null };
    entry.value += 1;
    if (entry.value === 1 || entry.expiresAt === null) entry.expiresAt = this.now() + windowMs;
    this.values.set(key, entry);
    return entry.value;
  }

  /** Raw counter value, for assertions. */
  peek(key: string): number {
    return this.count(key);
  }

  async reserve(keys: OtpSmsKeys, a: OtpSmsArgs): Promise<OtpSmsScriptResult> {
    this.calls += 1;
    if (this.down) throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    const HOUR_MS = 3_600_000;
    const DAY_MS = 86_400_000;
    const remaining = (k: string) => Math.max(0, this.pttl(k));

    if (this.count(keys.day) >= a.perNumberPerDay) return [3, remaining(keys.day), 0, 0, 0];
    if (this.count(keys.hour) >= a.perNumberPerHour) return [2, remaining(keys.hour), 0, 0, 0];
    const cooldown = this.pttl(keys.cooldown);
    if (cooldown > 0) return [1, cooldown, 0, 0, 0];

    let total = this.count(keys.budgetTotal);
    if (a.dailyTotal > 0 && total >= a.dailyTotal) {
      return [4, 0, this.setNx(keys.trippedTotal, a.budgetTtlMs) ? 1 : 0, total, 0];
    }
    let market = this.count(keys.budgetMarket);
    if (a.dailyMarket > 0 && market >= a.dailyMarket) {
      return [5, 0, this.setNx(keys.trippedMarket, a.budgetTtlMs) ? 1 : 0, total, market];
    }

    this.bump(keys.hour, HOUR_MS);
    this.bump(keys.day, DAY_MS);
    total = this.bump(keys.budgetTotal, a.budgetTtlMs);
    market = this.bump(keys.budgetMarket, a.budgetTtlMs);
    if (a.cooldownMs > 0) {
      this.values.set(keys.cooldown, { value: 1, expiresAt: this.now() + a.cooldownMs });
    }

    let warn = 0;
    if (
      a.warnTotalAt > 0 &&
      total >= a.warnTotalAt &&
      this.setNx(keys.warnedTotal, a.budgetTtlMs)
    ) {
      warn += 1;
    }
    if (
      a.dailyMarket > 0 &&
      a.warnMarketAt > 0 &&
      market >= a.warnMarketAt &&
      this.setNx(keys.warnedMarket, a.budgetTtlMs)
    ) {
      warn += 2;
    }
    return [0, 0, warn, total, market];
  }
}

/**
 * Gives a hand-built Prisma mock the two calls the Postgres fallback makes: an interactive
 * `$transaction` (run against the same mock, so its writes are visible to the test) and the
 * `$executeRaw` that takes the advisory lock. The lock calls are recorded.
 */
export function withTransactions<T extends object>(
  prisma: T,
): T & {
  $transaction: <R>(fn: (tx: T) => Promise<R>) => Promise<R>;
  $executeRaw: (...args: unknown[]) => Promise<number>;
  lockCalls: unknown[][];
} {
  const out = prisma as T & {
    $transaction: <R>(fn: (tx: T) => Promise<R>) => Promise<R>;
    $executeRaw: (...args: unknown[]) => Promise<number>;
    lockCalls: unknown[][];
  };
  out.lockCalls = [];
  out.$executeRaw = async (...args: unknown[]) => {
    out.lockCalls.push(args);
    return 1;
  };
  out.$transaction = async (fn) => fn(out);
  return out;
}
