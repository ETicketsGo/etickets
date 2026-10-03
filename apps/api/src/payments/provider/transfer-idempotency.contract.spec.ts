import { ConfigService } from '@nestjs/config';
import { RazorpayPaymentProvider } from './razorpay-payment.provider';
import { StripePaymentProvider } from './stripe-payment.provider';

/**
 * adapter-contract — does the adapter actually send an idempotency identity with a transfer?
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────
 * `supportsIdempotentTransfer` gates automatic replay of a transfer whose outcome is unknown. A
 * capability flag that nobody checks against the code is just a comment, and this one decides
 * whether money can be sent to an organizer a second time.
 *
 * So each adapter's declaration is checked against what it puts on the wire. The capability
 * describes OUR ADAPTER, not the provider's API: an adapter that never sends an identity declares
 * false even if the provider would honour one, because nothing in our code gives it the chance.
 *
 * ── THIS IS NOT PROVIDER EVIDENCE ──────────────────────────────────────────────────────
 * The clients are doubles. These tests prove what we SEND, which is a fact about this repository
 * and is exactly what the capability claims. They prove nothing about what Stripe or Razorpay do
 * with it. Whether the Razorpay API offers transfer idempotency at all is an open question that
 * only Razorpay can answer.
 */

const mockTransfersCreate = jest.fn();
jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { create: jest.fn() },
    accounts: { fetch: jest.fn() },
    transfers: { create: mockTransfersCreate, reverse: jest.fn(), fetch: jest.fn() },
    payments: { fetch: jest.fn(), refund: jest.fn() },
  })),
);

const mockStripeTransfersCreate = jest.fn();
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    transfers: { create: mockStripeTransfersCreate, createReversal: jest.fn() },
    accounts: { create: jest.fn(), retrieve: jest.fn() },
    accountLinks: { create: jest.fn() },
    checkout: { sessions: { create: jest.fn() } },
    webhooks: { constructEvent: jest.fn() },
  })),
);

function config(values: Record<string, string | boolean>): ConfigService {
  return {
    get: (k: string) => values[k],
    getOrThrow: (k: string) => values[k],
  } as unknown as ConfigService;
}

const razorpay = () =>
  new RazorpayPaymentProvider(
    config({
      RAZORPAY_KEY_ID: 'rzp_test_key',
      RAZORPAY_KEY_SECRET: 'rzp_test_secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsec-test',
      RAZORPAY_ROUTE_ENABLED: true,
    }),
  );

const stripe = () =>
  new StripePaymentProvider(
    config({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }),
  );

const TRANSFER = {
  amountMinor: 50_000,
  currency: 'inr',
  destinationAccountId: 'acc_linked',
  idempotencyKey: 'settlement_s1_0',
  metadata: { settlementId: 's1' },
};

beforeEach(() => {
  mockTransfersCreate.mockReset();
  mockStripeTransfersCreate.mockReset();
});

describe('Stripe transfers carry the idempotency identity', () => {
  it('passes the key to the client', async () => {
    mockStripeTransfersCreate.mockResolvedValue({ id: 'tr_1' });
    await stripe().createTransfer!({ ...TRANSFER, currency: 'usd' });

    // Stripe takes it as request OPTIONS, not as a body field.
    const [, options] = mockStripeTransfersCreate.mock.calls[0];
    expect(options).toMatchObject({ idempotencyKey: 'settlement_s1_0' });
  });

  it('declares the capability its code earns', () => {
    expect(stripe().capabilities.supportsIdempotentTransfer).toBe(true);
  });
});

describe('Razorpay transfers do NOT carry an idempotency identity', () => {
  it('sends no identity anywhere in the request', async () => {
    /*
      The gap, pinned down. `createTransfer` accepts `idempotencyKey` and then sends only
      account/amount/currency/notes. A replayed request is therefore a NEW transfer, and the
      organizer would be paid twice.
    */
    mockTransfersCreate.mockResolvedValue({ id: 'trf_1' });
    await razorpay().createTransfer!(TRANSFER);

    expect(mockTransfersCreate).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(mockTransfersCreate.mock.calls[0]);
    expect(sent).not.toContain('settlement_s1_0');
    expect(sent).not.toMatch(/idempotenc/i);
  });

  it('declares false, which is what its code earns', () => {
    /*
      Not a claim that Razorpay cannot do this - only that WE do not ask it to. Changing the
      declaration requires changing the adapter AND verified Razorpay documentation.
    */
    expect(razorpay().capabilities.supportsIdempotentTransfer).toBe(false);
  });
});

describe('no adapter claims a transfer status query it does not implement', () => {
  it('neither adapter exposes one', () => {
    /*
      The contract has `getTransferReversalState` and nothing that asks about a TRANSFER. After
      an ambiguous transfer there is no query to recover with, so both declare false and the
      readiness assessment can rely on that rather than on hope.
    */
    expect(stripe().capabilities.supportsTransferStatusQuery).toBe(false);
    expect(razorpay().capabilities.supportsTransferStatusQuery).toBe(false);
    expect((stripe() as { getTransferState?: unknown }).getTransferState).toBeUndefined();
    expect((razorpay() as { getTransferState?: unknown }).getTransferState).toBeUndefined();
  });
});
