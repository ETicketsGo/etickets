import { ConfigService } from '@nestjs/config';
import { MockPaymentProvider } from './mock-payment.provider';
import { RazorpayPaymentProvider } from './razorpay-payment.provider';
import { StripePaymentProvider } from './stripe-payment.provider';
import { PayPalPaymentProvider } from './paypal-payment.provider';
import { SquarePaymentProvider } from './square-payment.provider';
import { UnavailablePaymentProvider } from './unavailable-payment.provider';
import type { PaymentProvider } from './payment-provider.interface';

/**
 * adapter-contract — a capability may not claim something its adapter cannot do.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * `supportsIdempotentTransfer` decides whether a transfer whose outcome is unknown may be sent
 * again, and `supportsTransferStatusQuery` decides whether an ambiguous one can be resolved by
 * asking rather than by a person. Both are read as permission.
 *
 * The mock adapter declared BOTH true while implementing no transfer surface at all - no
 * `createTransfer`, no `getTransferState`. That is precisely the failure the capability model
 * exists to prevent, introduced by the very PR that added the capability. A declaration nobody
 * checks against the code is a comment with consequences.
 *
 * So every adapter is now checked against its own methods. This is structural: it cannot be
 * satisfied by remembering.
 */

function cfg(values: Record<string, string | boolean> = {}): ConfigService {
  return {
    get: (k: string) => values[k],
    getOrThrow: (k: string) => values[k] ?? 'x',
  } as unknown as ConfigService;
}

jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { create: jest.fn() },
    accounts: { fetch: jest.fn() },
    transfers: { create: jest.fn(), reverse: jest.fn(), fetch: jest.fn() },
    payments: { fetch: jest.fn(), refund: jest.fn() },
  })),
);
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    transfers: { create: jest.fn(), createReversal: jest.fn() },
    accounts: { create: jest.fn(), retrieve: jest.fn() },
    accountLinks: { create: jest.fn() },
    checkout: { sessions: { create: jest.fn() } },
    webhooks: { constructEvent: jest.fn() },
  })),
);

const adapters: Array<[string, () => PaymentProvider]> = [
  ['mock', () => new MockPaymentProvider(cfg()) as unknown as PaymentProvider],
  [
    'razorpay',
    () =>
      new RazorpayPaymentProvider(
        cfg({
          RAZORPAY_KEY_ID: 'rzp_test_key',
          RAZORPAY_KEY_SECRET: 'secret',
          RAZORPAY_WEBHOOK_SECRET: 'whsec',
          RAZORPAY_ROUTE_ENABLED: false,
        }),
      ) as unknown as PaymentProvider,
  ],
  [
    'stripe',
    () =>
      new StripePaymentProvider(
        cfg({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }),
      ) as unknown as PaymentProvider,
  ],
  [
    'paypal',
    () =>
      new PayPalPaymentProvider(
        // Placeholders. These adapters refuse to construct without keys; none is a real credential.
        cfg({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'wh' }),
      ) as unknown as PaymentProvider,
  ],
  [
    'square',
    () =>
      new SquarePaymentProvider(
        cfg({
          SQUARE_ACCESS_TOKEN: 'token',
          SQUARE_LOCATION_ID: 'loc',
          SQUARE_WEBHOOK_SIGNATURE_KEY: 'sig',
          SQUARE_APPLICATION_ID: 'app',
        }),
      ) as unknown as PaymentProvider,
  ],
  ['unavailable', () => new UnavailablePaymentProvider('test') as unknown as PaymentProvider],
];

describe.each(adapters)('%s adapter capability declarations', (_name, make) => {
  it('does not claim idempotent transfers without a transfer to make', () => {
    /*
      Claiming it on an adapter that cannot transfer at all is vacuous at best. Read as
      permission to replay, it is a licence granted by something that can never be exercised -
      and the next adapter to gain `createTransfer` would inherit the licence silently.
    */
    const p = make();
    if (p.capabilities.supportsIdempotentTransfer) {
      expect(typeof p.createTransfer).toBe('function');
    }
  });

  it('does not claim a status query it cannot perform', () => {
    const p = make();
    if (p.capabilities.supportsTransferStatusQuery) {
      expect(typeof p.getTransferState).toBe('function');
    }
  });

  it('does not claim idempotent refunds or voids it cannot perform', () => {
    // The same rule for the capabilities ADR-043 established, so this guard covers them too.
    const p = make();
    if (p.capabilities.supportsIdempotentRefund) expect(typeof p.refund).toBe('function');
    if (p.capabilities.supportsIdempotentVoid) expect(typeof p.cancel).toBe('function');
    if (p.capabilities.supportsRefundStatusQuery) expect(typeof p.getRefund).toBe('function');
    if (p.capabilities.supportsPaymentStatusQuery) expect(typeof p.getPayment).toBe('function');
  });
});

describe('the transfer capabilities as they actually stand', () => {
  it('no adapter can answer a transfer status query yet', () => {
    /*
      The honest state of the system, asserted so it cannot drift unnoticed. The SEAM exists -
      `getTransferState` is on the contract - but no adapter implements it, because mapping a
      provider status word to a disposition requires evidence from that provider.

      When one does, this test fails and must be updated deliberately. That is the point.
    */
    for (const [, make] of adapters) {
      const p = make();
      expect(p.capabilities.supportsTransferStatusQuery).toBe(false);
      expect(p.getTransferState).toBeUndefined();
    }
  });

  it('only Stripe claims it sends an idempotency identity with a transfer', () => {
    const claiming = adapters
      .filter(([, make]) => make().capabilities.supportsIdempotentTransfer)
      .map(([name]) => name);
    expect(claiming).toEqual(['stripe']);
  });
});
