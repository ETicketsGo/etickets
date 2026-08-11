import { ConfigService } from '@nestjs/config';
import { PilotReadinessService } from './pilot-readiness.service';
import { evaluatePaymentProvider } from './payment-readiness';

/**
 * The bridge between real configuration and the readiness verdict.
 *
 * `payment-readiness.spec.ts` proves the RULES over a facts object. This proves the step
 * before it: that the facts are gathered from the variables the runtime actually uses.
 *
 * That gap is exactly where the original defect lived. The rules were fine; the fact
 * gatherer read `PAYMENTS_MOCK_MODE`, a variable no other part of this system defines, and
 * ignored `PAYMENT_PROVIDER_NAME`, the one that selects the gateway. Testing only the rules
 * would have kept passing.
 *
 * No real credential appears here. `rzp_test_…` strings are shape, not secret.
 */
function factsFrom(env: Record<string, string | undefined>) {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  const service = new PilotReadinessService(null as never, null as never, config) as unknown as {
    paymentFacts: () => Parameters<typeof evaluatePaymentProvider>[0];
  };
  return service.paymentFacts();
}

const verdict = (env: Record<string, string | undefined>) => {
  const checks = evaluatePaymentProvider(factsFrom(env));
  const levels = checks.map((c) => c.level);
  return {
    overall: levels.includes('BLOCKED')
      ? 'BLOCKED'
      : levels.includes('WARNING')
        ? 'WARNING'
        : 'READY',
    codes: checks.map((c) => c.code),
  };
};

const SANDBOX = {
  RAZORPAY_KEY_ID: 'rzp_test_shapeonly',
  RAZORPAY_KEY_SECRET: 'shape-only-secret',
  RAZORPAY_WEBHOOK_SECRET: 'shape-only-distinct-webhook-secret',
  RAZORPAY_MODE: 'test',
};

describe('what the UAT deployment posture produces', () => {
  it('UAT + Razorpay sandbox + webhook secret → READY', () => {
    expect(verdict({ APP_ENV: 'UAT', PAYMENT_PROVIDER_NAME: 'razorpay', ...SANDBOX })).toEqual({
      overall: 'READY',
      codes: ['RAZORPAY_SANDBOX_READY'],
    });
  });

  it('UAT + mock → BLOCKED, whatever else is configured', () => {
    // The env template ships PAYMENT_PROVIDER_NAME=stripe for the US posture; leaving `mock`
    // in place is the mistake this refuses. Credentials lying unused do not rescue it.
    expect(verdict({ APP_ENV: 'UAT', PAYMENT_PROVIDER_NAME: 'mock', ...SANDBOX }).overall).toBe(
      'BLOCKED',
    );
    expect(verdict({ APP_ENV: 'UAT', PAYMENT_PROVIDER_NAME: 'mock' }).codes).toContain(
      'PAYMENT_MOCK_ONLY',
    );
  });

  it('UAT + a live-mode declaration → BLOCKED', () => {
    // Asserted with RAZORPAY_MODE alone. A real live key is never needed to prove the
    // refusal, and must never be used for it.
    const v = verdict({
      APP_ENV: 'UAT',
      PAYMENT_PROVIDER_NAME: 'razorpay',
      ...SANDBOX,
      RAZORPAY_MODE: 'live',
    });
    expect(v.overall).toBe('BLOCKED');
    expect(v.codes).toContain('RAZORPAY_LIVE_KEYS_IN_LOWER_ENV');
  });

  it('UAT + the default US posture (stripe) → BLOCKED, and says why', () => {
    const v = verdict({ APP_ENV: 'UAT', PAYMENT_PROVIDER_NAME: 'stripe' });
    expect(v.codes).toEqual(['PAYMENT_PROVIDER_NOT_INR_CAPABLE']);
    expect(v.overall).toBe('BLOCKED');
  });
});

describe('the variables that are actually read', () => {
  it('PAYMENT_PROVIDER_NAME selects the gateway', () => {
    expect(factsFrom({ PAYMENT_PROVIDER_NAME: 'razorpay' }).provider).toBe('razorpay');
    expect(factsFrom({}).provider).toBe('mock');
  });

  it('PAYMENT_PROVIDER is ignored — it is read by no runtime code', () => {
    // Setting the schema-declared-but-unused variable must not change anything. This is
    // half of the original confusion, pinned so nobody "fixes" it by reading it here.
    expect(factsFrom({ PAYMENT_PROVIDER: 'razorpay' }).provider).toBe('mock');
  });

  it('PAYMENTS_MOCK_MODE is gone and cannot resurrect', () => {
    // It never existed anywhere else in this system; its only effect was to turn the old
    // check green. Setting it must be inert.
    const withFlag = verdict({ APP_ENV: 'UAT', PAYMENTS_MOCK_MODE: 'true' });
    const without = verdict({ APP_ENV: 'UAT' });
    expect(withFlag).toEqual(without);
    expect(withFlag.overall).toBe('BLOCKED');
  });

  it('an unknown APP_ENV resolves to LOCAL, the safest environment', () => {
    expect(factsFrom({ APP_ENV: 'staging-ish' }).environment).toBe('LOCAL');
    expect(factsFrom({}).environment).toBe('LOCAL');
  });

  it('credential presence is presence — blank and whitespace are not set', () => {
    const facts = factsFrom({
      RAZORPAY_KEY_ID: '',
      RAZORPAY_KEY_SECRET: '   ',
      RAZORPAY_WEBHOOK_SECRET: 'real-enough',
    });
    expect(facts.razorpay).toMatchObject({
      hasKeyId: false,
      hasKeySecret: false,
      hasWebhookSecret: true,
    });
  });

  it('the facts carry no field that could hold a credential value', () => {
    const facts = factsFrom({ PAYMENT_PROVIDER_NAME: 'razorpay', ...SANDBOX });
    expect(JSON.stringify(facts)).not.toContain('rzp_test_shapeonly');
    expect(JSON.stringify(facts)).not.toContain('shape-only-secret');
  });

  it('live payments require the master switch, not just a live key', () => {
    expect(factsFrom({ PAYMENT_LIVE_ENABLED: 'true' }).liveEnabled).toBe(true);
    expect(factsFrom({ PAYMENT_LIVE_ENABLED: 'TRUE' }).liveEnabled).toBe(false);
    expect(factsFrom({}).liveEnabled).toBe(false);
  });
});
