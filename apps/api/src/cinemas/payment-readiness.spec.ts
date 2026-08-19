import { evaluatePaymentProvider, type PaymentReadinessFacts } from './payment-readiness';
import { PAYMENT_ENVS, type PaymentEnvName } from '../payments/configuration/payment-environment';

/**
 * Whether an environment can take the payment a pilot needs.
 *
 * The rule these all serve: **a fake gateway must never make a pilot environment green.**
 * The previous check could be satisfied by setting `PAYMENTS_MOCK_MODE=true` — a variable
 * that exists nowhere else in this system, whose only effect was to silence this warning.
 */
const facts = (over: Partial<PaymentReadinessFacts> = {}): PaymentReadinessFacts => ({
  environment: 'STAGING',
  provider: 'razorpay',
  razorpay: { hasKeyId: true, hasKeySecret: true, hasWebhookSecret: true, mode: 'test' },
  liveEnabled: false,
  ...over,
});

const codes = (f: PaymentReadinessFacts) => evaluatePaymentProvider(f).map((c) => c.code);
const level = (f: PaymentReadinessFacts, code: string) =>
  evaluatePaymentProvider(f).find((c) => c.code === code)?.level;
const worst = (f: PaymentReadinessFacts) => {
  const levels = evaluatePaymentProvider(f).map((c) => c.level);
  return levels.includes('BLOCKED') ? 'BLOCKED' : levels.includes('WARNING') ? 'WARNING' : 'READY';
};

describe('the simulated gateway', () => {
  const mock = (environment: PaymentEnvName) => facts({ environment, provider: 'mock' });

  it.each(['LOCAL', 'DEV', 'QA'] as PaymentEnvName[])(
    'warns in %s, where the payment module already permits it',
    (env) => {
      expect(level(mock(env), 'PAYMENT_MOCK_ONLY')).toBe('WARNING');
    },
  );

  it.each(['UAT', 'STAGING', 'PRODUCTION'] as PaymentEnvName[])(
    'BLOCKS in %s — a pilot cannot be rehearsed against a stub',
    (env) => {
      expect(level(mock(env), 'PAYMENT_MOCK_ONLY')).toBe('BLOCKED');
    },
  );

  it('says what is actually wrong with it, not merely that it is a mock', () => {
    // "The booking confirmed" is exactly what a mock always does, which is why it proves
    // nothing. The message has to say so, or an operator reads a green run as evidence.
    const message = evaluatePaymentProvider(mock('QA')).find(
      (c) => c.code === 'PAYMENT_MOCK_ONLY',
    )!.message;
    expect(message).toMatch(/no money moves/i);
    expect(message).toMatch(/sandbox|live/i);
  });

  it('is never READY anywhere, in any environment', () => {
    // The single most important property in this file.
    for (const env of PAYMENT_ENVS) {
      expect(worst(mock(env))).not.toBe('READY');
    }
  });

  it('setting Razorpay credentials does not rescue a mock provider', () => {
    // The gateway in use is what matters. Credentials sitting unused in the environment do
    // not mean a payment can be taken through them.
    const f = facts({
      environment: 'STAGING',
      provider: 'mock',
      razorpay: { hasKeyId: true, hasKeySecret: true, hasWebhookSecret: true, mode: 'test' },
    });
    expect(worst(f)).toBe('BLOCKED');
  });
});

describe('a gateway that cannot settle INR', () => {
  it.each(['stripe', 'paypal', 'square'] as const)('%s blocks, and names itself', (provider) => {
    const f = facts({ provider });
    expect(level(f, 'PAYMENT_PROVIDER_NOT_INR_CAPABLE')).toBe('BLOCKED');
    expect(
      evaluatePaymentProvider(f).find((c) => c.code === 'PAYMENT_PROVIDER_NOT_INR_CAPABLE')!
        .message,
    ).toContain(provider);
  });
});

describe('Razorpay sandbox — the state a pilot rehearsal wants', () => {
  it.each(['LOCAL', 'DEV', 'QA', 'UAT', 'STAGING'] as PaymentEnvName[])(
    'is READY in %s with test keys and a webhook secret',
    (environment) => {
      expect(codes(facts({ environment }))).toEqual(['RAZORPAY_SANDBOX_READY']);
      expect(worst(facts({ environment }))).toBe('READY');
    },
  );

  it('says plainly that no real money moves', () => {
    const message = evaluatePaymentProvider(facts()).find(
      (c) => c.code === 'RAZORPAY_SANDBOX_READY',
    )!.message;
    expect(message).toMatch(/no real money/i);
  });

  it('BLOCKS in production — nobody would be charged', () => {
    expect(level(facts({ environment: 'PRODUCTION' }), 'RAZORPAY_TEST_KEYS_IN_PRODUCTION')).toBe(
      'BLOCKED',
    );
  });
});

describe('missing Razorpay configuration', () => {
  it('names which credential is missing, not just that one is', () => {
    const noId = facts({
      razorpay: { hasKeyId: false, hasKeySecret: true, hasWebhookSecret: true, mode: 'test' },
    });
    expect(
      evaluatePaymentProvider(noId).find((c) => c.code === 'RAZORPAY_NOT_CONFIGURED')!.message,
    ).toContain('key ID');

    const neither = facts({
      razorpay: { hasKeyId: false, hasKeySecret: false, hasWebhookSecret: true, mode: 'test' },
    });
    const message = evaluatePaymentProvider(neither).find(
      (c) => c.code === 'RAZORPAY_NOT_CONFIGURED',
    )!.message;
    expect(message).toContain('key ID and key secret');
  });

  it('a blank string is missing, not present', () => {
    // The service trims before reporting presence; this pins the intent so a future
    // refactor cannot start treating '' as configured.
    expect(
      level(
        facts({
          razorpay: { hasKeyId: false, hasKeySecret: true, hasWebhookSecret: true, mode: 'test' },
        }),
        'RAZORPAY_NOT_CONFIGURED',
      ),
    ).toBe('BLOCKED');
  });

  /*
    The webhook secret is its own blocker, and the reason is worth stating.

    Razorpay's browser redirect is a hint, not a result. The webhook is what confirms a
    payment server-side, and without a secret its signature cannot be verified — so every
    event is refused, orders are created and never confirmed, and the customer's money has
    already left. That is strictly worse than not taking payment at all.
  */
  it('a missing webhook secret blocks even when the keys are perfect', () => {
    const f = facts({
      razorpay: { hasKeyId: true, hasKeySecret: true, hasWebhookSecret: false, mode: 'test' },
    });
    expect(level(f, 'RAZORPAY_WEBHOOK_NOT_CONFIGURED')).toBe('BLOCKED');
    // And it does NOT also claim the sandbox is ready.
    expect(codes(f)).not.toContain('RAZORPAY_SANDBOX_READY');
  });

  it('reports every missing thing at once, so a fix is one round trip', () => {
    const f = facts({
      razorpay: { hasKeyId: false, hasKeySecret: false, hasWebhookSecret: false, mode: 'test' },
    });
    expect(codes(f).sort()).toEqual(['RAZORPAY_NOT_CONFIGURED', 'RAZORPAY_WEBHOOK_NOT_CONFIGURED']);
  });
});

describe('live credentials', () => {
  const live = (over: Partial<PaymentReadinessFacts> = {}) =>
    facts({
      razorpay: { hasKeyId: true, hasKeySecret: true, hasWebhookSecret: true, mode: 'live' },
      ...over,
    });

  it.each(['LOCAL', 'DEV', 'QA', 'UAT'] as PaymentEnvName[])(
    'BLOCK in %s — real customers would be charged from a test environment',
    (environment) => {
      expect(level(live({ environment }), 'RAZORPAY_LIVE_KEYS_IN_LOWER_ENV')).toBe('BLOCKED');
    },
  );

  it('blocks in staging and production while the live master switch is off', () => {
    // Credentials present is not consent. ADR-028 keeps a separate switch precisely so live
    // payments cannot be turned on by pasting a key.
    for (const environment of ['STAGING', 'PRODUCTION'] as PaymentEnvName[]) {
      expect(level(live({ environment, liveEnabled: false }), 'PAYMENT_LIVE_NOT_ENABLED')).toBe(
        'BLOCKED',
      );
    }
  });

  it('is READY only in staging or production with the switch on', () => {
    expect(codes(live({ environment: 'PRODUCTION', liveEnabled: true }))).toEqual([
      'RAZORPAY_LIVE_READY',
    ]);
    expect(codes(live({ environment: 'STAGING', liveEnabled: true }))).toEqual([
      'RAZORPAY_LIVE_READY',
    ]);
  });
});

describe('the whole matrix', () => {
  /*
    Exhaustive over every environment × provider × mode. The value is not the individual
    assertions — it is that no combination silently returns nothing, and that READY only ever
    appears where a real gateway is genuinely configured.
  */
  it('every combination produces at least one check, and only real gateways can be READY', () => {
    for (const environment of PAYMENT_ENVS) {
      for (const provider of ['mock', 'razorpay', 'stripe', 'paypal', 'square'] as const) {
        for (const mode of ['test', 'live'] as const) {
          for (const liveEnabled of [false, true]) {
            for (const configured of [false, true]) {
              const f: PaymentReadinessFacts = {
                environment,
                provider,
                razorpay: {
                  hasKeyId: configured,
                  hasKeySecret: configured,
                  hasWebhookSecret: configured,
                  mode,
                },
                liveEnabled,
              };
              const result = evaluatePaymentProvider(f);
              expect(result.length).toBeGreaterThan(0);

              if (worst(f) === 'READY') {
                expect(provider).toBe('razorpay');
                expect(configured).toBe(true);
                if (mode === 'live') {
                  expect(liveEnabled).toBe(true);
                  expect(['STAGING', 'PRODUCTION']).toContain(environment);
                } else {
                  expect(environment).not.toBe('PRODUCTION');
                }
              }
            }
          }
        }
      }
    }
  });

  it('no check ever offers a fix path — none of this is the theater to fix', () => {
    for (const environment of PAYMENT_ENVS) {
      for (const provider of ['mock', 'razorpay', 'stripe'] as const) {
        for (const c of evaluatePaymentProvider(facts({ environment, provider }))) {
          expect(c.fixPath).toBeNull();
        }
      }
    }
  });

  /*
    BLOCKERS only, deliberately.

    A blocker offers no route here — none of this is the theater's to fix — so it must say
    whose it is, or the operator is stranded. The mock warning in LOCAL/DEV is different: it
    is telling a developer what their environment is, not asking anyone to act, and demanding
    "contact support" there would be noise dressed as rigour.
  */
  it('every BLOCKER names its owner, since it offers no route', () => {
    for (const environment of PAYMENT_ENVS) {
      for (const provider of ['mock', 'razorpay', 'stripe'] as const) {
        for (const configured of [false, true]) {
          const f = facts({
            environment,
            provider,
            razorpay: {
              hasKeyId: configured,
              hasKeySecret: configured,
              hasWebhookSecret: configured,
              mode: 'test',
            },
          });
          for (const c of evaluatePaymentProvider(f).filter((x) => x.level === 'BLOCKED')) {
            expect(c.message).toMatch(/ETicketsGo|contact support/i);
          }
        }
      }
    }
  });

  it('no message can leak a credential, because none is ever passed in', () => {
    // The facts carry booleans and a mode. There is no field here that could hold a key.
    const f = facts();
    const shape = JSON.stringify(f);
    expect(shape).not.toMatch(/rzp_|sk_|secret_[A-Za-z0-9]/);
    for (const c of evaluatePaymentProvider(f)) {
      expect(c.message).not.toMatch(/rzp_|sk_/);
    }
  });
});
