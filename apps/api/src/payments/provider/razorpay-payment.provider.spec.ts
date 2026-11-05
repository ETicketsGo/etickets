import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { RazorpayPaymentProvider } from './razorpay-payment.provider';
import { PaymentNotCapturedError } from '../domain/payment-errors';

const mockOrdersCreate = jest.fn();
const mockPaymentsRefund = jest.fn();
const mockFetchMultipleRefund = jest.fn();
const mockOrdersFetchPayments = jest.fn();

// Mock the Razorpay SDK so no network call is ever made.
jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { create: mockOrdersCreate, fetchPayments: mockOrdersFetchPayments },
    payments: { refund: mockPaymentsRefund, fetchMultipleRefund: mockFetchMultipleRefund },
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
  mockFetchMultipleRefund.mockReset();
  mockOrdersFetchPayments.mockReset();
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

  it('verifyWebhook carries the currency Razorpay charged in', async () => {
    const signed = signWebhook({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: 'pay_1', amount: 50_000, currency: 'INR', notes: { bookingId: 'bk_1' } },
        },
      },
    });
    const event = await makeProvider().verifyWebhook(signed);
    expect(event).toMatchObject({ amountMinor: 50_000, currency: 'INR' });
  });

  it('verifyWebhook maps a valid payment.failed to payment.failed', async () => {
    const signed = signWebhook({
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: 'pay_2',
            amount: 50_000,
            notes: { bookingId: 'bk_2' },
            error_code: 'BAD_REQUEST_ERROR',
            error_reason: 'international_transaction_not_allowed',
          },
        },
      },
    });
    const event = await makeProvider().verifyWebhook(signed);
    expect(event.type).toBe('payment.failed');
    expect(event.bookingId).toBe('bk_2');
    expect(event.amountMinor).toBe(50_000);
    // Why, as well as that: the buyer is told the card was international, not "try again".
    expect(event.failure).toEqual({
      reason: 'INTERNATIONAL_CARD_NOT_ACCEPTED',
      providerCode: 'international_transaction_not_allowed',
    });
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

  it('refund maps a pending refund to PROCESSING, not COMPLETED', async () => {
    // Razorpay creates refunds `pending` and settles them later by webhook.
    mockPaymentsRefund.mockResolvedValue({ id: 'rfnd_3', status: 'pending' });
    const result = await makeProvider().refund({ providerRef: 'pay_1', amountMinor: 1 });
    expect(result).toEqual({ providerRef: 'rfnd_3', status: 'PROCESSING' });
  });

  it('refund maps a failed refund to FAILED', async () => {
    mockPaymentsRefund.mockResolvedValue({ id: 'rfnd_2', status: 'failed' });
    const result = await makeProvider().refund({ providerRef: 'pay_1', amountMinor: 1 });
    expect(result).toEqual({ providerRef: 'rfnd_2', status: 'FAILED' });
  });

  // The key lets a later lookup recognise our refund. Razorpay also refuses a reused receipt
  // (observed on the TEST API), but a new key is a new receipt, so the caller still asks first.
  it('refund carries our key in receipt and notes', async () => {
    mockPaymentsRefund.mockResolvedValue({ id: 'rfnd_4', status: 'pending' });
    await makeProvider().refund({
      providerRef: 'pay_1',
      amountMinor: 500,
      reason: 'customer request',
      idempotencyKey: 'etg-rf-r1',
    });
    expect(mockPaymentsRefund).toHaveBeenCalledWith('pay_1', {
      amount: 500,
      receipt: 'etg-rf-r1',
      notes: { reason: 'customer request', etg_refund_key: 'etg-rf-r1' },
    });
  });

  it("lists a payment's refunds with the key we sent, its amount and status", async () => {
    mockFetchMultipleRefund.mockResolvedValue({
      count: 2,
      items: [
        { id: 'rfnd_a', amount: 500, status: 'processed', receipt: 'etg-rf-r1', created_at: 1 },
        { id: 'rfnd_b', amount: 200, status: 'pending', notes: { etg_refund_key: 'etg-rf-r2' } },
        { id: 'rfnd_c', amount: 100, status: 'failed', receipt: null, notes: [] },
      ],
    });
    const list = await makeProvider().findPaymentRefunds('pay_1');
    expect(mockFetchMultipleRefund).toHaveBeenCalledWith('pay_1', { count: 100 });
    expect(list).toEqual([
      {
        refundRef: 'rfnd_a',
        amountMinor: 500,
        status: 'COMPLETED',
        idempotencyKey: 'etg-rf-r1',
        createdAt: new Date(1000),
      },
      {
        refundRef: 'rfnd_b',
        amountMinor: 200,
        status: 'PROCESSING',
        idempotencyKey: 'etg-rf-r2',
        createdAt: null,
      },
      {
        refundRef: 'rfnd_c',
        amountMinor: 100,
        status: 'FAILED',
        idempotencyKey: null,
        createdAt: null,
      },
    ]);
  });

  it('a lookup that fails throws rather than answering "no refunds"', async () => {
    mockFetchMultipleRefund.mockRejectedValue(new Error('503'));
    await expect(makeProvider().findPaymentRefunds('pay_1')).rejects.toThrow('503');
  });

  /*
    The SDK rejects with a plain object. The orchestrator turned that into "[object Object]",
    which is what QA's console showed for every Razorpay refusal (ETG-IND-2026-000013/14/15).
  */
  it("a Razorpay refusal keeps Razorpay's own words", async () => {
    const refusal = {
      statusCode: 400,
      error: {
        code: 'BAD_REQUEST_ERROR',
        description: 'Duplicate receipt found for this refund request.',
      },
    };
    mockPaymentsRefund.mockRejectedValue(refusal);
    await expect(
      makeProvider().refund({ providerRef: 'pay_1', amountMinor: 1, idempotencyKey: 'etg-rf-r1' }),
    ).rejects.toThrow(
      'Razorpay 400 BAD_REQUEST_ERROR: Duplicate receipt found for this refund request.',
    );
    mockFetchMultipleRefund.mockRejectedValue({
      statusCode: 400,
      error: { code: 'BAD_REQUEST_ERROR', description: 'order_X is not a valid id' },
    });
    await expect(makeProvider().findPaymentRefunds('pay_1')).rejects.toThrow(
      'Razorpay 400 BAD_REQUEST_ERROR: order_X is not a valid id',
    );
  });

  it("an ORDER id is looked up through the order's captured payments", async () => {
    mockOrdersFetchPayments.mockResolvedValue({
      items: [
        { id: 'pay_failed', status: 'failed' },
        { id: 'pay_ok', status: 'captured' },
      ],
    });
    mockFetchMultipleRefund.mockResolvedValue({
      items: [{ id: 'rfnd_a', amount: 500, status: 'processed', receipt: 'etg-rf-r1' }],
    });
    const list = await makeProvider().findPaymentRefunds('order_1');
    expect(mockOrdersFetchPayments).toHaveBeenCalledWith('order_1');
    expect(mockFetchMultipleRefund).toHaveBeenCalledTimes(1);
    expect(mockFetchMultipleRefund).toHaveBeenCalledWith('pay_ok', { count: 100 });
    expect(list.map((r) => r.refundRef)).toEqual(['rfnd_a']);
  });

  // "No refunds" would permit a send; an order nobody paid has nothing to refund at all.
  it('an order with no captured payment throws instead of answering "no refunds"', async () => {
    mockOrdersFetchPayments.mockResolvedValue({ count: 0, items: [] });
    await expect(makeProvider().findPaymentRefunds('order_1')).rejects.toThrow(
      /no captured payment for order order_1/,
    );
    // Its own type, so the refund code reads it as "nothing paid", not "could not be asked".
    await expect(makeProvider().findPaymentRefunds('order_1')).rejects.toBeInstanceOf(
      PaymentNotCapturedError,
    );
    expect(mockFetchMultipleRefund).not.toHaveBeenCalled();
  });
});
