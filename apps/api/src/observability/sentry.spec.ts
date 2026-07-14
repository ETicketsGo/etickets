// Mock the SDK so no real network/init happens.
const initMock = jest.fn();
const captureMock = jest.fn();
const withScopeMock = jest.fn((cb: (scope: { setTag: jest.Mock }) => void) =>
  cb({ setTag: jest.fn() }),
);

jest.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => initMock(...args),
  captureException: (...args: unknown[]) => captureMock(...args),
  withScope: (cb: (scope: { setTag: jest.Mock }) => void) => withScopeMock(cb),
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

    sentry.captureException(new Error('boom'), { correlationId: 'xyz' });
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-initialise on a second call', () => {
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
    const sentry = loadSentry();
    sentry.initSentry();
    sentry.initSentry();
    expect(initMock).toHaveBeenCalledTimes(1);
  });
});
