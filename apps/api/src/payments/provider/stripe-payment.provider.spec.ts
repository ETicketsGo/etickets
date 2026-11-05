import { ConfigService } from '@nestjs/config';
import { StripePaymentProvider } from './stripe-payment.provider';

const mockSessionsCreate = jest.fn();
const mockConstructEvent = jest.fn();
const mockRefundsCreate = jest.fn();
const mockRefundsList = jest.fn();
const mockSessionsRetrieve = jest.fn();
const mockSessionsExpire = jest.fn();

// Mock the Stripe SDK so no network call is ever made.
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: {
        create: mockSessionsCreate,
        retrieve: mockSessionsRetrieve,
        expire: mockSessionsExpire,
      },
    },
    webhooks: { constructEvent: mockConstructEvent },
    refunds: { create: mockRefundsCreate, list: mockRefundsList },
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
  mockRefundsList.mockReset();
  mockSessionsRetrieve.mockReset();
  mockSessionsExpire.mockReset();
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

    it('names the payload style when the SDK rejects a thin event notification', () => {
      /*
        The real path a thin destination takes: the SDK detects it before we ever see the
        object, and says so precisely. Our catch-all used to flatten that into "Invalid
        webhook signature", which sends whoever is debugging to check the secret while the
        actual problem is a dropdown on the destination.
      */
      mockConstructEvent.mockImplementation(() => {
        throw new Error(
          'You passed an event notification to stripe.webhooks.constructEvent, which expects a webhook payload.',
        );
      });
      expect(() =>
        makeProvider().verifySignedEnvelope!({ rawBody: '{}', signature: 'sig' }),
      ).toThrow(/thin|payload style/i);
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
      // Shaped like the SDK's own signature error, which is what distinguishes this from
      // a payload-shape rejection.
      mockConstructEvent.mockImplementation(() => {
        const e = new Error('No signatures found matching the expected signature.');
        (e as Error & { type: string }).type = 'StripeSignatureVerificationError';
        throw e;
      });
      expect(() =>
        makeProvider().verifySignedEnvelope!({ rawBody: '{}', signature: 'nope' }),
      ).toThrow(/Invalid webhook signature/i);
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
      providerOrderId: 'cs_1',
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
    expect(event).toMatchObject({
      type: 'payment.succeeded',
      providerRef: 'pi_1',
      bookingId: 'bk_1',
      amountMinor: 1000,
      checkoutSessionId: 'cs_1',
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

  it('refund sends our key as the Idempotency-Key and in metadata', async () => {
    mockRefundsCreate.mockResolvedValue({ id: 're_3', status: 'succeeded' });
    await makeProvider().refund({
      providerRef: 'pi_1',
      amountMinor: 1000,
      idempotencyKey: 'etg-rf-r1',
    });
    expect(mockRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_1',
        metadata: { etg_refund_key: 'etg-rf-r1' },
      }),
      { idempotencyKey: 'etg-rf-r1' },
    );
  });

  it("lists a PaymentIntent's refunds with the key read back from metadata", async () => {
    mockRefundsList.mockResolvedValue({
      data: [
        {
          id: 're_a',
          amount: 1000,
          status: 'succeeded',
          metadata: { etg_refund_key: 'etg-rf-r1' },
          created: 2,
        },
        { id: 're_b', amount: 300, status: 'canceled', metadata: {}, created: 3 },
      ],
    });
    const list = await makeProvider().findPaymentRefunds('pi_1');
    expect(mockRefundsList).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 100 });
    expect(list).toEqual([
      {
        refundRef: 're_a',
        amountMinor: 1000,
        status: 'COMPLETED',
        idempotencyKey: 'etg-rf-r1',
        createdAt: new Date(2000),
      },
      {
        refundRef: 're_b',
        amountMinor: 300,
        status: 'FAILED',
        idempotencyKey: null,
        createdAt: new Date(3000),
      },
    ]);
  });

  describe('checkout lifecycle', () => {
    const input = {
      bookingId: 'bk_1',
      amountMinor: 1000,
      currency: 'usd',
      buyerEmail: 'a@b.com',
      idempotencyKey: 'bk_1',
    };
    const invalid = () =>
      Object.assign(new Error('Only open sessions can be expired.'), {
        type: 'StripeInvalidRequestError',
      });

    it('sends the deadline as expires_at and keys the request on it', async () => {
      mockSessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://x', payment_intent: null });
      const expiresAt = new Date('2026-10-23T10:35:00Z');
      await makeProvider().createPayment({ ...input, expiresAt });
      const [params, opts] = mockSessionsCreate.mock.calls[0];
      expect(params.expires_at).toBe(Math.floor(expiresAt.getTime() / 1000));
      // A new deadline is a new request: Stripe rejects a reused key with other parameters.
      expect(opts.idempotencyKey).toBe(`bk_1:${params.expires_at}`);
    });

    it('marks an app checkout on both return URLs, and only then', async () => {
      mockSessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://x', payment_intent: null });
      await makeProvider().createPayment({ ...input, returnToApp: true });
      const [app, appOpts] = mockSessionsCreate.mock.calls[0];
      expect(app.success_url).toContain('booking=bk_1');
      expect(app.success_url).toContain('via=app');
      expect(app.cancel_url).toContain('via=app');
      expect(appOpts.idempotencyKey).toBe('bk_1:app');
      // The {CHECKOUT_SESSION_ID} template survives untouched for Stripe to fill in.
      expect(app.success_url).toContain('session_id={CHECKOUT_SESSION_ID}');

      await makeProvider().createPayment(input);
      const [web] = mockSessionsCreate.mock.calls[1];
      expect(web.success_url).not.toContain('via=app');
    });

    it('resumes only an open session', async () => {
      mockSessionsRetrieve.mockResolvedValueOnce({ status: 'open', url: 'https://pay/cs_1' });
      await expect(makeProvider().resumeCheckout('cs_1')).resolves.toBe('https://pay/cs_1');
      mockSessionsRetrieve.mockResolvedValueOnce({ status: 'expired', url: null });
      await expect(makeProvider().resumeCheckout('cs_1')).resolves.toBeNull();
    });

    it('closeOrder expires an open session', async () => {
      mockSessionsExpire.mockResolvedValue({ status: 'expired' });
      await expect(makeProvider().closeOrder('cs_1')).resolves.toBe('closed');
    });

    it('closeOrder reads a refusal as not_open only once the session is confirmed not open', async () => {
      mockSessionsExpire.mockRejectedValue(invalid());
      mockSessionsRetrieve.mockResolvedValueOnce({ status: 'complete' });
      await expect(makeProvider().closeOrder('cs_1')).resolves.toBe('not_open');
      mockSessionsRetrieve.mockResolvedValueOnce({ status: 'open' });
      await expect(makeProvider().closeOrder('cs_1')).rejects.toThrow(/open sessions/);
    });

    it('closeOrder never reads an outage as closed', async () => {
      mockSessionsExpire.mockRejectedValue(
        Object.assign(new Error('ECONNRESET'), { type: 'StripeConnectionError' }),
      );
      await expect(makeProvider().closeOrder('cs_1')).rejects.toThrow('ECONNRESET');
      expect(mockSessionsRetrieve).not.toHaveBeenCalled();
    });

    it('findOrderPayments: paid -> capture with currency; expired -> none; anything else throws', async () => {
      const p = makeProvider();
      mockSessionsRetrieve.mockResolvedValueOnce({
        id: 'cs_1',
        status: 'complete',
        payment_status: 'paid',
        payment_intent: 'pi_1',
        amount_total: 1000,
        currency: 'usd',
      });
      await expect(p.findOrderPayments('cs_1')).resolves.toEqual([
        { providerRef: 'pi_1', status: 'SUCCEEDED', amountMinor: 1000, currency: 'USD' },
      ]);
      mockSessionsRetrieve.mockResolvedValueOnce({ status: 'expired', payment_status: 'unpaid' });
      await expect(p.findOrderPayments('cs_1')).resolves.toEqual([]);
      // A delayed method (ACH, SEPA): complete, not yet paid. Could still succeed.
      mockSessionsRetrieve.mockResolvedValueOnce({ status: 'complete', payment_status: 'unpaid' });
      await expect(p.findOrderPayments('cs_1')).rejects.toThrow(/not yet final/);
      mockSessionsRetrieve.mockResolvedValueOnce({ status: 'open', payment_status: 'unpaid' });
      await expect(p.findOrderPayments('cs_1')).rejects.toThrow(/not yet final/);
    });

    it('a webhook carries the currency charged', async () => {
      mockConstructEvent.mockReturnValue({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_1',
            metadata: { bookingId: 'bk_1' },
            amount_total: 1000,
            currency: 'cad',
            payment_intent: 'pi_1',
            payment_status: 'paid',
          },
        },
      });
      await expect(
        makeProvider().verifyWebhook({ rawBody: '{}', signature: 'sig' }),
      ).resolves.toMatchObject({ currency: 'CAD', checkoutSessionId: 'cs_1' });
    });
  });
});
