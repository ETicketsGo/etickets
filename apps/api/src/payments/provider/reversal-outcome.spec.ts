import {
  stripeReversalFailure,
  razorpayReversalFailure,
  redactProviderError,
} from './reversal-outcome';

/**
 * What a provider error is allowed to prove.
 *
 * ── THE ASYMMETRY BEING PROTECTED ──────────────────────────────────────────────────
 * `REFUSED` means the provider did not act, so the operation may be raised again. `INDETERMINATE`
 * means we cannot say, so the only safe next step is to ASK the provider what it did.
 *
 * Getting this backwards costs money in one direction only. A timeout wrongly classed as
 * `REFUSED` invites a retry of an operation that may already have succeeded - the same money
 * comes back twice. A refusal wrongly classed as `INDETERMINATE` costs a reconciliation query.
 * So every uncertain case leans to `INDETERMINATE`, deliberately.
 */
describe('stripe reversal failures', () => {
  const err = (type: string, extra: Record<string, unknown> = {}) => ({
    type,
    message: `${type} happened`,
    ...extra,
  });

  it.each([
    'StripeInvalidRequestError',
    'StripeAuthenticationError',
    'StripePermissionError',
    'StripeRateLimitError',
    'StripeIdempotencyError',
  ])('%s is an authoritative refusal', (type) => {
    // Each is a rejection Stripe makes BEFORE acting; none can leave a reversal half-made.
    const out = stripeReversalFailure(err(type));
    expect(out.kind).toBe('REFUSED');
  });

  it('marks only a rate limit as retryable', () => {
    expect(stripeReversalFailure(err('StripeRateLimitError'))).toMatchObject({ retryable: true });
    expect(stripeReversalFailure(err('StripeInvalidRequestError'))).toMatchObject({
      retryable: false,
    });
  });

  it.each(['StripeConnectionError', 'StripeAPIError'])(
    '%s is INDETERMINATE, not a failure',
    (type) => {
      /*
      The important pair. A connection error means we never learned whether the request arrived;
      an API error means Stripe failed after accepting it. Either way the money may have moved.
    */
      expect(stripeReversalFailure(err(type)).kind).toBe('INDETERMINATE');
    },
  );

  it('treats an error it has never met as INDETERMINATE', () => {
    expect(stripeReversalFailure(err('StripeSomeFutureError')).kind).toBe('INDETERMINATE');
    expect(stripeReversalFailure(new Error('socket hang up')).kind).toBe('INDETERMINATE');
    expect(stripeReversalFailure(null).kind).toBe('INDETERMINATE');
    expect(stripeReversalFailure(undefined).kind).toBe('INDETERMINATE');
  });

  it('carries the provider code so a refusal can be diagnosed', () => {
    const out = stripeReversalFailure(
      err('StripeInvalidRequestError', { code: 'balance_insufficient' }),
    );
    expect(out).toMatchObject({ kind: 'REFUSED', code: 'balance_insufficient' });
  });
});

describe('razorpay reversal failures', () => {
  it.each([
    new Error('ETIMEDOUT'),
    { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR' } },
    { statusCode: 500 },
    null,
  ])('every error is INDETERMINATE until the taxonomy is evidenced (%#)', (e) => {
    /*
      Razorpay's error taxonomy for Route reversals is not evidenced anywhere in this repository,
      so there is no way to tell an authoritative refusal from transport noise. Guessing has an
      asymmetric cost, so nothing is guessed: everything is ambiguous and gets resolved by asking
      Razorpay what it did.

      When a sandbox session establishes which errors mean "we did nothing", this is where the
      mapping goes - and this test will have to change deliberately.
    */
    expect(razorpayReversalFailure(e).kind).toBe('INDETERMINATE');
  });

  it('never returns REFUSED', () => {
    // Stated as its own assertion because REFUSED is what invites a retry.
    const kinds = [new Error('x'), { statusCode: 400 }, {}].map(
      (e) => razorpayReversalFailure(e).kind,
    );
    expect(kinds).not.toContain('REFUSED');
  });
});

describe('what is kept from a provider error', () => {
  it('keeps what identifies the fault', () => {
    const out = redactProviderError({
      type: 'StripeInvalidRequestError',
      code: 'balance_insufficient',
      statusCode: 400,
      message: 'Insufficient funds',
    });
    expect(out).toEqual({
      type: 'StripeInvalidRequestError',
      code: 'balance_insufficient',
      statusCode: 400,
      message: 'Insufficient funds',
    });
  });

  it('keeps nothing else', () => {
    /*
      A thrown provider error can carry request headers, keys and customer detail. The attempt
      row is read by support and by reconciliation, so it holds what identifies the FAULT and
      nothing that identifies the account.
    */
    const out = redactProviderError({
      type: 'StripeAPIError',
      message: 'boom',
      headers: { authorization: 'Bearer sk_live_secret' },
      raw: { customer: 'cus_123', source: 'card_456' },
      requestId: 'req_789',
    });
    expect(Object.keys(out).sort()).toEqual(['code', 'message', 'statusCode', 'type']);
    expect(JSON.stringify(out)).not.toContain('sk_live');
    expect(JSON.stringify(out)).not.toContain('cus_123');
  });

  it('truncates a long message rather than storing an essay', () => {
    const out = redactProviderError({ type: 'E', message: 'x'.repeat(5000) });
    expect((out.message as string).length).toBe(300);
  });

  it('survives something that is not an error at all', () => {
    expect(redactProviderError('a string').type).toBe('unknown');
    expect(redactProviderError(null).type).toBe('unknown');
  });
});
