import type { AddressInfo } from 'node:net';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { RedisService } from '../redis/redis.service';
import { INTERNAL_CLIENT_IP_HEADER, INTERNAL_KEY_HEADER } from './client-ip';
import { throttlerOptions } from './throttle';

/**
 * integration - whose budget a storefront page render spends, over real HTTP through the
 * production throttler wiring (`throttlerOptions`, the global limit, `trust proxy = 1`).
 *
 * PROD, 2026-11-08: every page render read the API through the public URL, so the edge stamped
 * the storefront's own address on all of them and every visitor shared one budget. These pin
 * the replacement (client-ip.ts): over the private network, with the shared secret, a render
 * spends its VISITOR'S budget - and nothing else can choose the key, or skip the limit.
 */

const KEY = 'k'.repeat(24) + '-internal-test-secret-0001'; // 50 characters
const LIMIT = 3;
const EGRESS = '152.55.10.20'; // the storefront's public egress, as the edge saw it before

@Controller('public')
class ProbeController {
  @Get('events')
  list() {
    return { data: [] };
  }
}

async function start(
  extraEnv: Record<string, string> = {},
): Promise<{ base: string; app: INestApplication }> {
  const env: Record<string, string> = {
    THROTTLE_STORAGE: 'memory',
    THROTTLE_LIMIT: String(LIMIT),
    RAILWAY_ENVIRONMENT_ID: 'env-test', // on Railway: the edge's x-real-ip is the trusted header
    INTERNAL_API_KEY: KEY,
    ...extraEnv,
  };
  const config = { get: <T>(k: string) => env[k] as T | undefined };
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot(throttlerOptions(config, {} as RedisService, env))],
    controllers: [ProbeController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, app };
}

const statuses = async (base: string, headers: Record<string, string>, n: number) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await fetch(`${base}/public/events`, { headers })).status);
  return out;
};

/** A render arriving over the private network: no edge header, the secret, the visitor. */
const internal = (visitor: string, key = KEY): Record<string, string> => ({
  [INTERNAL_KEY_HEADER]: key,
  [INTERNAL_CLIENT_IP_HEADER]: visitor,
});

describe('storefront renders and the rate limit', () => {
  let srv: { base: string; app: INestApplication };
  beforeEach(async () => {
    srv = await start();
  });
  afterEach(async () => {
    await srv.app.close();
  });

  it('BEFORE: renders through the public URL share the storefront egress budget', async () => {
    // Three different visitors, but the edge only ever saw the storefront's address.
    const seen = await statuses(srv.base, { 'x-real-ip': EGRESS }, LIMIT + 1);
    expect(seen).toEqual([200, 200, 200, 429]);
  });

  it('isolates visitors: each private-network render spends its own visitor budget', async () => {
    for (const visitor of ['24.117.1.2', '49.36.8.9', '2401:4900:1c2a::7']) {
      expect(await statuses(srv.base, internal(visitor), LIMIT)).toEqual([200, 200, 200]);
    }
  });

  it('still limits: one visitor hammering storefront pages runs out of their own budget', async () => {
    expect(await statuses(srv.base, internal('24.117.1.2'), LIMIT + 1)).toEqual([
      200, 200, 200, 429,
    ]);
    // ...and that visitor's exhaustion is not anybody else's.
    expect(await statuses(srv.base, internal('49.36.8.9'), 1)).toEqual([200]);
  });

  it('shares the budget with the same visitor browsing directly (one person, one budget)', async () => {
    expect(await statuses(srv.base, internal('24.117.1.2'), 2)).toEqual([200, 200]);
    expect(await statuses(srv.base, { 'x-real-ip': '24.117.1.2' }, 2)).toEqual([200, 429]);
  });

  it('SPOOF: from the internet, even WITH the secret, the forwarded address is ignored', async () => {
    // Came through the public edge (x-real-ip present): keyed on the edge's address.
    const seen: number[] = [];
    for (let i = 0; i < LIMIT + 1; i++) {
      const r = await fetch(`${srv.base}/public/events`, {
        headers: { 'x-real-ip': '203.0.113.50', ...internal(`198.51.100.${i}`) },
      });
      seen.push(r.status);
    }
    expect(seen).toEqual([200, 200, 200, 429]);
  });

  it('SPOOF: a wrong or missing secret cannot rotate the key', async () => {
    for (const key of ['wrong-' + KEY.slice(6), KEY.slice(0, -1), '']) {
      const app = await start();
      const seen: number[] = [];
      for (let i = 0; i < LIMIT + 1; i++) {
        const h = internal(`198.51.100.${i}`, key);
        if (!key) delete h[INTERNAL_KEY_HEADER];
        seen.push((await fetch(`${app.base}/public/events`, { headers: h })).status);
      }
      await app.app.close();
      expect(seen).toEqual([200, 200, 200, 429]);
    }
  });

  it('SPOOF: a forwarded list or a non-address is not a key', async () => {
    for (const visitor of ['1.2.3.4, 5.6.7.8', 'not-an-ip', '']) {
      const app = await start();
      const seen: number[] = [];
      for (let i = 0; i < LIMIT + 1; i++) {
        // Different junk each time would rotate the key if it were used.
        seen.push(
          (await fetch(`${app.base}/public/events`, { headers: internal(`${visitor}${i}`) }))
            .status,
        );
      }
      await app.app.close();
      expect(seen).toEqual([200, 200, 200, 429]);
    }
  });
});

describe('the mechanism is off unless deliberately configured', () => {
  it.each([
    ['unset', { INTERNAL_API_KEY: '' }],
    ['too short to be a secret', { INTERNAL_API_KEY: 'short-key-1234' }],
  ])('%s: forwarded addresses are ignored', async (_label, env) => {
    const srv = await start(env);
    const seen: number[] = [];
    for (let i = 0; i < LIMIT + 1; i++) {
      seen.push(
        (
          await fetch(`${srv.base}/public/events`, {
            headers: internal(`198.51.100.${i}`, 'short-key-1234'),
          })
        ).status,
      );
    }
    await srv.app.close();
    expect(seen).toEqual([200, 200, 200, 429]);
  });
});
