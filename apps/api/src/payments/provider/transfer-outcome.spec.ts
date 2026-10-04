import { razorpayTransferFailure, stripeTransferFailure } from './reversal-outcome';

/**
 * unit — what a thrown provider error proves about a TRANSFER.
 *
 * ── THE RULE, AND WHY IT IS ASYMMETRIC ─────────────────────────────────────────────────
 * An error becomes `REFUSED` only when it proves the provider did NOT act. Anything else is
 * `INDETERMINATE`, because the provider may have moved money while our answer was lost.
 *
 * The cost of being wrong is not symmetric. `REFUSED` invites a retry, and retrying a transfer
 * that already succeeded pays the organizer their whole payout twice. `INDETERMINATE` invites a
 * QUESTION, which is slower and cannot move money by mistake. These are the same decisions the
 * reversal side makes, applied to the larger amount.
 */

describe('Stripe transfer errors', () => {
  const refusals = [
    'StripeInvalidRequestError',
    'StripeAuthenticationError',
    'StripePermissionError',
    'StripeRateLimitError',
    'StripeIdempotencyError',
  ];

  it.each(refusals)('%s proves Stripe declined without acting', (type) => {
    const out = stripeTransferFailure({ type, code: 'c1', message: 'nope' });
    expect(out.kind).toBe('REFUSED');
  });

  it('marks only a rate limit as worth asking again', () => {
    expect(
      stripeTransferFailure({ type: 'StripeRateLimitError', message: 'slow down' }),
    ).toMatchObject({ kind: 'REFUSED', retryable: true });
    expect(
      stripeTransferFailure({ type: 'StripeInvalidRequestError', message: 'bad' }),
    ).toMatchObject({ kind: 'REFUSED', retryable: false });
  });

  it.each(['StripeConnectionError', 'StripeAPIError'])(
    '%s is INDETERMINATE, because the money may have moved',
    (type) => {
      /*
        The first means we never learned whether the request arrived. The second is Stripe
        failing AFTER accepting it. Calling either a refusal would invite the retry that pays
        twice.
      */
      expect(stripeTransferFailure({ type, message: 'x' }).kind).toBe('INDETERMINATE');
    },
  );

  it('treats an error shape it has never met as INDETERMINATE', () => {
    // Fail safe. An unrecognised error is not evidence that nothing happened.
    expect(stripeTransferFailure(new Error('something new')).kind).toBe('INDETERMINATE');
    expect(stripeTransferFailure(null).kind).toBe('INDETERMINATE');
    expect(stripeTransferFailure(undefined).kind).toBe('INDETERMINATE');
  });
});

describe('Razorpay transfer errors', () => {
  it.each([
    ['a timeout', { code: 'ETIMEDOUT', message: 'timeout' }],
    ['a refusal-looking error', { statusCode: 400, code: 'BAD_REQUEST_ERROR', message: 'no' }],
    ['an empty error', {}],
  ])('%s is INDETERMINATE', (_label, err) => {
    /*
      Not a claim about Razorpay. Its error taxonomy for Route is not evidenced anywhere in this
      repository, so a refusal and transport noise are indistinguishable to us - and guessing
      costs a duplicate payout in one direction and a question in the other.
    */
    expect(razorpayTransferFailure(err).kind).toBe('INDETERMINATE');
  });

  it('never returns REFUSED, so nothing can read a retry permission into it', () => {
    const samples = [{ statusCode: 400 }, { statusCode: 401 }, { statusCode: 500 }, new Error('x')];
    for (const s of samples) expect(razorpayTransferFailure(s).kind).not.toBe('REFUSED');
  });
});

describe('what is kept for storage', () => {
  it('keeps the fault and drops everything that identifies an account', () => {
    /*
      The attempt row is read by support and by reconciliation. A thrown provider error can carry
      request headers, keys and customer detail, so only the fields that identify the FAULT
      survive.
    */
    const raw = stripeTransferFailure({
      type: 'StripeConnectionError',
      code: 'econnreset',
      statusCode: 502,
      message: 'connection reset',
      // Things that must not survive:
      headers: { Authorization: 'Bearer sk_live_example' },
      requestId: 'req_secret',
      customer: 'cus_123',
    }).raw as Record<string, unknown>;

    expect(raw).toEqual({
      type: 'StripeConnectionError',
      code: 'econnreset',
      statusCode: 502,
      message: 'connection reset',
    });
    const serialised = JSON.stringify(raw);
    expect(serialised).not.toContain('sk_live');
    expect(serialised).not.toContain('Authorization');
    expect(serialised).not.toContain('cus_123');
  });

  it('truncates a long provider message rather than storing it whole', () => {
    const raw = razorpayTransferFailure({ message: 'x'.repeat(5_000) }).raw as {
      message: string;
    };
    expect(raw.message.length).toBeLessThanOrEqual(300);
  });
});
