import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  Body,
  Controller,
  HttpCode,
  type INestApplication,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import IORedis, { type Redis } from 'ioredis';
import type { RedisService } from '../redis/redis.service';
import { AUTH_THROTTLE, throttlerOptions } from './throttle';

/**
 * The credential limit across TWO application instances that share one store, through the
 * production wiring (`throttlerOptions`), over real HTTP with `trust proxy = 1` as main.ts sets.
 *
 * ── WHAT WENT WRONG ON QA ──────────────────────────────────────────────────────────
 * Fifteen wrong logins in a row all got 401, and `x-ratelimit-remaining` fell one per TWO
 * requests: the key was `req.ip`, which behind Railway is the edge proxy node, and the requests
 * alternated between two nodes. The same shape appears with two replicas and per-process
 * counters. Both are reproduced here, and both must give exactly N, then 429.
 *
 * Runs against an in-process stand-in for Redis that honours the storage script's contract,
 * and again against a real Redis when one is reachable (CI provides one at REDIS_URL).
 */

const N = AUTH_THROTTLE.default.limit;

/** Port of the storage's Lua script: same keys, same expiry rules, same return shape. */
class FakeRedis {
  down = false;
  private readonly keys = new Map<string, { value: number; expiresAt: number }>();

  private live(key: string) {
    const entry = this.keys.get(key);
    if (entry && entry.expiresAt <= Date.now()) this.keys.delete(key);
    return this.keys.get(key);
  }

  async eval(
    _script: string,
    _numKeys: number,
    hitKey: string,
    blockKey: string,
    ttlArg: string,
    limitArg: string,
    blockArg: string,
  ): Promise<[number, number, number, number]> {
    if (this.down) throw new Error('Connection is closed.');
    const ttl = Number(ttlArg);
    const limit = Number(limitArg);
    const blockDuration = Number(blockArg);
    const seconds = (ms: number) => Math.ceil(ms / 1000);
    const now = Date.now();

    const block = this.live(blockKey);
    if (block)
      return [
        this.live(hitKey)?.value ?? 0,
        seconds(block.expiresAt - now),
        1,
        seconds(block.expiresAt - now),
      ];

    const hit = this.live(hitKey) ?? { value: 0, expiresAt: now + ttl };
    hit.value += 1;
    this.keys.set(hitKey, hit);
    const expire = hit.expiresAt - now;
    if (hit.value > limit && blockDuration > 0) {
      this.keys.set(blockKey, { value: 1, expiresAt: now + blockDuration });
      return [hit.value, seconds(expire), 1, seconds(blockDuration)];
    }
    return [hit.value, seconds(expire), 0, 0];
  }
}

@Controller('auth')
class ProbeAuthController {
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @HttpCode(200)
  login(@Body() body: { password?: string }) {
    if (body?.password !== 'right-password') throw new UnauthorizedException();
    return { ok: true };
  }
}

interface Instance {
  base: string;
  app: INestApplication;
}

async function startInstance(client: unknown, env: Record<string, string>): Promise<Instance> {
  const config = { get: <T>(k: string) => env[k] as T | undefined };
  const redis = { client } as unknown as RedisService;
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot(throttlerOptions(config, redis, env))],
    controllers: [ProbeAuthController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  // Exactly what main.ts does with the default TRUST_PROXY_HOPS.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, app };
}

async function login(instance: Instance, headers: Record<string, string>, password = 'wrong') {
  const res = await fetch(`${instance.base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ password }),
  });
  return res.status;
}

/** A Railway-shaped request: the edge sets X-Real-IP; the right-most XFF entry is the edge node. */
function viaRailway(client: string, edgeNode: string, spoofed?: string): Record<string, string> {
  return {
    'x-real-ip': client,
    'x-forwarded-for': [spoofed, client, edgeNode].filter(Boolean).join(', '),
  };
}

let realRedis: Redis | null = null;

beforeAll(async () => {
  const client = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 1000,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    realRedis = (await client.ping()) === 'PONG' ? client : null;
  } catch {
    realRedis = null;
  }
  if (!realRedis) client.disconnect();
});

afterAll(async () => {
  if (realRedis) await realRedis.quit().catch(() => undefined);
});

const backends: Array<[string, () => unknown]> = [
  ['in-process store', () => new FakeRedis()],
  ['real Redis', () => realRedis],
];

describe.each(backends)('two instances sharing one %s', (_name, makeClient) => {
  let a: Instance;
  let b: Instance;
  let available = true;

  /** A fresh namespace per test, so a real Redis shared with other runs never leaks counts. */
  async function start(extra: Record<string, string> = {}) {
    const client = makeClient();
    available = Boolean(client);
    if (!available) return;
    const env = { APP_ENV: `JEST${randomUUID().slice(0, 8)}`, ...extra };
    a = await startInstance(client, env);
    b = await startInstance(client, env);
  }

  afterEach(async () => {
    if (a) await a.app.close();
    if (b) await b.app.close();
  });

  it('allows exactly N attempts, then 429, wherever each request lands', async () => {
    await start({ RAILWAY_ENVIRONMENT_ID: 'env-test' });
    if (!available) return;
    const statuses: number[] = [];
    for (let i = 0; i < N + 2; i++) {
      // Alternate instances AND edge nodes: the two ways QA split one client in two.
      statuses.push(await login(i % 2 ? b : a, viaRailway('198.51.100.20', `100.64.0.${i % 2}`)));
    }
    expect(statuses.slice(0, N)).toEqual(Array(N).fill(401));
    expect(statuses.slice(N)).toEqual([429, 429]);
  });

  it('counts the visitor, not the Railway edge node that carried the request', async () => {
    await start({ RAILWAY_ENVIRONMENT_ID: 'env-test' });
    if (!available) return;
    // One instance, so only the KEY can be wrong: each request through a different edge node.
    for (let i = 0; i < N; i++) {
      expect(await login(a, viaRailway('198.51.100.21', `100.64.1.${i}`))).toBe(401);
    }
    expect(await login(a, viaRailway('198.51.100.21', '100.64.1.250'))).toBe(429);
  });

  it('keeps different visitors independent', async () => {
    await start({ RAILWAY_ENVIRONMENT_ID: 'env-test' });
    if (!available) return;
    for (let i = 0; i < N + 1; i++) await login(a, viaRailway('198.51.100.22', '100.64.0.1'));
    expect(await login(a, viaRailway('198.51.100.22', '100.64.0.1'))).toBe(429);
    // Same edge node, same instance, different person: untouched by the first one's block.
    expect(await login(b, viaRailway('198.51.100.23', '100.64.0.1'))).toBe(401);
  });

  it('cannot be reset by inventing X-Forwarded-For entries (Railway)', async () => {
    await start({ RAILWAY_ENVIRONMENT_ID: 'env-test' });
    if (!available) return;
    const statuses: number[] = [];
    for (let i = 0; i < N + 1; i++) {
      statuses.push(await login(a, viaRailway('198.51.100.24', '100.64.0.1', `203.0.113.${i}`)));
    }
    expect(statuses[N]).toBe(429);
  });

  it('cannot be reset by inventing X-Forwarded-For entries beyond the trusted hop (off Railway)', async () => {
    // No Railway, so req.ip with trust proxy = 1: the right-most entry, which the proxy appended.
    await start();
    if (!available) return;
    const statuses: number[] = [];
    for (let i = 0; i < N + 1; i++) {
      statuses.push(
        await login(i % 2 ? b : a, {
          'x-forwarded-for': `203.0.113.${i}, 198.51.100.25`,
          // Off Railway nothing overwrites this, so it must not be believed either.
          'x-real-ip': `203.0.113.${i}`,
        }),
      );
    }
    expect(statuses.slice(0, N)).toEqual(Array(N).fill(401));
    expect(statuses[N]).toBe(429);
  });

  it('does not block a legitimate user after a success', async () => {
    await start({ RAILWAY_ENVIRONMENT_ID: 'env-test' });
    if (!available) return;
    const who = viaRailway('198.51.100.26', '100.64.0.1');
    for (let i = 0; i < 3; i++) expect(await login(a, who)).toBe(401);
    expect(await login(b, who, 'right-password')).toBe(200);
    expect(await login(a, who, 'right-password')).toBe(200);
  });
});

describe('when the shared store is down', () => {
  let a: Instance | undefined;
  afterEach(async () => {
    if (a) await a.app.close();
    a = undefined;
  });

  it('still serves sign-in, and still limits from per-process memory', async () => {
    const store = new FakeRedis();
    store.down = true;
    a = await startInstance(store, { APP_ENV: 'QA', RAILWAY_ENVIRONMENT_ID: 'env-test' });
    const who = viaRailway('198.51.100.27', '100.64.0.1');
    expect(await login(a, who, 'right-password')).toBe(200);
    const statuses: number[] = [];
    for (let i = 0; i < N; i++) statuses.push(await login(a, who));
    // The success above was hit 1, so hits 2..N are 401 and hit N+1 is refused.
    expect(statuses.slice(0, N - 1)).toEqual(Array(N - 1).fill(401));
    expect(statuses[N - 1]).toBe(429);
  });
});

describe('the old default, for contrast', () => {
  let a: Instance;
  let b: Instance;
  afterEach(async () => {
    await a.app.close();
    await b.app.close();
  });

  it('per-process counters behind round-robin give the limit twice', async () => {
    // What every deployed environment ran: THROTTLE_STORAGE unset meant memory.
    const env = { APP_ENV: 'QA', THROTTLE_STORAGE: 'memory', RAILWAY_ENVIRONMENT_ID: 'env-test' };
    a = await startInstance(null, env);
    b = await startInstance(null, env);
    const statuses: number[] = [];
    for (let i = 0; i < N + 2; i++) {
      statuses.push(await login(i % 2 ? b : a, viaRailway('198.51.100.28', '100.64.0.1')));
    }
    // Each instance has seen at most N/2 + 1 attempts, so none refuses: the QA symptom.
    expect(statuses).not.toContain(429);
  });
});
