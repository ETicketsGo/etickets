import { loadConfig } from './configuration';

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  JWT_REFRESH_SECRET: 'y'.repeat(40),
  QR_SIGNING_SECRET: 'z'.repeat(40),
  PAYMENT_WEBHOOK_SECRET: 'w'.repeat(40),
  APP_ENV: 'LOCAL',
  NODE_ENV: 'test',
};

function withEnv(extra: Record<string, string>): () => ReturnType<typeof loadConfig> {
  return () => {
    const saved = process.env;
    process.env = { ...BASE_ENV, ...extra } as NodeJS.ProcessEnv;
    try {
      return loadConfig();
    } finally {
      process.env = saved;
    }
  };
}

describe('Razorpay config test/live isolation', () => {
  it('accepts a consistent test key + test mode', () => {
    const cfg = withEnv({ RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_MODE: 'test' })();
    expect(cfg.RAZORPAY_MODE).toBe('test');
  });

  it('rejects a test key declared as live mode (mixing test/live)', () => {
    expect(withEnv({ RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_MODE: 'live' })).toThrow(
      /Razorpay/i,
    );
  });

  it('rejects a live key declared as test mode', () => {
    expect(withEnv({ RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_MODE: 'test' })).toThrow(
      /Razorpay/i,
    );
  });

  it('rejects a webhook secret equal to the API key secret', () => {
    expect(
      withEnv({
        RAZORPAY_KEY_ID: 'rzp_test_abc',
        RAZORPAY_KEY_SECRET: 'same-secret-value',
        RAZORPAY_WEBHOOK_SECRET: 'same-secret-value',
      }),
    ).toThrow(/DISTINCT/i);
  });

  it('defaults: mode test, currency INR, Route disabled', () => {
    const cfg = withEnv({})();
    expect(cfg.RAZORPAY_MODE).toBe('test');
    expect(cfg.RAZORPAY_CURRENCY).toBe('INR');
    expect(cfg.RAZORPAY_ROUTE_ENABLED).toBe(false);
  });
});
