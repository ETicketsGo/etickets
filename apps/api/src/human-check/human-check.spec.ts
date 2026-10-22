import type { AddressInfo } from 'node:net';
import { Controller, HttpCode, type INestApplication, Post } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';
import { HumanCheckRisk, networkKeyFor } from './human-check-risk';
import { HUMAN_CHECK_KEY, HumanCheckGuard, RequiresHumanCheck } from './human-check.guard';
import { HumanCheckService } from './human-check.service';
import { assertHumanCheckSettings, humanCheckSettings } from './human-check.settings';
import { SITEVERIFY_URL, type FetchLike } from './turnstile-verifier';

/**
 * The human check over real HTTP, through the real decorator, guard and service.
 *
 * Cloudflare is a stub that answers siteverify the way the documentation says it does. The
 * client address comes from `x-real-ip` (THROTTLE_CLIENT_IP_HEADER below), so a test can be
 * two different networks without two machines.
 */

/** In-process stand-in for the risk counter's script: INCR, expiry on the first hit. */
class FakeRedis {
  down = false;
  readonly keys = new Map<string, { value: number; expiresAt: number }>();
  async eval(_script: string, _n: number, key: string, windowMs: string): Promise<number> {
    if (this.down) throw new Error('Connection is closed.');
    const now = Date.now();
    const entry = this.keys.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.keys.set(key, { value: 1, expiresAt: now + Number(windowMs) });
      return 1;
    }
    entry.value += 1;
    return entry.value;
  }
}

@Controller('t')
class ProbeController {
  calls = 0;

  @Post('login')
  @HttpCode(200)
  @RequiresHumanCheck('login')
  login() {
    this.calls += 1;
    return { ok: true };
  }

  @Post('otp')
  @HttpCode(200)
  @RequiresHumanCheck('otp')
  otp() {
    this.calls += 1;
    return { ok: true };
  }

  @Post('open')
  @HttpCode(200)
  open() {
    this.calls += 1;
    return { ok: true };
  }
}

const SECRET = 'secret-key-for-tests-only-0001';
const SITE = 'site-key-for-tests';

interface Answer {
  success?: boolean;
  hostname?: string;
  action?: string;
  challenge_ts?: string;
  'error-codes'?: string[];
}

/** A Cloudflare that redeems each token once, like the real one. */
function cloudflare(answer: (token: string) => Answer | 'timeout' | 'down' | 'http500') {
  const spent = new Set<string>();
  const seen: Array<{ url: string; body: URLSearchParams }> = [];
  const impl: FetchLike = async (url, init) => {
    const body = new URLSearchParams(String(init.body));
    seen.push({ url, body });
    const token = body.get('response') ?? '';
    const a = answer(token);
    if (a === 'timeout') {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (a === 'down') throw new TypeError('fetch failed');
    if (a === 'http500') return new Response('oops', { status: 500 });
    if (a.success && spent.has(token)) {
      return Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    }
    if (a.success) spent.add(token);
    return Response.json(a);
  };
  return { impl, seen };
}

const good = (action: string, extra: Partial<Answer> = {}): Answer => ({
  success: true,
  hostname: 'qa.eticketsgo.com',
  action,
  challenge_ts: new Date().toISOString(),
  ...extra,
});

async function boot(env: Record<string, string>, fetchImpl?: FetchLike) {
  const redis = new FakeRedis();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        load: [
          () => ({
            APP_ENV: 'TEST',
            THROTTLE_CLIENT_IP_HEADER: 'x-real-ip',
            TURNSTILE_SECRET_KEY: SECRET,
            TURNSTILE_SITE_KEY: SITE,
            TURNSTILE_ALLOWED_HOSTNAMES: 'qa.eticketsgo.com, uat.eticketsgo.com',
            ...env,
          }),
        ],
      }),
    ],
    controllers: [ProbeController],
    providers: [
      HumanCheckRisk,
      HumanCheckService,
      MetricsService,
      { provide: RedisService, useValue: { client: redis } },
    ],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  if (fetchImpl) app.get(HumanCheckService).useFetch(fetchImpl);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  const call = async (path: string, opts: { ip?: string; token?: string } = {}) => {
    const headers: Record<string, string> = { 'x-real-ip': opts.ip ?? '203.0.113.7' };
    if (opts.token) headers['x-turnstile-token'] = opts.token;
    const res = await fetch(`http://127.0.0.1:${port}/t/${path}`, { method: 'POST', headers });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const metrics = async () =>
    app.get(MetricsService).registry.getSingleMetricAsString('etg_human_check_total');
  return { app, call, redis, probe: app.get(ProbeController), metrics };
}

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('TURNSTILE_MODE=off (the default)', () => {
  it('is a pass-through: no token asked for, Cloudflare never called', async () => {
    const cf = cloudflare(() => good('login'));
    const t = await boot({ TURNSTILE_MODE: '' }, cf.impl);
    app = t.app;
    for (let i = 0; i < 20; i += 1) expect((await t.call('login')).status).toBe(200);
    expect(cf.seen).toHaveLength(0);
    expect(t.redis.keys.size).toBe(0);
  });

  it('boots with no keys at all', () => {
    expect(() =>
      assertHumanCheckSettings(humanCheckSettings({ get: () => undefined }), 'PRODUCTION'),
    ).not.toThrow();
  });
});

describe('TURNSTILE_MODE=always', () => {
  it('refuses a request with no token with 428 HUMAN_CHECK_REQUIRED and the site key', async () => {
    const t = await boot({ TURNSTILE_MODE: 'always' }, cloudflare(() => good('login')).impl);
    app = t.app;
    const res = await t.call('login');
    expect(res.status).toBe(428);
    expect(res.body).toMatchObject({
      code: 'HUMAN_CHECK_REQUIRED',
      details: { action: 'login', siteKey: SITE },
    });
    expect(t.probe.calls).toBe(0);
  });

  it('lets a valid token through and sends secret, token and client address', async () => {
    const cf = cloudflare(() => good('login'));
    const t = await boot({ TURNSTILE_MODE: 'always' }, cf.impl);
    app = t.app;
    expect((await t.call('login', { token: 'tok-1', ip: '198.51.100.4' })).status).toBe(200);
    expect(cf.seen[0].url).toBe(SITEVERIFY_URL);
    expect(cf.seen[0].body.get('secret')).toBe(SECRET);
    expect(cf.seen[0].body.get('response')).toBe('tok-1');
    expect(cf.seen[0].body.get('remoteip')).toBe('198.51.100.4');
    expect(await t.metrics()).toContain('action="login",outcome="passed"} 1');
  });

  it('refuses an invalid token with 403 HUMAN_CHECK_FAILED', async () => {
    const cf = cloudflare(() => ({ success: false, 'error-codes': ['invalid-input-response'] }));
    const t = await boot({ TURNSTILE_MODE: 'always' }, cf.impl);
    app = t.app;
    const res = await t.call('login', { token: 'forged' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'HUMAN_CHECK_FAILED', details: { siteKey: SITE } });
    expect(t.probe.calls).toBe(0);
  });

  it('refuses a token solved on another hostname', async () => {
    const t = await boot(
      { TURNSTILE_MODE: 'always' },
      cloudflare(() => good('login', { hostname: 'evil.example' })).impl,
    );
    app = t.app;
    expect((await t.call('login', { token: 'x' })).status).toBe(403);
    expect(await t.metrics()).toContain('outcome="failed_hostname"');
  });

  it('refuses a token solved for another form (cheap form replayed at the OTP route)', async () => {
    const t = await boot({ TURNSTILE_MODE: 'always' }, cloudflare(() => good('support')).impl);
    app = t.app;
    expect((await t.call('otp', { token: 'x' })).status).toBe(403);
    expect(await t.metrics()).toContain('outcome="failed_action"');
  });

  it('refuses a token older than the age limit', async () => {
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    const t = await boot(
      { TURNSTILE_MODE: 'always' },
      cloudflare(() => good('login', { challenge_ts: old })).impl,
    );
    app = t.app;
    expect((await t.call('login', { token: 'x' })).status).toBe(403);
    expect(await t.metrics()).toContain('outcome="failed_expired"');
  });

  it('refuses a token the second time it is used (timeout-or-duplicate)', async () => {
    const t = await boot({ TURNSTILE_MODE: 'always' }, cloudflare(() => good('login')).impl);
    app = t.app;
    expect((await t.call('login', { token: 'once' })).status).toBe(200);
    expect((await t.call('login', { token: 'once' })).status).toBe(403);
    expect(t.probe.calls).toBe(1);
    expect(await t.metrics()).toContain('outcome="failed_duplicate"');
  });

  it('leaves routes without the decorator alone', async () => {
    const t = await boot({ TURNSTILE_MODE: 'always' }, cloudflare(() => good('login')).impl);
    app = t.app;
    expect((await t.call('open')).status).toBe(200);
  });

  describe('when Cloudflare cannot answer', () => {
    it.each(['timeout', 'down', 'http500'] as const)('sign-in fails open (%s)', async (failure) => {
      const t = await boot({ TURNSTILE_MODE: 'always' }, cloudflare(() => failure).impl);
      app = t.app;
      expect((await t.call('login', { token: 'x' })).status).toBe(200);
      expect(await t.metrics()).toContain('action="login",outcome="unavailable_open"} 1');
    });

    it('the phone-code route fails closed with 503 HUMAN_CHECK_UNAVAILABLE', async () => {
      const t = await boot({ TURNSTILE_MODE: 'always' }, cloudflare(() => 'timeout').impl);
      app = t.app;
      const res = await t.call('otp', { token: 'x' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('HUMAN_CHECK_UNAVAILABLE');
      expect(t.probe.calls).toBe(0);
    });

    it('TURNSTILE_FAIL_OPEN overrides every route, both ways', async () => {
      let t = await boot(
        { TURNSTILE_MODE: 'always', TURNSTILE_FAIL_OPEN: 'true' },
        cloudflare(() => 'down').impl,
      );
      app = t.app;
      expect((await t.call('otp', { token: 'x' })).status).toBe(200);
      await t.app.close();
      t = await boot(
        { TURNSTILE_MODE: 'always', TURNSTILE_FAIL_OPEN: 'false' },
        cloudflare(() => 'down').impl,
      );
      app = t.app;
      expect((await t.call('login', { token: 'x' })).status).toBe(503);
    });

    it('a wrong secret is our fault, not the visitor: the fail policy applies', async () => {
      const t = await boot(
        { TURNSTILE_MODE: 'always' },
        cloudflare(() => ({ success: false, 'error-codes': ['invalid-input-secret'] })).impl,
      );
      app = t.app;
      expect((await t.call('login', { token: 'x' })).status).toBe(200);
      expect((await t.call('otp', { token: 'x' })).status).toBe(503);
    });

    it('honours the timeout: a Cloudflare that never answers costs the bound, not forever', async () => {
      const hang: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      const t = await boot({ TURNSTILE_MODE: 'always', TURNSTILE_VERIFY_TIMEOUT_MS: '500' }, hang);
      app = t.app;
      const started = Date.now();
      expect((await t.call('login', { token: 'x' })).status).toBe(200);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await t.metrics()).toContain('outcome="unavailable_open"');
    });
  });
});

describe('TURNSTILE_MODE=adaptive', () => {
  it('lets the first attempts through with no token, then asks for one', async () => {
    const cf = cloudflare(() => good('otp'));
    const t = await boot({ TURNSTILE_MODE: 'adaptive' }, cf.impl);
    app = t.app;
    // Strict tier: 3 in the window go through untouched.
    for (let i = 0; i < 3; i += 1) expect((await t.call('otp')).status).toBe(200);
    expect(cf.seen).toHaveLength(0);
    const fourth = await t.call('otp');
    expect(fourth.status).toBe(428);
    expect(fourth.body.code).toBe('HUMAN_CHECK_REQUIRED');
    // ...and the same request with a solved token succeeds.
    expect((await t.call('otp', { token: 'solved' })).status).toBe(200);
    expect(t.probe.calls).toBe(4);
  });

  it('sign-in gets the lenient threshold (5)', async () => {
    const t = await boot({ TURNSTILE_MODE: 'adaptive' }, cloudflare(() => good('login')).impl);
    app = t.app;
    for (let i = 0; i < 5; i += 1) expect((await t.call('login')).status).toBe(200);
    expect((await t.call('login')).status).toBe(428);
  });

  it('a different network is unaffected by one that tripped the threshold', async () => {
    const t = await boot({ TURNSTILE_MODE: 'adaptive' }, cloudflare(() => good('otp')).impl);
    app = t.app;
    for (let i = 0; i < 4; i += 1) await t.call('otp', { ip: '203.0.113.7' });
    expect((await t.call('otp', { ip: '203.0.113.7' })).status).toBe(428);
    expect((await t.call('otp', { ip: '198.51.100.9' })).status).toBe(200);
  });

  it('counts route classes separately: many sign-ins do not challenge the phone-code route', async () => {
    const t = await boot({ TURNSTILE_MODE: 'adaptive' }, cloudflare(() => good('otp')).impl);
    app = t.app;
    for (let i = 0; i < 6; i += 1) await t.call('login');
    expect((await t.call('login')).status).toBe(428);
    expect((await t.call('otp')).status).toBe(200);
  });

  it('counts IPv6 by /64, so rotating addresses inside one allocation does not reset it', async () => {
    const t = await boot({ TURNSTILE_MODE: 'adaptive' }, cloudflare(() => good('otp')).impl);
    app = t.app;
    for (let i = 1; i <= 3; i += 1) {
      expect((await t.call('otp', { ip: `2001:db8:1:2::${i}` })).status).toBe(200);
    }
    expect((await t.call('otp', { ip: '2001:db8:1:2:ffff::9' })).status).toBe(428);
    expect((await t.call('otp', { ip: '2001:db8:1:3::1' })).status).toBe(200);
  });

  it('keeps counting in process when Redis is away', async () => {
    const t = await boot({ TURNSTILE_MODE: 'adaptive' }, cloudflare(() => good('otp')).impl);
    app = t.app;
    t.redis.down = true;
    for (let i = 0; i < 3; i += 1) expect((await t.call('otp')).status).toBe(200);
    expect((await t.call('otp')).status).toBe(428);
  });
});

describe('networkKeyFor', () => {
  it('keeps IPv4 addresses whole and folds IPv6 to its /64', () => {
    expect(networkKeyFor('203.0.113.7')).toBe('203.0.113.7');
    expect(networkKeyFor('2001:db8::1')).toBe('2001:0db8:0000:0000::/64');
    expect(networkKeyFor('2001:DB8:0:0:abcd::')).toBe('2001:0db8:0000:0000::/64');
    expect(networkKeyFor('::1')).toBe('0000:0000:0000:0000::/64');
  });
});

describe('boot refusal', () => {
  const settings = (env: Record<string, string>) =>
    humanCheckSettings({ get: <T>(k: string) => env[k] as T | undefined });

  it('refuses a switched-on mode with no secret or site key', () => {
    expect(() => assertHumanCheckSettings(settings({ TURNSTILE_MODE: 'adaptive' }), 'QA')).toThrow(
      /TURNSTILE_SECRET_KEY is not set[\s\S]*TURNSTILE_SITE_KEY is not set/,
    );
  });

  it('refuses a deployed environment with no hostname allowlist', () => {
    const s = settings({
      TURNSTILE_MODE: 'always',
      TURNSTILE_SECRET_KEY: 's',
      TURNSTILE_SITE_KEY: 'k',
    });
    expect(() => assertHumanCheckSettings(s, 'QA')).toThrow(/TURNSTILE_ALLOWED_HOSTNAMES/);
    expect(() => assertHumanCheckSettings(s, 'LOCAL')).not.toThrow();
  });

  it("refuses Cloudflare's test keys in production only", () => {
    const s = settings({
      TURNSTILE_MODE: 'always',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_ALLOWED_HOSTNAMES: 'eticketsgo.com',
    });
    expect(() => assertHumanCheckSettings(s, 'PRODUCTION')).toThrow(/TEST key/);
    expect(() => assertHumanCheckSettings(s, 'QA')).not.toThrow();
  });

  it('reads an unknown mode as off, never as on', () => {
    expect(settings({ TURNSTILE_MODE: 'alwys' }).mode).toBe('off');
  });
});

describe('the routes it guards', () => {
  /*
    One row per abuse-prone public route. A row that fails here is a route that silently lost
    its check, which no other test would notice: with TURNSTILE_MODE=off it behaves the same.
  */
  it.each([
    ['AuthController', 'requestPhoneCode', 'otp'],
    ['AuthController', 'requestAttachCode', 'otp'],
    ['AuthController', 'register', 'register'],
    ['AuthController', 'login', 'login'],
    ['AuthController', 'forgotPassword', 'password_reset'],
    ['GuestBookingsController', 'createGuest', 'guest_checkout'],
    ['GuestBookingsController', 'lookupGuest', 'guest_lookup'],
    ['SupportController', 'submit', 'support'],
    ['OrganizationsController', 'register', 'organization'],
  ])('%s.%s is checked as %s', async (controller, handler, action) => {
    const modules: Record<string, () => Promise<Record<string, unknown>>> = {
      AuthController: () => import('../auth/auth.controller'),
      GuestBookingsController: () => import('../bookings/bookings.controller'),
      SupportController: () => import('../support/support.controller'),
      OrganizationsController: () => import('../organizations/organizations.controller'),
    };
    const cls = (await modules[controller]())[controller] as {
      prototype: Record<string, unknown>;
    };
    const method = cls.prototype[handler] as object;
    expect(Reflect.getMetadata(HUMAN_CHECK_KEY, method)).toBe(action);
    expect(Reflect.getMetadata('__guards__', method)).toContain(HumanCheckGuard);
  });
});
