import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { RazorpayPaymentProvider } from './razorpay-payment.provider';

const mockOrdersCreate = jest.fn();
const mockAccountsFetch = jest.fn();
const mockTransfersCreate = jest.fn();
const mockTransfersReverse = jest.fn();
const mockPaymentsFetch = jest.fn();

jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { create: mockOrdersCreate },
    accounts: { fetch: mockAccountsFetch },
    transfers: { create: mockTransfersCreate, reverse: mockTransfersReverse },
    payments: { fetch: mockPaymentsFetch, refund: jest.fn() },
  })),
);

const KEY_SECRET = 'rzp_test_secret';
const WEBHOOK_SECRET = 'test-razorpay-webhook-secret';

function makeProvider(routeEnabled = false): RazorpayPaymentProvider {
  const values: Record<string, string | boolean> = {
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RAZORPAY_ROUTE_ENABLED: routeEnabled,
  };
  const config = { get: (k: string) => values[k], getOrThrow: (k: string) => values[k] } as unknown as ConfigService;
  return new RazorpayPaymentProvider(config);
}

beforeEach(() => {
  mockOrdersCreate.mockReset();
  mockAccountsFetch.mockReset();
  mockTransfersCreate.mockReset();
  mockTransfersReverse.mockReset();
  mockPaymentsFetch.mockReset();
});

describe('createPayment (Order) — paise + PII-free notes', () => {
  it('creates an Order in paise with only internal ids in notes (no buyer PII)', async () => {
    mockOrdersCreate.mockResolvedValue({ id: 'order_1' });
    const provider = makeProvider();
    await provider.createPayment({
      bookingId: 'b1',
      amountMinor: 150000, // ₹1500.00
      currency: 'INR',
      buyerEmail: 'buyer@example.test',
      idempotencyKey: 'b1',
      metadata: { eventId: 'e1', organizerId: 'org1', customerId: 'u1' },
    });
    const arg = mockOrdersCreate.mock.calls[0][0];
    expect(arg.amount).toBe(150000);
    expect(arg.currency).toBe('INR');
    expect(arg.receipt).toBe('b1');
    expect(arg.notes).toEqual({ bookingId: 'b1', eventId: 'e1', organizerId: 'org1' });
    // The buyer email must NEVER be placed in notes.
    expect(JSON.stringify(arg.notes)).not.toContain('buyer@example.test');
  });
});

describe('verifyCheckoutSignature', () => {
  it('accepts a valid order|payment HMAC and rejects a tampered one', () => {
    const provider = makeProvider();
    const orderId = 'order_1';
    const paymentId = 'pay_1';
    const signature = createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
    expect(provider.verifyCheckoutSignature({ orderId, paymentId, signature })).toBe(true);
    expect(provider.verifyCheckoutSignature({ orderId, paymentId, signature: 'deadbeef' })).toBe(false);
  });
});

describe('verifySignedEnvelope (webhook)', () => {
  it('verifies the raw-body HMAC and normalizes the event', () => {
    const provider = makeProvider();
    const body = { event: 'payment.captured', created_at: 123, payload: { payment: { entity: { id: 'pay_1' } } } };
    const rawBody = JSON.stringify(body);
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    const env = provider.verifySignedEnvelope({ rawBody, signature });
    expect(env.type).toBe('payment.captured');
    expect(env.object).toEqual(body.payload);
  });

  it('rejects an invalid signature', () => {
    const provider = makeProvider();
    const rawBody = JSON.stringify({ event: 'payment.captured' });
    expect(() => provider.verifySignedEnvelope({ rawBody, signature: 'bad' })).toThrow(/signature/i);
  });
});

describe('getConnectedAccount (Linked Account status mapping)', () => {
  it('maps activated → charges/payouts enabled', async () => {
    mockAccountsFetch.mockResolvedValue({ id: 'acc_1', status: 'activated' });
    const s = await makeProvider().getConnectedAccount('acc_1');
    expect(s.chargesEnabled).toBe(true);
    expect(s.payoutsEnabled).toBe(true);
    expect(s.detailsSubmitted).toBe(true);
  });
  it('maps needs_clarification → requirement due, created → onboarding', async () => {
    mockAccountsFetch.mockResolvedValueOnce({ id: 'acc_2', status: 'needs_clarification' });
    expect((await makeProvider().getConnectedAccount('acc_2')).requirementsCurrentlyDue.length).toBeGreaterThan(0);
    mockAccountsFetch.mockResolvedValueOnce({ id: 'acc_3', status: 'created' });
    expect((await makeProvider().getConnectedAccount('acc_3')).detailsSubmitted).toBe(false);
  });
});

describe('getPayment — status map', () => {
  it('maps captured → CAPTURED', async () => {
    mockPaymentsFetch.mockResolvedValue({ id: 'pay_1', status: 'captured', amount: 150000, currency: 'INR' });
    const r = await makeProvider().getPayment('pay_1');
    expect(r.status).toBe('CAPTURED');
    expect(r.amountMinor).toBe(150000);
  });
});

describe('Route createTransfer gating', () => {
  it('throws when RAZORPAY_ROUTE_ENABLED is false (no fake transfer)', async () => {
    const provider = makeProvider(false);
    await expect(
      provider.createTransfer({
        amountMinor: 100000,
        currency: 'INR',
        destinationAccountId: 'acc_1',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow(/Route is not enabled/i);
    expect(mockTransfersCreate).not.toHaveBeenCalled();
  });

  it('creates a Route transfer to the linked account when enabled', async () => {
    mockTransfersCreate.mockResolvedValue({ id: 'trf_1' });
    const provider = makeProvider(true);
    const r = await provider.createTransfer({
      amountMinor: 100000,
      currency: 'inr',
      destinationAccountId: 'acc_1',
      idempotencyKey: 'k',
    });
    expect(r.transferId).toBe('trf_1');
    expect(mockTransfersCreate.mock.calls[0][0]).toMatchObject({ account: 'acc_1', amount: 100000, currency: 'INR' });
  });
});
