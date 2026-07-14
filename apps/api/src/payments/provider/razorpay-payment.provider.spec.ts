import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { RazorpayPaymentProvider } from './razorpay-payment.provider';

const mockOrdersCreate = jest.fn();
const mockPaymentsRefund = jest.fn();

// Mock the Razorpay SDK so no network call is ever made.
jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { create: mockOrdersCreate },
    payments: { refund: mockPaymentsRefund },
  })),
);

const WEBHOOK_SECRET = 'test-razorpay-webhook-secret';

function makeProvider(): RazorpayPaymentProvider {
  const values: Record<string, string> = {
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: 'rzp_test_secret',
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  };
  const config = {
    get: (k: string) => values[k],
    getOrThrow: (k: string) => values[k],
  } as unknown as ConfigService;
  return new RazorpayPaymentProvider(config);
}

/** Build a Razorpay-style webhook body and its HMAC-SHA256 signature. */
function signWebhook(body: object): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(body);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  return { rawBody, signature };
}

beforeEach(() => {
  mockOrdersCreate.mockReset();
  mockPaymentsRefund.mockReset();
});

describe('RazorpayPaymentProvider', () => {
  it('declares the razorpay webhook header', () => {
    expect(makeProvider().webhookSignatureHeader).toBe('x-razorpay-signature');
  });

  it('createPayment creates an order and returns its id as providerRef + clientActionUrl', async () => {
    mockOrdersCreate.mockResolvedValue({ id: 'order_ABC123' });
    const provider = makeProvider();
    const intent = await provider.createPayment({
      bookingId: 'bk_1',
      amountMinor: 50_000,
      currency: 'INR',
      buyerEmail: 'a@b.com',
      idempotencyKey: 'bk_1',
    });
    expect(mockOrdersCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 50_000,
        currency: 'INR',
        receipt: 'bk_1',
        notes: expect.objectContaining({ bookingId: 'bk_1' }),
      }),
    );
    expect(intent).toEqual({
      providerRef: 'order_ABC123',
      clientActionUrl: 'order_ABC123',
      status: 'REQUIRES_PAYMENT',
    });
  });

  it('verifyWebhook maps a valid payment.captured to payment.succeeded', async () => {
    const signed = signWebhook({
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: 'pay_1', amount: 50_000, notes: { bookingId: 'bk_1' } } },
      },
    });
    const event = await makeProvider().verifyWebhook(signed);
    expect(event).toEqual({
      type: 'payment.succeeded',
      providerRef: 'pay_1',
      bookingId: 'bk_1',
      amountMinor: 50_000,
    });
  });

  it('verifyWebhook maps a valid payment.failed to payment.failed', async () => {
    const signed = signWebhook({
      event: 'payment.failed',
      payload: {
        payment: { entity: { id: 'pay_2', amount: 50_000, notes: { bookingId: 'bk_2' } } },
      },
    });
    const event = await makeProvider().verifyWebhook(signed);
    expect(event.type).toBe('payment.failed');
    expect(event.bookingId).toBe('bk_2');
    expect(event.amountMinor).toBe(50_000);
  });

  it('verifyWebhook rejects an invalid signature', async () => {
    const signed = signWebhook({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', amount: 1, notes: { bookingId: 'bk_1' } } } },
    });
    await expect(
      makeProvider().verifyWebhook({ ...signed, signature: 'deadbeef' }),
    ).rejects.toMatchObject({ code: 'PAYMENT_WEBHOOK_INVALID' });
  });

  it('verifyWebhook rejects an unhandled event type', async () => {
    const signed = signWebhook({
      event: 'order.paid',
      payload: { payment: { entity: { id: 'pay_1', amount: 1, notes: { bookingId: 'bk_1' } } } },
    });
    await expect(makeProvider().verifyWebhook(signed)).rejects.toMatchObject({
      code: 'PAYMENT_WEBHOOK_INVALID',
    });
  });

  it('refund maps a processed refund to COMPLETED', async () => {
    mockPaymentsRefund.mockResolvedValue({ id: 'rfnd_1', status: 'processed' });
    const result = await makeProvider().refund({ providerRef: 'pay_1', amountMinor: 50_000 });
    expect(mockPaymentsRefund).toHaveBeenCalledWith(
      'pay_1',
      expect.objectContaining({ amount: 50_000 }),
    );
    expect(result).toEqual({ providerRef: 'rfnd_1', status: 'COMPLETED' });
  });

  it('refund maps a failed refund to FAILED', async () => {
    mockPaymentsRefund.mockResolvedValue({ id: 'rfnd_2', status: 'failed' });
    const result = await makeProvider().refund({ providerRef: 'pay_1', amountMinor: 1 });
    expect(result).toEqual({ providerRef: 'rfnd_2', status: 'FAILED' });
  });
});
