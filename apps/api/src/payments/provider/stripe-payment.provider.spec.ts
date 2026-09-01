import { ConfigService } from '@nestjs/config';
import { StripePaymentProvider } from './stripe-payment.provider';

const mockSessionsCreate = jest.fn();
const mockConstructEvent = jest.fn();
const mockRefundsCreate = jest.fn();

// Mock the Stripe SDK so no network call is ever made.
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockSessionsCreate } },
    webhooks: { constructEvent: mockConstructEvent },
    refunds: { create: mockRefundsCreate },
  })),
);

function makeProvider(): StripePaymentProvider {
  const values: Record<string, string> = {
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_SUCCESS_URL: 'http://localhost:3000/ok?session_id={CHECKOUT_SESSION_ID}',
    STRIPE_CANCEL_URL: 'http://localhost:3000/cancel',
  };
  const config = {
    get: (k: string) => values[k],
    getOrThrow: (k: string) => values[k],
  } as unknown as ConfigService;
  return new StripePaymentProvider(config);
}

beforeEach(() => {
  mockSessionsCreate.mockReset();
  mockConstructEvent.mockReset();
  mockRefundsCreate.mockReset();
});

describe('StripePaymentProvider', () => {
  describe('webhook payload style', () => {
    /*
      Stripe destinations can be created with a "thin" payload style, which carries ids
      instead of the object and has no `data` at all. One was created against the QA
      endpoint alongside the snapshot one — this is what happens next.
    */
    it('accepts a snapshot event, which is the style every handler reads', () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1',
        type: 'checkout.session.completed',
        created: 1,
        data: { object: { id: 'cs_1' } },
      });
      const envelope = makeProvider().verifySignedEnvelope!({
        rawBody: '{}',
        signature: 'sig',
      });
      expect(envelope).toMatchObject({ id: 'evt_1', object: { id: 'cs_1' } });
    });

    it('refuses a thin event by name instead of throwing a TypeError', () => {
      /*
        Without the guard this read `event.data.object` on an object with no `data` — a
        TypeError, so the endpoint answered 500, Stripe recorded a failed delivery and
        retried it on a backoff, and the dashboard's error rate climbed for a reason no
        log explained. The message has to name the dashboard setting, because that is the
        only place the problem can be fixed.
      */
      mockConstructEvent.mockReturnValue({
        id: 'evt_thin',
        type: 'v1.billing.meter.error_report_triggered',
        created: 1,
        related_object: { id: 'obj_1', type: 'billing.meter' },
      });
      expect(() =>
        makeProvider().verifySignedEnvelope!({ rawBody: '{}', signature: 'sig' }),
      ).toThrow(/thin/i);
    });

    it('still refuses an unsigned or tampered event first', () => {
      // Signature verification must come before any payload reasoning: an unverified body
      // is not evidence of anything, including its own shape.
      mockConstructEvent.mockImplementation(() => {
        throw new Error('bad signature');
      });
      expect(() =>
        makeProvider().verifySignedEnvelope!({ rawBody: '{}', signature: 'nope' }),
      ).toThrow(/signature/i);
    });
  });

  it('declares the stripe webhook header', () => {
    expect(makeProvider().webhookSignatureHeader).toBe('stripe-signature');
  });

  it('createPayment creates a Checkout Session and returns url + payment_intent', async () => {
    mockSessionsCreate.mockResolvedValue({
      id: 'cs_1',
      url: 'https://checkout.stripe.com/pay/cs_1',
      payment_intent: 'pi_1',
    });
    const intent = await makeProvider().createPayment({
      bookingId: 'bk_1',
      amountMinor: 1000,
      currency: 'usd',
      buyerEmail: 'a@b.com',
      idempotencyKey: 'bk_1',
    });
    // Idempotency key is forwarded as SDK request options.
    expect(mockSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        client_reference_id: 'bk_1',
        metadata: { bookingId: 'bk_1' },
      }),
      { idempotencyKey: 'bk_1' },
    );
    expect(intent).toEqual({
      providerRef: 'pi_1',
      clientActionUrl: 'https://checkout.stripe.com/pay/cs_1',
      status: 'REQUIRES_PAYMENT',
    });
  });

  it('createPayment falls back to session id when payment_intent is not yet set', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_2', url: 'https://x', payment_intent: null });
    const intent = await makeProvider().createPayment({
      bookingId: 'bk_2',
      amountMinor: 1000,
      currency: 'usd',
      buyerEmail: 'a@b.com',
      idempotencyKey: 'bk_2',
    });
    expect(intent.providerRef).toBe('cs_2');
  });

  it('verifyWebhook maps checkout.session.completed to payment.succeeded', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          metadata: { bookingId: 'bk_1' },
          client_reference_id: 'bk_1',
          amount_total: 1000,
          payment_intent: 'pi_1',
        },
      },
    });
    const event = await makeProvider().verifyWebhook({ rawBody: '{}', signature: 'sig' });
    expect(event).toEqual({
      type: 'payment.succeeded',
      providerRef: 'pi_1',
      bookingId: 'bk_1',
      amountMinor: 1000,
    });
    expect(mockConstructEvent).toHaveBeenCalledWith('{}', 'sig', 'whsec_test');
  });

  it('verifyWebhook maps payment_intent.payment_failed to payment.failed', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_9', metadata: { bookingId: 'bk_9' }, amount: 1000 } },
    });
    const event = await makeProvider().verifyWebhook({ rawBody: '{}', signature: 'sig' });
    expect(event).toEqual({
      type: 'payment.failed',
      providerRef: 'pi_9',
      bookingId: 'bk_9',
      amountMinor: 1000,
    });
  });

  it('verifyWebhook rejects an invalid signature', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('signature mismatch');
    });
    await expect(
      makeProvider().verifyWebhook({ rawBody: '{}', signature: 'bad' }),
    ).rejects.toMatchObject({ code: 'PAYMENT_WEBHOOK_INVALID' });
  });

  it('verifyWebhook rejects an unhandled event type', async () => {
    mockConstructEvent.mockReturnValue({ type: 'invoice.paid', data: { object: {} } });
    await expect(
      makeProvider().verifyWebhook({ rawBody: '{}', signature: 'sig' }),
    ).rejects.toMatchObject({ code: 'PAYMENT_WEBHOOK_INVALID' });
  });

  it('refund maps a succeeded refund to COMPLETED', async () => {
    mockRefundsCreate.mockResolvedValue({ id: 're_1', status: 'succeeded' });
    const result = await makeProvider().refund({ providerRef: 'pi_1', amountMinor: 1000 });
    expect(mockRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_1', amount: 1000 }),
    );
    expect(result).toEqual({ providerRef: 're_1', status: 'COMPLETED' });
  });

  it('refund maps a failed refund to FAILED', async () => {
    mockRefundsCreate.mockResolvedValue({ id: 're_2', status: 'failed' });
    const result = await makeProvider().refund({ providerRef: 'pi_1', amountMinor: 1000 });
    expect(result).toEqual({ providerRef: 're_2', status: 'FAILED' });
  });
});
