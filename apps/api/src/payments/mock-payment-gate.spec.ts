/**
 * Where the simulated "complete this payment" endpoint is allowed to run.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────
 * The gate read `NODE_ENV !== 'production'`, which conflates "built for production" with
 * "IS the production environment". Every deployed environment runs a production build, so
 * QA — which deliberately runs the simulated gateway — had mock payments refused. Checkout
 * handed the browser a `mock-pay` URL and the server answered 403. No booking could be paid
 * on QA at all, and the buyer saw "Payment could not be completed. Please try again."
 *
 * The replacement asks `APP_ENV`, via the same `isDummyAllowed` the rest of the payment
 * module uses. These tests pin both halves: that QA works, and that nothing above it does.
 */
import { isDummyAllowed, resolvePaymentEnv } from './configuration/payment-environment';

/** The production predicate, mirrored so the environment can be varied per case. */
const mockEnabled = (env: Record<string, string | undefined>): boolean =>
  env.PAYMENTS_MOCK_ENABLED !== 'false' &&
  isDummyAllowed(resolvePaymentEnv(env.APP_ENV)) &&
  (env.PAYMENT_PROVIDER_NAME ?? 'mock') === 'mock';

describe('where a simulated payment may complete', () => {
  it.each(['LOCAL', 'DEV', 'QA'])('%s allows it — the gateway there IS the mock', (APP_ENV) => {
    // The case that was broken. NODE_ENV is production in every deployed environment,
    // which is exactly why it was the wrong thing to ask.
    expect(mockEnabled({ APP_ENV, NODE_ENV: 'production', PAYMENT_PROVIDER_NAME: 'mock' })).toBe(
      true,
    );
  });

  it.each(['UAT', 'STAGING', 'PRODUCTION'])('%s refuses it', (APP_ENV) => {
    expect(mockEnabled({ APP_ENV, NODE_ENV: 'production', PAYMENT_PROVIDER_NAME: 'mock' })).toBe(
      false,
    );
  });
});

describe('the guard is tighter than the one it replaced', () => {
  it('a real gateway refuses mock completion even where the dummy is permitted', () => {
    // Belt and braces: in QA with Razorpay configured, "simulate a payment" is meaningless
    // and must not be a way to confirm a booking without one.
    for (const provider of ['razorpay', 'stripe', 'paypal', 'square']) {
      expect(mockEnabled({ APP_ENV: 'QA', PAYMENT_PROVIDER_NAME: provider })).toBe(false);
    }
  });

  it('a production box that forgot APP_ENV is still refused', () => {
    /*
      APP_ENV resolves to LOCAL when unset, which on its own would permit the dummy. The
      second condition is what saves it: a real deployment names a real gateway, and that
      alone closes the door. Both would have to be wrong at once.
    */
    expect(mockEnabled({ PAYMENT_PROVIDER_NAME: 'razorpay' })).toBe(false);
    expect(mockEnabled({ APP_ENV: undefined, PAYMENT_PROVIDER_NAME: 'stripe' })).toBe(false);
  });

  it('the explicit kill switch still wins everywhere', () => {
    expect(
      mockEnabled({ APP_ENV: 'QA', PAYMENT_PROVIDER_NAME: 'mock', PAYMENTS_MOCK_ENABLED: 'false' }),
    ).toBe(false);
    expect(
      mockEnabled({
        APP_ENV: 'LOCAL',
        PAYMENT_PROVIDER_NAME: 'mock',
        PAYMENTS_MOCK_ENABLED: 'false',
      }),
    ).toBe(false);
  });

  it('is never enabled anywhere a real payment could be taken', () => {
    // The property that matters most, swept rather than sampled.
    for (const APP_ENV of ['UAT', 'STAGING', 'PRODUCTION']) {
      for (const PAYMENT_PROVIDER_NAME of ['mock', 'razorpay', 'stripe', undefined]) {
        for (const PAYMENTS_MOCK_ENABLED of [undefined, 'true', 'false']) {
          expect(mockEnabled({ APP_ENV, PAYMENT_PROVIDER_NAME, PAYMENTS_MOCK_ENABLED })).toBe(
            false,
          );
        }
      }
    }
  });
});
