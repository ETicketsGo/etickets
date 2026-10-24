import type { AddressInfo } from 'node:net';
import { Controller, HttpCode, type INestApplication, Post } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';
import { HumanCheckRisk } from './human-check-risk';
import { RequiresHumanCheck } from './human-check.guard';
import { HumanCheckService } from './human-check.service';
import { assertPlayIntegritySettings, humanCheckSettings } from './human-check.settings';
import {
  decodeUrlFor,
  normaliseDigest,
  playIntegrityRequestHash,
  type FetchLike,
} from './play-integrity-verifier';

/**
 * The Android app's answer to the human check, over real HTTP, through the real decorator,
 * guard and service. Google is a stub that decodes a token into whatever verdict the test
 * says, the way decodeIntegrityToken does; nothing here signs a JWT or reaches Google.
 */

/** In-process stand-in for Redis: the risk counter's INCR script and the one-use claim. */
class FakeRedis {
  down = false;
  readonly keys = new Map<string, { value: number; expiresAt: number }>();
  async eval(script: string, _n: number, key: string, ttlMs: string): Promise<number> {
    if (this.down) throw new Error('Connection is closed.');
    const now = Date.now();
    const entry = this.keys.get(key);
    const live = entry && entry.expiresAt > now;
    if (script.includes("'NX'")) {
      if (live) return 0;
      this.keys.set(key, { value: 1, expiresAt: now + Number(ttlMs) });
      return 1;
    }
    if (!live) {
      this.keys.set(key, { value: 1, expiresAt: now + Number(ttlMs) });
      return 1;
    }
    entry.value += 1;
    return entry.value;
  }
}

@Controller('t')
class ProbeController {
  calls = 0;

  @Post('otp')
  @HttpCode(200)
  @RequiresHumanCheck('otp')
  otp() {
    this.calls += 1;
    return { ok: true };
  }

  @Post('login')
  @HttpCode(200)
  @RequiresHumanCheck('login')
  login() {
    this.calls += 1;
    return { ok: true };
  }
}

const PKG = 'com.eticketsgo.customer';
const PROJECT = '123456789012';
const KEY = JSON.stringify({
  client_email: 'integrity@etg-test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
});
const PI_ENV = {
  PLAY_INTEGRITY_PACKAGE_NAMES: `${PKG}, com.eticketsgo.customer.preview`,
  PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER: PROJECT,
  PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON: KEY,
};

interface VerdictOverrides {
  requestPackageName?: string;
  requestHash?: string;
  timestampMillis?: string;
  appRecognitionVerdict?: string;
  packageName?: string;
  certificateSha256Digest?: string[];
  deviceRecognitionVerdict?: string[];
}

/** The verdict Google returns for a genuine Play install on a certified phone. */
function verdict(action: string, nonce: string, o: VerdictOverrides = {}) {
  return {
    tokenPayloadExternal: {
      requestDetails: {
        requestPackageName: o.requestPackageName ?? PKG,
        requestHash: o.requestHash ?? playIntegrityRequestHash(action, nonce),
        timestampMillis: o.timestampMillis ?? String(Date.now()),
      },
      appIntegrity: {
        appRecognitionVerdict: o.appRecognitionVerdict ?? 'PLAY_RECOGNIZED',
        packageName: o.packageName ?? PKG,
        certificateSha256Digest: o.certificateSha256Digest ?? [
          'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        ],
        versionCode: '7',
      },
      deviceIntegrity: {
        deviceRecognitionVerdict: o.deviceRecognitionVerdict ?? ['MEETS_DEVICE_INTEGRITY'],
      },
      accountDetails: { appLicensingVerdict: 'LICENSED' },
    },
  };
}

type Answer = ReturnType<typeof verdict> | 'timeout' | 'down' | 400 | 403 | 500;

/** Google's decode endpoint: each token maps to an answer chosen by the test. */
function google(answer: (token: string) => Answer) {
  const seen: Array<{ url: string; auth: string; token: string }> = [];
  const impl: FetchLike = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    const token = (JSON.parse(String(init.body)) as { integrity_token: string }).integrity_token;
    seen.push({ url, auth: headers.authorization, token });
    const a = answer(token);
    if (a === 'timeout') {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (a === 'down') throw new TypeError('fetch failed');
    if (typeof a === 'number') return new Response('{}', { status: a });
    return Response.json(a);
  };
  return { impl, seen };
}

async function boot(env: Record<string, string>, fetchImpl: FetchLike) {
  const redis = new FakeRedis();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        load: [
          () => ({
            APP_ENV: 'TEST',
            THROTTLE_CLIENT_IP_HEADER: 'x-real-ip',
            TURNSTILE_SECRET_KEY: 'secret-key-for-tests-only-0001',
            TURNSTILE_SITE_KEY: 'site-key-for-tests',
            TURNSTILE_MODE: 'always',
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
  const service = app.get(HumanCheckService);
  service.useFetch(fetchImpl);
  service.useAccessToken(async () => 'access-token-for-tests');
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  const call = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/t/${path}`, {
      method: 'POST',
      headers: { 'x-real-ip': '203.0.113.7', ...headers },
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const metrics = async () =>
    app.get(MetricsService).registry.getSingleMetricAsString('etg_human_check_total');
  return { app, call, redis, probe: app.get(ProbeController), metrics };
}

let seq = 0;
/** The three headers the app sends, with a fresh nonce each time unless one is given. */
function proof(token: string, nonce = `nonce-${Date.now()}-${(seq += 1)}-abcdef`, pkg = PKG) {
  return {
    nonce,
    headers: {
      'x-play-integrity-token': token,
      'x-play-integrity-nonce': nonce,
      'x-play-integrity-package': pkg,
    },
  };
}

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('a challenge the Android app can answer', () => {
  it('428 names the cloud project number when Play Integrity is configured', async () => {
    const t = await boot(PI_ENV, google(() => 500).impl);
    app = t.app;
    const res = await t.call('otp');
    expect(res.status).toBe(428);
    expect(res.body.details).toMatchObject({
      action: 'otp',
      playIntegrity: { cloudProjectNumber: PROJECT },
    });
  });

  it('428 says null when it is not, so the app knows it cannot answer', async () => {
    const t = await boot({}, google(() => 500).impl);
    app = t.app;
    const res = await t.call('otp');
    expect(res.body.details.playIntegrity).toBeNull();
  });

  it('a Play token is ignored where Play Integrity is not configured: still 428', async () => {
    const g = google(() => 500);
    const t = await boot({}, g.impl);
    app = t.app;
    const res = await t.call('otp', proof('tok').headers);
    expect(res.status).toBe(428);
    expect(g.seen).toHaveLength(0);
  });
});

describe('a genuine verdict', () => {
  it('lets the request through, decoding for the named package with our access token', async () => {
    const p = proof('tok-good');
    const g = google(() => verdict('otp', p.nonce));
    const t = await boot(PI_ENV, g.impl);
    app = t.app;
    const res = await t.call('otp', p.headers);
    expect(res.status).toBe(200);
    expect(t.probe.calls).toBe(1);
    expect(g.seen[0]).toEqual({
      url: decodeUrlFor(PKG),
      auth: 'Bearer access-token-for-tests',
      token: 'tok-good',
    });
    expect(await t.metrics()).toContain('action="otp",outcome="pi_passed"} 1');
  });

  it('accepts MEETS_STRONG_INTEGRITY alone', async () => {
    const p = proof('tok');
    const t = await boot(
      PI_ENV,
      google(() =>
        verdict('otp', p.nonce, { deviceRecognitionVerdict: ['MEETS_STRONG_INTEGRITY'] }),
      ).impl,
    );
    app = t.app;
    expect((await t.call('otp', p.headers)).status).toBe(200);
  });
});

describe('what a bot or a modified app gets: 403, the route never runs', () => {
  const cases: Array<[string, (nonce: string) => Answer, string]> = [
    ['a token minted for another action', (n) => verdict('support', n), 'binding'],
    ['a token over another nonce', () => verdict('otp', 'some-other-nonce-0000'), 'binding'],
    [
      'a token for another package',
      (n) => verdict('otp', n, { requestPackageName: 'com.attacker.clone' }),
      'package',
    ],
    [
      'an old token',
      (n) => verdict('otp', n, { timestampMillis: String(Date.now() - 10 * 60_000) }),
      'expired',
    ],
    [
      'a sideloaded or re-signed app',
      (n) => verdict('otp', n, { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' }),
      'app',
    ],
    [
      'an app Play did not evaluate',
      (n) => verdict('otp', n, { appRecognitionVerdict: 'UNEVALUATED' }),
      'app',
    ],
    [
      'an emulator or rooted phone (basic integrity only)',
      (n) => verdict('otp', n, { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] }),
      'device',
    ],
    [
      'no device verdict at all',
      (n) => verdict('otp', n, { deviceRecognitionVerdict: [] }),
      'device',
    ],
    ['a token Google cannot read (400)', () => 400, 'invalid'],
  ];

  it.each(cases)('%s', async (_name, answer, reason) => {
    const p = proof('tok');
    const t = await boot(PI_ENV, google(() => answer(p.nonce)).impl);
    app = t.app;
    const res = await t.call('otp', p.headers);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('HUMAN_CHECK_FAILED');
    expect(t.probe.calls).toBe(0);
    expect(await t.metrics()).toContain(`action="otp",outcome="pi_failed_${reason}"} 1`);
  });

  it('a package that is not ours is refused without asking Google', async () => {
    const g = google(() => verdict('otp', 'x'));
    const t = await boot(PI_ENV, g.impl);
    app = t.app;
    const res = await t.call('otp', proof('tok', undefined, 'com.attacker.clone').headers);
    expect(res.status).toBe(403);
    expect(g.seen).toHaveLength(0);
  });

  it('a missing or malformed nonce is refused without asking Google', async () => {
    const g = google(() => verdict('otp', 'x'));
    const t = await boot(PI_ENV, g.impl);
    app = t.app;
    const headers = proof('tok').headers;
    expect((await t.call('otp', { ...headers, 'x-play-integrity-nonce': '' })).status).toBe(403);
    expect((await t.call('otp', { ...headers, 'x-play-integrity-nonce': 'short' })).status).toBe(
      403,
    );
    expect(g.seen).toHaveLength(0);
  });

  it('a replayed token and nonce passes once, then is refused', async () => {
    const p = proof('tok-replayed');
    const g = google(() => verdict('otp', p.nonce));
    const t = await boot(PI_ENV, g.impl);
    app = t.app;
    expect((await t.call('otp', p.headers)).status).toBe(200);
    const again = await t.call('otp', p.headers);
    expect(again.status).toBe(403);
    expect(t.probe.calls).toBe(1);
    // Refused on our side: Google was asked once.
    expect(g.seen).toHaveLength(1);
    expect(await t.metrics()).toContain('outcome="pi_failed_replay"} 1');
  });

  it('two racing requests with one nonce: exactly one gets through', async () => {
    const p = proof('tok-race');
    const t = await boot(PI_ENV, google(() => verdict('otp', p.nonce)).impl);
    app = t.app;
    const statuses = await Promise.all([t.call('otp', p.headers), t.call('otp', p.headers)]);
    expect(statuses.map((s) => s.status).sort()).toEqual([200, 403]);
    expect(t.probe.calls).toBe(1);
  });

  it('a Turnstile token is still checked as before alongside it', async () => {
    const t = await boot(PI_ENV, google(() => 500).impl);
    app = t.app;
    // No Play headers and no Turnstile token: the normal 428.
    expect((await t.call('login')).status).toBe(428);
  });
});

describe('when Google cannot answer, each route keeps its own choice', () => {
  it.each<[string, Answer]>([
    ['a timeout', 'timeout'],
    ['a network error', 'down'],
    ['a 500', 500],
  ])('%s: the phone-code route fails CLOSED with 503', async (_n, answer) => {
    const t = await boot(PI_ENV, google(() => answer).impl);
    app = t.app;
    const res = await t.call('otp', proof('tok').headers);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('HUMAN_CHECK_UNAVAILABLE');
    expect(t.probe.calls).toBe(0);
  });

  it('sign-in fails OPEN (the password is the real check)', async () => {
    const t = await boot(PI_ENV, google(() => 'timeout').impl);
    app = t.app;
    expect((await t.call('login', proof('tok').headers)).status).toBe(200);
    expect(await t.metrics()).toContain('action="login",outcome="pi_unavailable_open"} 1');
  });

  it('our key refused by Google (403) is our fault, not the caller: unavailable', async () => {
    const t = await boot(PI_ENV, google(() => 403).impl);
    app = t.app;
    expect((await t.call('otp', proof('tok').headers)).status).toBe(503);
  });

  it('an access token we cannot get is unavailable too', async () => {
    const t = await boot(PI_ENV, google(() => 500).impl);
    app = t.app;
    t.app.get(HumanCheckService).useAccessToken(async () => {
      throw new Error('invalid_grant');
    });
    expect((await t.call('otp', proof('tok').headers)).status).toBe(503);
  });
});

describe('QA sideloaded builds and certificate pinning', () => {
  it('UNRECOGNIZED_VERSION passes only with PLAY_INTEGRITY_ALLOW_UNRECOGNIZED_APP', async () => {
    const p = proof('tok');
    const t = await boot(
      { ...PI_ENV, PLAY_INTEGRITY_ALLOW_UNRECOGNIZED_APP: 'true' },
      google(() => verdict('otp', p.nonce, { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' })).impl,
    );
    app = t.app;
    expect((await t.call('otp', p.headers)).status).toBe(200);
  });

  it('a pinned certificate must match (hex with colons, as Play Console shows it)', async () => {
    const hex = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(':');
    const env = { ...PI_ENV, PLAY_INTEGRITY_CERT_SHA256: hex };
    const ok = proof('tok');
    const t = await boot(
      env,
      google((tok) =>
        tok === 'tok'
          ? verdict('otp', ok.nonce)
          : verdict('otp', bad.nonce, { certificateSha256Digest: ['ZmFrZQ'] }),
      ).impl,
    );
    app = t.app;
    const bad = proof('tok-other-cert');
    expect((await t.call('otp', ok.headers)).status).toBe(200);
    expect((await t.call('otp', bad.headers)).status).toBe(403);
  });

  it('normalises both digest spellings to the same value', () => {
    const hex = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(':');
    expect(normaliseDigest(hex)).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
    expect(normaliseDigest('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=')).toBe(
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    );
  });
});

describe('the request hash the app computes', () => {
  it('is pinned: the same vector is asserted in the app (services/__tests__/human-check.test.ts)', () => {
    expect(playIntegrityRequestHash('otp', '0123456789abcdef0123456789abcdef')).toBe(
      '2cb5c5569c56c68d64478ddf60738655a13609afd9f4349d768ddcce92611b41',
    );
  });
});

describe('boot checks', () => {
  const config = (env: Record<string, string>) => ({
    get: <T>(k: string) => env[k] as T | undefined,
  });
  const assert = (env: Record<string, string>, appEnv = 'QA') =>
    assertPlayIntegritySettings(config(env), humanCheckSettings(config(env)), appEnv);

  it('unset is fine (and means not configured)', () => {
    expect(() => assert({}, 'PRODUCTION')).not.toThrow();
    expect(humanCheckSettings(config({})).playIntegrity).toBeNull();
  });

  it('refuses half a configuration', () => {
    expect(() => assert({ PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON: KEY })).toThrow(/all three/);
  });

  it('refuses a project id where the project NUMBER belongs', () => {
    expect(() => assert({ ...PI_ENV, PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER: 'etg-prod' })).toThrow(
      /numeric project number/,
    );
    expect(() => assert(PI_ENV)).not.toThrow();
  });

  it('refuses a key that is not a service-account JSON, without echoing it', () => {
    let message = '';
    try {
      assert({ ...PI_ENV, PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON: 'super-secret-value' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not a service-account JSON key/);
    expect(message).not.toContain('super-secret-value');
  });

  it('refuses sideloaded-app acceptance in production only', () => {
    const env = { ...PI_ENV, PLAY_INTEGRITY_ALLOW_UNRECOGNIZED_APP: 'true' };
    expect(() => assert(env, 'PRODUCTION')).toThrow(/sideloaded QA builds only/);
    expect(() => assert(env, 'QA')).not.toThrow();
  });
});
