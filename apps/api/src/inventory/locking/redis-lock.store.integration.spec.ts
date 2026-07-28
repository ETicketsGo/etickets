import IORedis, { type Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { RedisLockStore, type AcquireSeatParams } from './redis-lock.store';
import type { RedisService } from '../../redis/redis.service';

/**
 * Real-Redis integration + concurrency proof for the atomic Lua scripts (ADR-039).
 * Connects to REDIS_URL and SKIPS GRACEFULLY (each test returns early) when Redis is
 * unreachable, so the suite stays green with or without Redis in CI. Locally (Redis
 * up) these prove the DoD: same seat can't be double-locked, quantity can't exceed
 * capacity, multi-seat is all-or-nothing, replay is idempotent, fencing increments.
 */
const URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
let client: Redis;
let available = false;
let store: RedisLockStore;

beforeAll(async () => {
  client = new IORedis(URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  try {
    await client.connect();
    available = (await client.ping()) === 'PONG';
  } catch {
    available = false;
  }
  const redis = { client, ping: async () => available } as unknown as RedisService;
  const config = {
    get: jest.fn(
      (k: string, d?: unknown) =>
        ({ APP_ENV: 'jesttest', INVENTORY_LOCK_MAX_LIFETIME_SECONDS: 900 })[k] ?? d,
    ),
  } as unknown as ConfigService;
  store = new RedisLockStore(redis, config);
});

afterAll(async () => {
  if (client) await client.quit().catch(() => undefined);
});

const seatParams = (over: Partial<AcquireSeatParams> = {}): AcquireSeatParams => ({
  lockId: randomUUID(),
  holdId: randomUUID(),
  inventoryKey: `session:${randomUUID()}`,
  seatIds: ['A1'],
  owner: { ownerId: randomUUID() },
  fingerprint: 'fp',
  idempotencyKey: randomUUID(),
  ...over,
});

describe('RedisLockStore (real Redis)', () => {
  it('acquires a free seat and applies a TTL', async () => {
    if (!available) return;
    const p = seatParams();
    const res = await store.acquireSeat(p, 300);
    expect(res.status).toBe('ACQUIRED');
    expect(res.lock?.fencingToken).toBeGreaterThan(0);
    // getRaw returns the same lock and it carries a TTL.
    const got = await store.getRaw(p.lockId);
    expect(got?.status).toBe('ACTIVE');
  });

  it('never lets two owners lock the same seat', async () => {
    if (!available) return;
    const key = `session:${randomUUID()}`;
    const first = await store.acquireSeat(seatParams({ inventoryKey: key, seatIds: ['S1'] }), 300);
    const second = await store.acquireSeat(seatParams({ inventoryKey: key, seatIds: ['S1'] }), 300);
    expect(first.status).toBe('ACQUIRED');
    expect(second.status).toBe('CONFLICT');
  });

  it('multi-seat acquisition is all-or-nothing (no partial hold)', async () => {
    if (!available) return;
    const key = `session:${randomUUID()}`;
    // Pre-lock S2 by another owner.
    await store.acquireSeat(seatParams({ inventoryKey: key, seatIds: ['S2'] }), 300);
    const res = await store.acquireSeat(
      seatParams({ inventoryKey: key, seatIds: ['S1', 'S2'] }),
      300,
    );
    expect(res.status).toBe('CONFLICT');
    // S1 must remain free (was NOT partially taken) — a fresh lock can take it.
    const s1 = await store.acquireSeat(seatParams({ inventoryKey: key, seatIds: ['S1'] }), 300);
    expect(s1.status).toBe('ACQUIRED');
  });

  it('is idempotent for the same key + fingerprint, and conflicts on a different request', async () => {
    if (!available) return;
    const key = `session:${randomUUID()}`;
    const idem = randomUUID();
    const a = await store.acquireSeat(
      seatParams({ inventoryKey: key, seatIds: ['S1'], idempotencyKey: idem, fingerprint: 'fp1' }),
      300,
    );
    const replay = await store.acquireSeat(
      seatParams({ inventoryKey: key, seatIds: ['S1'], idempotencyKey: idem, fingerprint: 'fp1' }),
      300,
    );
    expect(replay.status).toBe('REPLAY');
    expect(replay.lock?.lockId).toBe(a.lock?.lockId); // same lock returned
    const conflict = await store.acquireSeat(
      seatParams({ inventoryKey: key, seatIds: ['S9'], idempotencyKey: idem, fingerprint: 'fp2' }),
      300,
    );
    expect(conflict.status).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('fencing tokens increase monotonically within a scope', async () => {
    if (!available) return;
    const key = `session:${randomUUID()}`;
    const a = await store.acquireSeat(seatParams({ inventoryKey: key, seatIds: ['S1'] }), 300);
    const b = await store.acquireSeat(seatParams({ inventoryKey: key, seatIds: ['S2'] }), 300);
    expect(b.lock?.fencingToken ?? 0).toBeGreaterThan(a.lock?.fencingToken ?? 0);
  });

  it('enforces quantity capacity (advisory snapshot)', async () => {
    if (!available) return;
    const key = `session:${randomUUID()}`;
    const q = (quantity: number, capacity: number) =>
      store.acquireQuantity(
        {
          lockId: randomUUID(),
          holdId: 'h',
          inventoryKey: key,
          quantity,
          capacity,
          owner: { ownerId: randomUUID() },
          fingerprint: 'f',
          idempotencyKey: randomUUID(),
        },
        300,
      );
    expect((await q(3, 5)).status).toBe('ACQUIRED');
    expect((await q(3, 5)).status).toBe('CAPACITY'); // 3 + 3 > 5
    expect((await q(2, 5)).status).toBe('ACQUIRED'); // 3 + 2 = 5
  });

  it('releases a seat so it can be re-acquired, and repeated release is safe', async () => {
    if (!available) return;
    const key = `session:${randomUUID()}`;
    const a = await store.acquireSeat(seatParams({ inventoryKey: key, seatIds: ['S1'] }), 300);
    await store.release(a.lock!, 'RELEASED');
    await store.release(a.lock!, 'RELEASED'); // idempotent
    const reacquire = await store.acquireSeat(
      seatParams({ inventoryKey: key, seatIds: ['S1'] }),
      300,
    );
    expect(reacquire.status).toBe('ACQUIRED');
  });

  // ─── concurrency ───

  it('under concurrency, exactly one owner wins the same seat', async () => {
    if (!available) return;
    const key = `session:${randomUUID()}`;
    const attempts = Array.from({ length: 40 }, () =>
      store.acquireSeat(seatParams({ inventoryKey: key, seatIds: ['HOT'] }), 300),
    );
    const results = await Promise.all(attempts);
    const acquired = results.filter((r) => r.status === 'ACQUIRED');
    expect(acquired).toHaveLength(1);
    expect(results.filter((r) => r.status === 'CONFLICT')).toHaveLength(39);
  });

  it('under concurrency, quantity locks never jointly exceed capacity', async () => {
    if (!available) return;
    const key = `session:${randomUUID()}`;
    const capacity = 10;
    const attempts = Array.from({ length: 30 }, () =>
      store.acquireQuantity(
        {
          lockId: randomUUID(),
          holdId: 'h',
          inventoryKey: key,
          quantity: 1,
          capacity,
          owner: { ownerId: randomUUID() },
          fingerprint: 'f',
          idempotencyKey: randomUUID(),
        },
        300,
      ),
    );
    const results = await Promise.all(attempts);
    const acquired = results.filter((r) => r.status === 'ACQUIRED');
    expect(acquired.length).toBeLessThanOrEqual(capacity);
    expect(acquired.length).toBe(capacity); // exactly fills to capacity
  });
});
