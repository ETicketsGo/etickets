import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { otpSmsKeyPrefix } from '../common/redis-namespace';
import { otpSmsBudgetAlert } from '../ops/alerts/ops-alert-messages';
import { OpsAlertService } from '../ops/alerts/ops-alert.service';
import { RedisService } from '../redis/redis.service';

/**
 * How many sign-in codes may be texted: per number, and in total per day.
 *
 * ── THE FAILURES THIS CLOSES ───────────────────────────────────────────────────────
 * The only limit used to be "five codes per number per hour", read as a Postgres COUNT and
 * then written as a separate INSERT. Three things were wrong with it:
 *
 *   1. **It was not atomic.** Twenty requests for one number fired at once all read "0 sent"
 *      before any of them wrote, so all twenty were texted. A limit that holds only for
 *      callers polite enough to wait is not a limit.
 *   2. **Nothing capped a day, or the whole platform.** An SMS-pumping attack does not text
 *      one number twenty times; it texts ten thousand numbers once each. A per-number limit
 *      cannot see that at all, so the bill had no ceiling but the attacker's patience.
 *   3. **There was no cooldown.** Pressing "send again" five times in ten seconds sent five
 *      texts, which costs five times as much and helps nobody - the first one is still coming.
 *
 * ── WHAT IT DOES NOW ───────────────────────────────────────────────────────────────
 * One Redis script does every check AND every increment, so there is no window between them:
 * Redis runs a script atomically, and twenty concurrent requests become twenty serial ones.
 * In order, a request is refused if the number has hit its DAILY cap, its HOURLY cap, or is
 * inside its resend COOLDOWN; then if the platform's daily BUDGET is spent, in total or for the
 * number's market. Only a request that passes everything is counted, so a refused request never
 * uses up anybody's allowance.
 *
 * A spent budget is a CIRCUIT BREAKER, not a rate limit: phone sign-in stops for everybody in
 * that market until the next UTC day, and the person is told to use email (which still works).
 * That is a real cost to real customers, and it is the right trade: the budget is set well above
 * honest traffic, so reaching it means somebody is spending our money, and stopping is cheaper
 * than paying for it. An operator is told once per trip, and once at 80% of it (configurable).
 *
 * ── PRIVACY ────────────────────────────────────────────────────────────────────────
 * Per-number keys carry a keyed hash (HMAC-SHA256 under the access-token secret), never the
 * number. A plain hash of a phone number is not private - there are only ten billion of them
 * per country code and a laptop hashes them all in minutes - so the key matters.
 *
 * ── WHEN REDIS IS AWAY ─────────────────────────────────────────────────────────────
 * Refusing every sign-in because a cache is down would turn a Redis blip into an outage, and
 * allowing uncounted sends would hand an attacker the mechanism (the same reasoning as
 * `common/redis-throttler.storage.ts`). So it falls back to counting `PhoneOtp` rows in
 * Postgres - the old rule - but under a transaction-scoped advisory lock, so it is atomic too.
 * See `reserveInTransaction`. The fallback enforces the per-number limits and the TOTAL daily
 * budget; it cannot tell US from Canadian numbers without Redis, so per-market budgets apply
 * only while Redis is up.
 */

/** Why a send was refused. `cooldown`, `hourly` and `daily` are about one number. */
export type OtpSendRefusal = 'daily' | 'hourly' | 'cooldown' | 'budget_total' | 'budget_market';

export type OtpReservation =
  | { status: 'allowed' }
  | { status: 'refused'; refusal: OtpSendRefusal; retryAfterSeconds: number }
  /** Redis could not be asked. The caller must use `reserveInTransaction` instead. */
  | { status: 'store_unavailable' };

export interface OtpSmsLimits {
  cooldownSeconds: number;
  perNumberPerHour: number;
  perNumberPerDay: number;
  dailyTotal: number;
  /** Market -> daily cap. A market with no entry is capped only by the total. */
  dailyByMarket: Record<string, number>;
  /** Percent of a budget at which an operator is warned, once per day. 0 turns it off. */
  warnPercent: number;
}

export const DEFAULT_OTP_SMS_LIMITS: OtpSmsLimits = {
  cooldownSeconds: 60,
  perNumberPerHour: 5,
  perNumberPerDay: 10,
  dailyTotal: 2000,
  dailyByMarket: { IN: 1500, US: 500, CA: 250 },
  warnPercent: 80,
};

/** The raw value of OTP_SMS_DAILY_LIMIT_BY_MARKET when it is unset. */
export const DEFAULT_OTP_SMS_DAILY_LIMIT_BY_MARKET = 'IN=1500,US=500,CA=250';

/**
 * Parse `IN=1500,US=500,CA=250`. An entry that is not `XX=<whole number>` is dropped rather
 * than guessed at; the boot-time schema refuses a malformed value before it gets here.
 */
export function parseMarketLimits(raw: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of (raw ?? '').split(',')) {
    const m = /^\s*([A-Za-z]{2})\s*=\s*(\d+)\s*$/.exec(entry);
    if (m) out[m[1].toUpperCase()] = Number(m[2]);
  }
  return out;
}

/** The limits for this process, from configuration, with the defaults above for anything unset. */
export function otpSmsLimits(config: { get<T>(key: string): T | undefined }): OtpSmsLimits {
  const num = (key: string, fallback: number, min: number): number => {
    const raw = config.get<string | number>(key);
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= min ? n : fallback;
  };
  const byMarketRaw = config.get<string>('OTP_SMS_DAILY_LIMIT_BY_MARKET');
  return {
    cooldownSeconds: num('OTP_SMS_RESEND_COOLDOWN_SECONDS', 60, 0),
    perNumberPerHour: num('OTP_SMS_MAX_PER_NUMBER_PER_HOUR', 5, 1),
    perNumberPerDay: num('OTP_SMS_MAX_PER_NUMBER_PER_DAY', 10, 1),
    dailyTotal: num('OTP_SMS_DAILY_LIMIT_TOTAL', 2000, 0),
    dailyByMarket: parseMarketLimits(byMarketRaw ?? DEFAULT_OTP_SMS_DAILY_LIMIT_BY_MARKET),
    warnPercent: num('OTP_SMS_BUDGET_WARN_PERCENT', 80, 0),
  };
}

/** The Redis keys one reservation touches, in the order the script reads them. */
export interface OtpSmsKeys {
  cooldown: string;
  hour: string;
  day: string;
  budgetTotal: string;
  budgetMarket: string;
  trippedTotal: string;
  trippedMarket: string;
  warnedTotal: string;
  warnedMarket: string;
}

/** The script's arguments. All durations in MILLISECONDS; a limit of 0 means "no cap". */
export interface OtpSmsArgs {
  cooldownMs: number;
  perNumberPerHour: number;
  perNumberPerDay: number;
  dailyTotal: number;
  dailyMarket: number;
  warnTotalAt: number;
  warnMarketAt: number;
  budgetTtlMs: number;
}

/**
 * The script's answer: [status, retryAfterMs, flags, totalCount, marketCount].
 *
 * status: 0 allowed, 1 cooldown, 2 hourly, 3 daily, 4 total budget spent, 5 market budget spent.
 * flags: for 4 and 5, 1 when THIS request is the first to find the budget spent today (so it,
 * and only it, alerts). For 0, bit 1 = total warning crossed now, bit 2 = market warning.
 */
export type OtpSmsScriptResult = [number, number, number, number, number];

/**
 * Where the counters live. In production, Redis running `OTP_SMS_RESERVE_SCRIPT`; in unit tests,
 * an in-memory store that must behave identically (see `test-support/otp-sms-memory-store.ts`).
 */
export interface OtpSmsCounterStore {
  reserve(keys: OtpSmsKeys, args: OtpSmsArgs): Promise<OtpSmsScriptResult>;
}

export const OTP_SMS_COUNTER_STORE = 'OTP_SMS_COUNTER_STORE';
export const OTP_SMS_CLOCK = 'OTP_SMS_CLOCK';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Budget counters are per UTC day; kept two days so the key outlives its own day safely. */
const BUDGET_TTL_MS = 2 * DAY_MS;

/**
 * KEYS (9) in `OtpSmsKeys` order. ARGV (8) in `OtpSmsArgs` order. Returns `OtpSmsScriptResult`.
 *
 * One script, so every check and every increment happen with nothing in between - see the
 * class comment. Two rules from the throttler script are kept on purpose: a counter is given its
 * expiry in the same script that creates it, so no counter can be left without one (which would
 * lock a number out for good); and a refused request increments NOTHING, so hammering a limit
 * neither extends it nor eats the budget.
 */
export const OTP_SMS_RESERVE_SCRIPT = `
local cooldownMs = tonumber(ARGV[1])
local hourLimit = tonumber(ARGV[2])
local dayLimit = tonumber(ARGV[3])
local totalLimit = tonumber(ARGV[4])
local marketLimit = tonumber(ARGV[5])
local warnTotalAt = tonumber(ARGV[6])
local warnMarketAt = tonumber(ARGV[7])
local budgetTtlMs = tonumber(ARGV[8])
local HOUR_MS = 3600000
local DAY_MS = 86400000

local function count(key)
  return tonumber(redis.call('GET', key) or '0')
end
local function remaining(key)
  local t = redis.call('PTTL', key)
  if t < 0 then return 0 end
  return t
end
local function bump(key, windowMs)
  local n = redis.call('INCR', key)
  if n == 1 or redis.call('PTTL', key) < 0 then
    redis.call('PEXPIRE', key, windowMs)
  end
  return n
end

-- Per number: the longest wait first, because that is the most useful thing to be told.
if count(KEYS[3]) >= dayLimit then return { 3, remaining(KEYS[3]), 0, 0, 0 } end
if count(KEYS[2]) >= hourLimit then return { 2, remaining(KEYS[2]), 0, 0, 0 } end
local cooldown = redis.call('PTTL', KEYS[1])
if cooldown > 0 then return { 1, cooldown, 0, 0, 0 } end

-- The platform's budget. The first request to find it spent today is told so, to alert once.
local total = count(KEYS[4])
if totalLimit > 0 and total >= totalLimit then
  local first = 0
  if redis.call('SET', KEYS[6], '1', 'PX', budgetTtlMs, 'NX') then first = 1 end
  return { 4, 0, first, total, 0 }
end
local market = count(KEYS[5])
if marketLimit > 0 and market >= marketLimit then
  local first = 0
  if redis.call('SET', KEYS[7], '1', 'PX', budgetTtlMs, 'NX') then first = 1 end
  return { 5, 0, first, total, market }
end

-- Allowed: count it everywhere at once.
bump(KEYS[2], HOUR_MS)
bump(KEYS[3], DAY_MS)
total = bump(KEYS[4], budgetTtlMs)
market = bump(KEYS[5], budgetTtlMs)
if cooldownMs > 0 then redis.call('SET', KEYS[1], '1', 'PX', cooldownMs) end

local warn = 0
if warnTotalAt > 0 and total >= warnTotalAt then
  if redis.call('SET', KEYS[8], '1', 'PX', budgetTtlMs, 'NX') then warn = warn + 1 end
end
if marketLimit > 0 and warnMarketAt > 0 and market >= warnMarketAt then
  if redis.call('SET', KEYS[9], '1', 'PX', budgetTtlMs, 'NX') then warn = warn + 2 end
end
return { 0, 0, warn, total, market }
`;

/** The production store: the script above, on the API's shared Redis client. */
export class RedisOtpSmsCounterStore implements OtpSmsCounterStore {
  constructor(private readonly redis: RedisService) {}

  async reserve(keys: OtpSmsKeys, args: OtpSmsArgs): Promise<OtpSmsScriptResult> {
    const result = (await this.redis.client.eval(
      OTP_SMS_RESERVE_SCRIPT,
      9,
      keys.cooldown,
      keys.hour,
      keys.day,
      keys.budgetTotal,
      keys.budgetMarket,
      keys.trippedTotal,
      keys.trippedMarket,
      keys.warnedTotal,
      keys.warnedMarket,
      String(args.cooldownMs),
      String(args.perNumberPerHour),
      String(args.perNumberPerDay),
      String(args.dailyTotal),
      String(args.dailyMarket),
      String(args.warnTotalAt),
      String(args.warnMarketAt),
      String(args.budgetTtlMs),
    )) as unknown[];
    return result.map((v) => Number(v)) as OtpSmsScriptResult;
  }
}

/** Ids for the fallback's advisory lock. One for the whole platform; see `reserveInTransaction`. */
const FALLBACK_LOCK_KEY = 'otp-sms-send';

@Injectable()
export class OtpSmsGuard {
  private readonly logger = new Logger(OtpSmsGuard.name);
  private readonly limits: OtpSmsLimits;
  private readonly prefix: string;
  private readonly hashKey: string;
  private readonly store: OtpSmsCounterStore | null;
  /** Logged on each transition only, so an outage does not also flood the log. */
  private degraded = false;

  constructor(
    config: ConfigService,
    @Optional() redis?: RedisService,
    @Optional() private readonly alerts?: OpsAlertService,
    @Optional() @Inject(OTP_SMS_COUNTER_STORE) store?: OtpSmsCounterStore,
    @Optional() @Inject(OTP_SMS_CLOCK) private readonly now: () => number = Date.now,
  ) {
    this.limits = otpSmsLimits(config);
    this.prefix = otpSmsKeyPrefix(config.get<string>('APP_ENV'));
    /*
      The access-token secret is required everywhere the API runs (the schema refuses to boot
      without it), so per-number keys are unguessable in every real environment. The constant
      is for unit tests that construct this with an empty config.
    */
    this.hashKey = config.get<string>('JWT_ACCESS_SECRET') || 'otp-sms-unkeyed-test-only';
    this.store = store ?? (redis ? new RedisOtpSmsCounterStore(redis) : null);
  }

  get currentLimits(): Readonly<OtpSmsLimits> {
    return this.limits;
  }

  /** A stable, non-reversible id for a number. Never the number itself. */
  destinationId(phone: string): string {
    return createHmac('sha256', this.hashKey)
      .update(`otp-sms-destination:${phone}`)
      .digest('hex')
      .slice(0, 32);
  }

  /** The UTC day budgets are counted in, `YYYY-MM-DD`. */
  private day(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private warnAt(limit: number): number {
    if (limit <= 0 || this.limits.warnPercent <= 0) return 0;
    return Math.max(1, Math.ceil((limit * this.limits.warnPercent) / 100));
  }

  keysFor(phone: string, market: string): OtpSmsKeys {
    const dest = `${this.prefix}:dest:${this.destinationId(phone)}`;
    const budget = `${this.prefix}:budget:${this.day()}`;
    return {
      cooldown: `${dest}:cooldown`,
      hour: `${dest}:hour`,
      day: `${dest}:day`,
      budgetTotal: `${budget}:total`,
      budgetMarket: `${budget}:market:${market}`,
      trippedTotal: `${budget}:tripped:total`,
      trippedMarket: `${budget}:tripped:market:${market}`,
      warnedTotal: `${budget}:warned:total`,
      warnedMarket: `${budget}:warned:market:${market}`,
    };
  }

  /**
   * Check every limit and, only if all pass, count this send. Atomic; see the class comment.
   * Answers `store_unavailable` rather than throwing when Redis cannot be asked.
   */
  async reserve(phone: string, market: string): Promise<OtpReservation> {
    if (!this.store) return { status: 'store_unavailable' };
    const marketLimit = this.limits.dailyByMarket[market] ?? 0;
    let result: OtpSmsScriptResult;
    try {
      result = await this.store.reserve(this.keysFor(phone, market), {
        cooldownMs: this.limits.cooldownSeconds * 1000,
        perNumberPerHour: this.limits.perNumberPerHour,
        perNumberPerDay: this.limits.perNumberPerDay,
        dailyTotal: this.limits.dailyTotal,
        dailyMarket: marketLimit,
        warnTotalAt: this.warnAt(this.limits.dailyTotal),
        warnMarketAt: this.warnAt(marketLimit),
        budgetTtlMs: BUDGET_TTL_MS,
      });
    } catch (err) {
      if (!this.degraded) {
        this.degraded = true;
        this.logger.warn(
          'Sign-in text limits have fallen back to Postgres: Redis is unreachable. Per-number ' +
            'limits and the total daily budget still apply; per-market budgets do not. ' +
            `Cause: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return { status: 'store_unavailable' };
    }
    if (this.degraded) {
      this.degraded = false;
      this.logger.log('Sign-in text limits are counted in Redis again.');
    }

    const [status, retryAfterMs, flags, total, marketCount] = result;
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    switch (status) {
      case 0:
        if (flags & 1) this.alertBudget('warning', 'total', total, this.limits.dailyTotal);
        if (flags & 2) this.alertBudget('warning', market, marketCount, marketLimit);
        return { status: 'allowed' };
      case 1:
        return { status: 'refused', refusal: 'cooldown', retryAfterSeconds };
      case 2:
        return { status: 'refused', refusal: 'hourly', retryAfterSeconds };
      case 3:
        return { status: 'refused', refusal: 'daily', retryAfterSeconds };
      case 4:
        if (flags & 1) this.alertBudget('tripped', 'total', total, this.limits.dailyTotal);
        return { status: 'refused', refusal: 'budget_total', retryAfterSeconds: 0 };
      case 5:
        if (flags & 1) this.alertBudget('tripped', market, marketCount, marketLimit);
        return { status: 'refused', refusal: 'budget_market', retryAfterSeconds: 0 };
      default:
        /*
          An answer this code does not recognise is not permission. Treated as an unavailable
          store, so the Postgres path decides, which is never more generous than this one.
        */
        return { status: 'store_unavailable' };
    }
  }

  /**
   * The same decision, made in Postgres, for when Redis is away.
   *
   * Runs INSIDE the caller's transaction, which must insert the new `PhoneOtp` row before it
   * commits: the count and the insert are then one atomic step. The advisory lock is for the
   * whole platform, not per number, because the total budget is a whole-platform count; sign-in
   * code requests are few enough (and already throttled per client) that queueing them for a
   * few milliseconds each during an outage costs nothing anybody would notice.
   *
   * Counts `PhoneOtp` rows, which are written for every code issued - including one whose text
   * then failed - so a failed send still counts, as it does in Redis. That is the safe side:
   * a provider may well have charged for it.
   */
  async reserveInTransaction(tx: Prisma.TransactionClient, phone: string): Promise<OtpReservation> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FALLBACK_LOCK_KEY}))`;
    const now = this.now();
    const since = (ms: number) => new Date(now - ms);

    const lastDay = await tx.phoneOtp.count({
      where: { phone, createdAt: { gte: since(DAY_MS) } },
    });
    if (lastDay >= this.limits.perNumberPerDay) {
      return { status: 'refused', refusal: 'daily', retryAfterSeconds: DAY_MS / 1000 };
    }
    const lastHour = await tx.phoneOtp.count({
      where: { phone, createdAt: { gte: since(HOUR_MS) } },
    });
    if (lastHour >= this.limits.perNumberPerHour) {
      return { status: 'refused', refusal: 'hourly', retryAfterSeconds: HOUR_MS / 1000 };
    }
    const cooldownMs = this.limits.cooldownSeconds * 1000;
    if (cooldownMs > 0) {
      const recent = await tx.phoneOtp.count({
        // Strictly inside the window, as a Redis key that expires at exactly the cooldown is.
        where: { phone, createdAt: { gt: since(cooldownMs) } },
      });
      if (recent > 0) {
        return { status: 'refused', refusal: 'cooldown', retryAfterSeconds: cooldownMs / 1000 };
      }
    }

    if (this.limits.dailyTotal > 0) {
      const dayStart = new Date(`${this.day()}T00:00:00.000Z`);
      const today = await tx.phoneOtp.count({ where: { createdAt: { gte: dayStart } } });
      if (today >= this.limits.dailyTotal) {
        // Per-process dedupe only (Redis is down); the ops-alert throttle groups the rest.
        this.alertBudget('tripped', 'total', today, this.limits.dailyTotal);
        return { status: 'refused', refusal: 'budget_total', retryAfterSeconds: 0 };
      }
      const warnAt = this.warnAt(this.limits.dailyTotal);
      // Under the lock, exactly one request moves the count across the line.
      if (warnAt > 0 && today + 1 === warnAt) {
        this.alertBudget('warning', 'total', today + 1, this.limits.dailyTotal);
      }
    }
    return { status: 'allowed' };
  }

  /**
   * Tell an operator, without making the caller wait. Ids and counts only - never a number.
   *
   * Deduplicated twice: the script's SET NX means one request per day per budget ever gets
   * here for a trip, and the ops-alert throttle (keyed by phase, scope and day) catches the
   * Postgres fallback, where only a per-process memory exists.
   */
  private alertBudget(
    phase: 'tripped' | 'warning',
    scope: string,
    count: number,
    limit: number,
  ): void {
    if (!this.alerts) return;
    void this.alerts.notify(
      otpSmsBudgetAlert({
        phase,
        scope,
        sentToday: count,
        dailyLimit: limit,
        warnPercent: this.limits.warnPercent,
        dayUtc: this.day(),
      }),
    );
  }
}
