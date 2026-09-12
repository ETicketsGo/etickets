// Mock the SDK so no real network/init happens.
const initMock = jest.fn();
const captureMock = jest.fn();
const withScopeMock = jest.fn((cb: (scope: { setTag: jest.Mock }) => void) =>
  cb({ setTag: jest.fn() }),
);
const dedupeMock = jest.fn((..._args: unknown[]) => ({ name: 'Dedupe' }));

jest.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => initMock(...args),
  captureException: (...args: unknown[]) => captureMock(...args),
  withScope: (cb: (scope: { setTag: jest.Mock }) => void) => withScopeMock(cb),
  dedupeIntegration: (...args: unknown[]) => dedupeMock(...args),
}));

// Fresh module instance per test so the internal `initialised` singleton resets.
function loadSentry(): typeof import('./sentry') {
  let mod!: typeof import('./sentry');
  jest.isolateModules(() => {
    mod = require('./sentry');
  });
  return mod;
}

describe('Sentry integration', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV };
    delete process.env.SENTRY_DSN;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('is a complete no-op when SENTRY_DSN is unset', () => {
    const sentry = loadSentry();
    expect(sentry.initSentry()).toBe(false);
    expect(sentry.isSentryEnabled()).toBe(false);
    expect(initMock).not.toHaveBeenCalled();

    // captureException must not touch the SDK when disabled.
    sentry.captureException(new Error('unexpected'), { correlationId: 'abc' });
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('initialises the SDK when SENTRY_DSN is set and captures errors', () => {
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
    process.env.SENTRY_ENVIRONMENT = 'staging';
    const sentry = loadSentry();

    expect(sentry.initSentry()).toBe(true);
    expect(sentry.isSentryEnabled()).toBe(true);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.calls[0][0]).toMatchObject({
      dsn: process.env.SENTRY_DSN,
      environment: 'staging',
      sendDefaultPii: false,
    });
    // Hardening: dedupe integration + a beforeSend PII scrubber are wired in.
    const initArg = initMock.mock.calls[0][0] as {
      integrations: unknown[];
      beforeSend: unknown;
    };
    expect(dedupeMock).toHaveBeenCalledTimes(1);
    expect(Array.isArray(initArg.integrations)).toBe(true);
    expect(typeof initArg.beforeSend).toBe('function');

    sentry.captureException(new Error('boom'), { correlationId: 'xyz' });
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('files QA and UAT errors under their own environment, not NODE_ENV=production', () => {
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
    delete process.env.SENTRY_ENVIRONMENT;
    process.env.APP_ENV = 'UAT';
    process.env.NODE_ENV = 'production';
    const sentry = loadSentry();

    sentry.initSentry();
    expect(initMock.mock.calls[0][0]).toMatchObject({ environment: 'uat' });
  });

  it('does not re-initialise on a second call', () => {
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
    const sentry = loadSentry();
    sentry.initSentry();
    sentry.initSentry();
    expect(initMock).toHaveBeenCalledTimes(1);
  });
});

describe('resolveSentryRelease — deploy attribution', () => {
  const OLD_ENV = process.env;
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('prefers an explicit SENTRY_RELEASE', () => {
    const { resolveSentryRelease } = loadSentry();
    expect(
      resolveSentryRelease({ SENTRY_RELEASE: 'v1.0.0', RAILWAY_GIT_COMMIT_SHA: 'abc123' }),
    ).toBe('v1.0.0');
  });

  // Railway injects the commit SHA on every deployment, so errors are attributable to a
  // specific deploy even when nobody remembered to set SENTRY_RELEASE.
  it('falls back to the platform-injected commit SHA', () => {
    const { resolveSentryRelease } = loadSentry();
    expect(resolveSentryRelease({ RAILWAY_GIT_COMMIT_SHA: 'abc123' })).toBe('abc123');
  });

  it('is undefined when neither is set (unchanged prior behaviour)', () => {
    const { resolveSentryRelease } = loadSentry();
    expect(resolveSentryRelease({})).toBeUndefined();
    expect(resolveSentryRelease({ SENTRY_RELEASE: '' })).toBeUndefined();
  });
});

describe('resolveSentryEnvironment — which issue stream an error lands in', () => {
  it('prefers an explicit SENTRY_ENVIRONMENT', () => {
    const { resolveSentryEnvironment } = loadSentry();
    expect(
      resolveSentryEnvironment({
        SENTRY_ENVIRONMENT: 'qa-blue',
        APP_ENV: 'QA',
        NODE_ENV: 'production',
      }),
    ).toBe('qa-blue');
  });

  // QA and UAT build and run production bundles, so NODE_ENV says `production` in both.
  it.each([
    ['QA', 'qa'],
    ['UAT', 'uat'],
    ['PRODUCTION', 'production'],
  ])('uses APP_ENV=%s rather than NODE_ENV', (APP_ENV, expected) => {
    const { resolveSentryEnvironment } = loadSentry();
    expect(resolveSentryEnvironment({ APP_ENV, NODE_ENV: 'production' })).toBe(expected);
  });

  it('falls back to NODE_ENV, then development, and treats blank values as unset', () => {
    const { resolveSentryEnvironment } = loadSentry();
    expect(
      resolveSentryEnvironment({ SENTRY_ENVIRONMENT: '', APP_ENV: ' ', NODE_ENV: 'test' }),
    ).toBe('test');
    expect(resolveSentryEnvironment({})).toBe('development');
  });
});

describe('scrubSensitiveData — PII filter (beforeSend)', () => {
  type ScrubEvent = Parameters<typeof import('./sentry').scrubSensitiveData>[0];

  it('strips request cookies, body, query-string and auth/cookie headers', () => {
    const { scrubSensitiveData } = loadSentry();
    const event = {
      request: {
        method: 'POST',
        url: 'https://api.eticketsgo.test/api/bookings/confirm',
        query_string: 'token=secret123',
        cookies: { session: 'abc' },
        data: { password: 'hunter2', card: '4111111111111111' },
        headers: {
          Authorization: 'Bearer eyJhbGc.eyJzdWI.sig',
          Cookie: 'session=abc',
          'content-type': 'application/json',
        },
      },
    } as unknown as ScrubEvent;

    const out = scrubSensitiveData(event) as unknown as {
      request: {
        cookies?: unknown;
        data?: unknown;
        query_string?: unknown;
        headers: Record<string, string>;
      };
    };
    expect(out.request.cookies).toBeUndefined();
    expect(out.request.data).toBeUndefined();
    expect(out.request.query_string).toBeUndefined();
    expect(out.request.headers.Authorization).toBeUndefined();
    expect(out.request.headers.Cookie).toBeUndefined();
    // Benign header is preserved.
    expect(out.request.headers['content-type']).toBe('application/json');
  });

  it.each([
    ['an SES webhook path secret', '/api/notifications/webhooks/ses/', 'ses-path-secret-3f9a'],
    ['a share-link token', '/api/public/share/', 'share-token-8c21'],
  ])('redacts %s from the request URL and the transaction name', (_label, route, secret) => {
    /*
      On these routes the path segment IS the credential. Sentry records the URL and names the
      transaction after it, so an error there used to hand the secret to a third party.
    */
    const { scrubSensitiveData } = loadSentry();
    const event = {
      transaction: `POST ${route}${secret}`,
      request: {
        method: 'POST',
        url: `https://api.eticketsgo.test${route}${secret}?utm=1`,
      },
    } as unknown as ScrubEvent;

    const out = scrubSensitiveData(event) as unknown as {
      transaction: string;
      request: { url: string };
    };
    expect(out.request.url).toBe(`https://api.eticketsgo.test${route}[REDACTED]`);
    expect(out.transaction).toBe(`POST ${route}[REDACTED]`);
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it('leaves an ordinary URL and transaction readable', () => {
    const { scrubSensitiveData } = loadSentry();
    const event = {
      transaction: 'GET /api/bookings/:id',
      request: { url: 'https://api.eticketsgo.test/api/bookings/bk-1' },
    } as unknown as ScrubEvent;
    const out = scrubSensitiveData(event) as unknown as {
      transaction: string;
      request: { url: string };
    };
    expect(out.request.url).toBe('https://api.eticketsgo.test/api/bookings/bk-1');
    expect(out.transaction).toBe('GET /api/bookings/:id');
  });

  it('removes any user identity (email/ip/username)', () => {
    const { scrubSensitiveData } = loadSentry();
    const event = {
      user: { id: 'u1', email: 'victim@example.com', ip_address: '9.9.9.9', username: 'victim' },
    } as unknown as ScrubEvent;
    const out = scrubSensitiveData(event) as unknown as { user?: unknown };
    expect(out.user).toBeUndefined();
  });

  it('is a safe no-op for an event with no request/user', () => {
    const { scrubSensitiveData } = loadSentry();
    const event = {
      exception: { values: [{ type: 'Error', value: 'boom' }] },
    } as unknown as ScrubEvent;
    expect(() => scrubSensitiveData(event)).not.toThrow();
    expect(scrubSensitiveData(event)).toBe(event);
  });
});
