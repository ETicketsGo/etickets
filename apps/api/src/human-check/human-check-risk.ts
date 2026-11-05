import { isIP } from 'node:net';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { redisEnvRoot } from '../common/redis-namespace';

/**
 * "Does this caller look risky?" for adaptive mode. One signal, on purpose.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────────────
 * A caller is risky on a route class when its network has already made more than N requests to
 * that class in the window (default: 3 in 10 minutes for code, sign-up and email sends, 5 for
 * sign-in and guest checkout). The first N go through with no challenge at all; from N+1 a token
 * is asked for until the window runs out. It is easy to explain to an organizer whose customer
 * got a challenge ("you tried four times in ten minutes") and easy to test.
 *
 * It sits BELOW the throttle (10 a minute per route) on purpose, so the throttle's "near its
 * limit" is always already "past this threshold" - one counter covers both signals. A score
 * built from user agents, header order or geography would catch more and explain less, and the
 * thing it got wrong would be a real customer who cannot say why.
 *
 * ── WHY THE NETWORK AND NOT THE ADDRESS, FOR IPv6 ──────────────────────────────────
 * One IPv6 customer is normally given a whole /64, and can pick a fresh address in it for every
 * request. Counting single addresses would give that caller an unlimited supply of "first
 * attempts". So IPv6 counts by /64; IPv4 by the address. A shared network (an office, a mobile
 * carrier's NAT) does share a count: the effect is one managed challenge, usually solved without
 * a click, never a block. A caller on a different network is not affected at all.
 *
 * ── WHEN REDIS IS AWAY ─────────────────────────────────────────────────────────────
 * Same choice as the throttler storage: count in this process instead. A counter per replica is
 * weaker than a shared one and much better than none, and neither refusing every sign-in nor
 * waving every request through is a defensible answer to a cache outage.
 */

/** Atomic count-and-expire, so a crash between the two cannot leave a counter that never resets. */
const INCREMENT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/** Set-if-absent with an expiry: 1 the first time a key is claimed, 0 on every later try. */
const CLAIM = `
if redis.call('SET', KEYS[1], '1', 'NX', 'PX', ARGV[1]) then return 1 end
return 0
`;

/** Expand an IPv6 address to eight groups, or null when it is not one. */
function ipv6Groups(ip: string): string[] | null {
  if (isIP(ip) !== 6) return null;
  let addr = ip.split('%')[0].toLowerCase();
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    addr =
      addr.slice(0, v4.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : new Array(8 - left.length - right.length).fill('0');
  const groups = [...left, ...fill, ...right];
  return groups.length === 8 ? groups.map((g) => g.padStart(4, '0')) : null;
}

/**
 * The key a client's attempts are counted under: the IPv4 address, or the IPv6 /64.
 *
 * Exported for tests: two addresses in one /64 must be one key, and two /64s must be two.
 */
export function networkKeyFor(ip: string): string {
  const groups = ipv6Groups(ip);
  if (groups) return `${groups.slice(0, 4).join(':')}::/64`;
  return ip || 'unknown';
}

@Injectable()
export class HumanCheckRisk {
  private readonly logger = new Logger(HumanCheckRisk.name);
  private readonly prefix: string;
  /** The degraded path: per-process counts with their own expiry. */
  private readonly local = new Map<string, { count: number; expiresAt: number }>();
  private degraded = false;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.prefix = `${redisEnvRoot(config.get<string>('APP_ENV'))}:humancheck`;
  }

  /** Count this attempt and return how many the network has made in the window, this one included. */
  async hit(action: string, ip: string, windowSeconds: number): Promise<number> {
    const key = `${this.prefix}:${action}:${networkKeyFor(ip)}`;
    const windowMs = windowSeconds * 1000;
    try {
      const n = Number(await this.redis.client.eval(INCREMENT, 1, key, String(windowMs)));
      if (this.degraded) {
        this.degraded = false;
        this.logger.log('Human-check counters are back on Redis.');
      }
      if (Number.isFinite(n)) return n;
    } catch {
      if (!this.degraded) {
        this.degraded = true;
        this.logger.warn(
          'Redis unavailable: human-check counters are per process until it returns.',
        );
      }
    }
    return this.hitLocally(key, windowMs);
  }

  /**
   * Claim a one-use value (a Play Integrity nonce) for `ttlSeconds`. True the first time only.
   *
   * With Redis away the claim is per process, like the counters: a replay to another replica
   * would get through for the outage, which is weaker than shared and much better than none.
   */
  async claimOnce(kind: string, value: string, ttlSeconds: number): Promise<boolean> {
    const key = `${this.prefix}:once:${kind}:${value}`;
    const ttlMs = ttlSeconds * 1000;
    try {
      const n = Number(await this.redis.client.eval(CLAIM, 1, key, String(ttlMs)));
      if (n === 0 || n === 1) return n === 1;
    } catch {
      if (!this.degraded) {
        this.degraded = true;
        this.logger.warn(
          'Redis unavailable: human-check counters are per process until it returns.',
        );
      }
    }
    const now = Date.now();
    const entry = this.local.get(key);
    if (entry && entry.expiresAt > now) return false;
    if (this.local.size > 10_000) {
      for (const [k, v] of this.local) if (v.expiresAt <= now) this.local.delete(k);
    }
    this.local.set(key, { count: 1, expiresAt: now + ttlMs });
    return true;
  }

  private hitLocally(key: string, windowMs: number): number {
    const now = Date.now();
    // Bounded: a flood of distinct addresses must not grow this map without limit.
    if (this.local.size > 10_000) {
      for (const [k, v] of this.local) if (v.expiresAt <= now) this.local.delete(k);
      if (this.local.size > 10_000) this.local.clear();
    }
    const entry = this.local.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.local.set(key, { count: 1, expiresAt: now + windowMs });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }
}
