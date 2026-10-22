import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { RedisService } from '../redis/redis.service';
import { redisEnvRoot } from '../common/redis-namespace';

/**
 * Per-ACCOUNT password sign-in backoff.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────
 * The only limit on password guessing was the per-client throttle (AUTH_THROTTLE, 10 a minute
 * per IP per route). That counts the wrong thing for a targeted attack: somebody guessing ONE
 * account's password from a pool of addresses gets ten tries a minute from each address, and
 * the account itself never notices. This counts failures against the account being guessed,
 * whoever is guessing.
 *
 * ── WHY A GROWING DELAY AND NEVER A LOCK ───────────────────────────────────────────
 * A hard lock ("five wrong passwords and the account is closed until support opens it") is a
 * denial-of-service button: anybody who knows a customer's email address can lock them out on
 * the morning of a show. So after `threshold` failures inside the window the account must WAIT,
 * the wait doubles with each further failure, and it is capped (15 minutes by default). Guessing
 * becomes hopelessly slow; the owner is never shut out for longer than the cap. And there are
 * two ways round even that, both of which prove more than a password does: a password reset
 * (which clears the counter, see AuthService.resetPassword) and phone sign-in.
 *
 * While an account is waiting, attempts are refused WITHOUT being counted and without the
 * password being checked. Counting them would let an attacker keep the victim waiting forever by
 * hammering; checking the password would make the wait meaningless.
 *
 * ── WHY IT IS KEYED ON THE TYPED ADDRESS, ACCOUNT OR NOT ───────────────────────────
 * An address with no account is counted exactly like one with an account. If only real accounts
 * could be made to wait, "this address is being made to wait" would itself answer "does this
 * address have an account here". The key is a SHA-256 of the normalised address, so the Redis
 * keyspace does not become a list of email addresses either.
 *
 * ── WHY REDIS, AND WHAT HAPPENS WHEN IT IS AWAY ────────────────────────────────────
 * Counted in Redis so every API replica sees the same count and a deploy does not wipe it. When
 * Redis cannot be reached (or a hand-built test harness has none) it falls back to a counter in
 * this process - the same rule as the throttler's storage (common/redis-throttler.storage.ts):
 * failing CLOSED would turn a Redis blip into nobody being able to sign in, and failing OPEN
 * would switch the protection off for exactly as long as an attacker can keep Redis busy. The
 * fallback is per-process (so N replicas allow N times the budget) and is bounded in size so it
 * cannot itself be used to exhaust memory. The transition is logged once each way.
 */

export interface LoginBackoffSettings {
  /** Failures inside the window before the account has to wait. */
  threshold: number;
  /** How long a failure is remembered, counted from the most recent one. */
  windowMs: number;
  /** The first wait; each further failure doubles it. */
  baseDelayMs: number;
  /** The longest wait there can ever be. */
  maxDelayMs: number;
}

export const LOGIN_BACKOFF_DEFAULTS: LoginBackoffSettings = {
  threshold: 5,
  windowMs: 15 * 60_000,
  baseDelayMs: 30_000,
  maxDelayMs: 15 * 60_000,
};

/** The most addresses the in-process fallback remembers before it forgets the oldest. */
const MEMORY_LIMIT = 10_000;

/**
 * Count one failure and, at or past the threshold, start (or lengthen) the wait.
 *
 * One script, for the reason the throttler's is one script: INCR then PEXPIRE as two round trips
 * can leave a counter with no expiry if the process dies between them, and a counter that never
 * expires is exactly the permanent lock this file promises not to create.
 *
 * The counter is kept for `window + delay`, not just `window`, so that once the wait is over the
 * NEXT failure still finds the count and doubles the wait rather than starting again from one.
 */
const FAIL_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
local threshold = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local base = tonumber(ARGV[3])
local cap = tonumber(ARGV[4])
local delay = 0
if n >= threshold then
  delay = base * (2 ^ math.min(n - threshold, 30))
  if delay > cap then delay = cap end
  redis.call('SET', KEYS[2], '1', 'PX', math.floor(delay))
end
redis.call('PEXPIRE', KEYS[1], math.floor(window + delay))
return {n, math.floor(delay)}
`;

export function delayAfter(failures: number, s: LoginBackoffSettings): number {
  if (failures < s.threshold) return 0;
  return Math.min(s.maxDelayMs, s.baseDelayMs * 2 ** Math.min(failures - s.threshold, 30));
}

/** One spelling of an address, whatever the person typed: trimmed and lower-cased. */
export function backoffSubject(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

interface MemoryEntry {
  failures: number;
  forgetAt: number;
  waitUntil: number;
}

@Injectable()
export class LoginBackoff {
  private readonly logger = new Logger(LoginBackoff.name);
  private readonly settings: LoginBackoffSettings;
  private readonly prefix: string;
  private readonly memory = new Map<string, MemoryEntry>();
  private degraded = false;
  /** The clock, replaceable by a test so a fifteen-minute wait does not take fifteen minutes. */
  now: () => number = Date.now;

  constructor(
    // Optional so a harness with no Redis still gets a working (per-process) backoff.
    @Optional() private readonly redis?: RedisService,
    @Optional() config?: ConfigService,
  ) {
    const minutes = (key: string, fallback: number) =>
      Number(config?.get(key) ?? fallback / 60_000) * 60_000;
    this.settings = {
      threshold: Number(config?.get('LOGIN_BACKOFF_THRESHOLD') ?? LOGIN_BACKOFF_DEFAULTS.threshold),
      windowMs: minutes('LOGIN_BACKOFF_WINDOW_MINUTES', LOGIN_BACKOFF_DEFAULTS.windowMs),
      baseDelayMs:
        Number(
          config?.get('LOGIN_BACKOFF_BASE_SECONDS') ?? LOGIN_BACKOFF_DEFAULTS.baseDelayMs / 1000,
        ) * 1000,
      maxDelayMs: minutes('LOGIN_BACKOFF_MAX_MINUTES', LOGIN_BACKOFF_DEFAULTS.maxDelayMs),
    };
    this.prefix = `${redisEnvRoot(config?.get<string>('APP_ENV'))}:login-backoff:`;
  }

  /** Milliseconds this address must still wait before a password is checked; 0 = go ahead. */
  async waitFor(email: string): Promise<number> {
    const subject = backoffSubject(email);
    if (this.redis) {
      try {
        const ttl = await this.redis.client.pttl(`${this.prefix}${subject}:wait`);
        this.recovered();
        return ttl > 0 ? ttl : 0;
      } catch (err) {
        this.degrade(err);
      }
    }
    const entry = this.memoryEntry(subject);
    return entry ? Math.max(0, entry.waitUntil - this.now()) : 0;
  }

  /** Count one wrong password (or unknown address). Returns the wait it started, if any. */
  async recordFailure(email: string): Promise<number> {
    const subject = backoffSubject(email);
    const s = this.settings;
    if (this.redis) {
      try {
        const [, delay] = (await this.redis.client.eval(
          FAIL_SCRIPT,
          2,
          `${this.prefix}${subject}:n`,
          `${this.prefix}${subject}:wait`,
          String(s.threshold),
          String(s.windowMs),
          String(s.baseDelayMs),
          String(s.maxDelayMs),
        )) as [number, number];
        this.recovered();
        return delay;
      } catch (err) {
        this.degrade(err);
      }
    }
    const now = this.now();
    const failures = (this.memoryEntry(subject)?.failures ?? 0) + 1;
    const delay = delayAfter(failures, s);
    // Re-inserted so Map order stays oldest-first, which is what the size bound evicts by.
    this.memory.delete(subject);
    this.memory.set(subject, {
      failures,
      forgetAt: now + s.windowMs + delay,
      waitUntil: delay > 0 ? now + delay : 0,
    });
    while (this.memory.size > MEMORY_LIMIT) {
      this.memory.delete(this.memory.keys().next().value as string);
    }
    return delay;
  }

  /** A correct password (or a completed reset) clears the count for that address. */
  async reset(email: string): Promise<void> {
    const subject = backoffSubject(email);
    this.memory.delete(subject);
    if (!this.redis) return;
    try {
      await this.redis.client.del(`${this.prefix}${subject}:n`, `${this.prefix}${subject}:wait`);
      this.recovered();
    } catch (err) {
      this.degrade(err);
    }
  }

  private memoryEntry(subject: string): MemoryEntry | undefined {
    const entry = this.memory.get(subject);
    if (entry && entry.forgetAt <= this.now()) {
      this.memory.delete(subject);
      return undefined;
    }
    return entry;
  }

  private degrade(err: unknown): void {
    if (this.degraded) return;
    this.degraded = true;
    this.logger.warn(
      `Sign-in backoff is counting in this process only (Redis unreachable): ${(err as Error)?.message}`,
    );
  }

  private recovered(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.logger.log('Sign-in backoff is shared again (Redis reachable).');
  }
}
