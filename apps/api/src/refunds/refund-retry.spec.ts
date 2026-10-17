import { assessRetry, lastAnswerOf, providerRefsOf, type RetryFacts } from './refund-retry';

/** A refund the provider refused outright, before anything else happened to it. */
const refused = (over: Partial<RetryFacts> = {}): RetryFacts => ({
  status: 'FAILED',
  amountMinor: 5000,
  history: [
    { action: 'REFUND_REQUESTED' },
    { action: 'REFUND_FAILED', metadata: { providerRef: 'rfnd_1' } },
  ],
  hasCreditNote: false,
  ticketsLive: true,
  bookingExists: true,
  paidInCash: false,
  payment: { amountMinor: 5000, refundedMinor: 0 },
  otherRefunds: [],
  unmatchedProviderRefunds: 0,
  confirmedNoProviderRefund: false,
  ...over,
});

describe('assessRetry: when a failed refund may be sent again', () => {
  it('allows a refund the provider refused, as the whole refund again', () => {
    const a = assessRetry(refused());
    expect(a).toMatchObject({ allowed: true, stage: 'TICKETS_HELD', lastAnswer: 'REFUSED' });
  });

  it('only ever retries a FAILED refund', () => {
    for (const status of ['REQUESTED', 'PROCESSING', 'COMPLETED', 'REJECTED']) {
      expect(assessRetry(refused({ status }))).toMatchObject({
        allowed: false,
        refusal: 'NOT_FAILED',
      });
    }
  });

  it('asks for the dashboard check when the last call never answered, and allows it after', () => {
    const unanswered = refused({ history: [{ action: 'REFUND_REQUESTED' }] });
    expect(assessRetry(unanswered)).toMatchObject({
      allowed: false,
      refusal: 'NEEDS_CONFIRMATION',
      needsConfirmation: true,
      lastAnswer: 'UNKNOWN',
    });
    expect(assessRetry({ ...unanswered, confirmedNoProviderRefund: true })).toMatchObject({
      allowed: true,
      lastAnswer: 'UNKNOWN',
    });
  });

  it('treats a retry with no recorded result as unanswered, never as refused', () => {
    const a = assessRetry(
      refused({
        history: [
          { action: 'REFUND_FAILED' },
          { action: 'REFUND_RETRY_STARTED', metadata: { previousProviderRef: 'rfnd_1' } },
        ],
      }),
    );
    expect(a).toMatchObject({ allowed: false, refusal: 'NEEDS_CONFIRMATION' });
  });

  it('retries only the money for a refund the provider accepted and then failed', () => {
    const a = assessRetry(
      refused({
        ticketsLive: false,
        hasCreditNote: true,
        history: [
          { action: 'REFUND_PROCESSING', metadata: { providerRef: 'rfnd_1' } },
          { action: 'REFUND_FAILED_AT_PROVIDER', metadata: { providerRefundId: 'rfnd_1' } },
        ],
      }),
    );
    expect(a).toMatchObject({ allowed: true, stage: 'TICKETS_RETURNED', lastAnswer: 'REFUSED' });
    expect(a.message).toMatch(/only asks the provider to pay/);
  });

  it('refuses when the tickets already went back some other way', () => {
    expect(assessRetry(refused({ ticketsLive: false }))).toMatchObject({
      allowed: false,
      refusal: 'TICKETS_GONE',
    });
    expect(
      assessRetry(refused({ history: [{ action: 'REFUND_TICKETS_NOT_LIVE' }] })),
    ).toMatchObject({ allowed: false, refusal: 'TICKETS_GONE' });
  });

  it('refuses while the provider reports a refund nothing here accounts for', () => {
    expect(assessRetry(refused({ unmatchedProviderRefunds: 1 }))).toMatchObject({
      allowed: false,
      refusal: 'UNMATCHED_PROVIDER_REFUND',
    });
    // Reported as refunded beyond what our settled refunds add up to.
    expect(
      assessRetry(
        refused({
          payment: { amountMinor: 10000, refundedMinor: 5000 },
          otherRefunds: [{ status: 'COMPLETED', amountMinor: 2000 }],
        }),
      ),
    ).toMatchObject({ allowed: false, refusal: 'UNMATCHED_PROVIDER_REFUND' });
    // ...and the confirmation does not override it.
    expect(
      assessRetry(refused({ unmatchedProviderRefunds: 1, confirmedNoProviderRefund: true })),
    ).toMatchObject({ allowed: false });
  });

  it('never returns more than was paid, counting refunds already made or in flight', () => {
    expect(
      assessRetry(
        refused({
          payment: { amountMinor: 8000, refundedMinor: 3000 },
          otherRefunds: [
            { status: 'COMPLETED', amountMinor: 3000 },
            { status: 'PROCESSING', amountMinor: 1000 },
            { status: 'FAILED', amountMinor: 9999 },
          ],
        }),
      ),
    ).toMatchObject({ allowed: false, refusal: 'OVER_PAYMENT' });
    expect(
      assessRetry(
        refused({
          payment: { amountMinor: 9000, refundedMinor: 3000 },
          otherRefunds: [
            { status: 'COMPLETED', amountMinor: 3000 },
            { status: 'PROCESSING', amountMinor: 1000 },
          ],
        }),
      ),
    ).toMatchObject({ allowed: true });
  });

  it('refuses cash, a missing booking and a paid booking with no payment', () => {
    expect(assessRetry(refused({ paidInCash: true }))).toMatchObject({ refusal: 'CASH' });
    expect(assessRetry(refused({ bookingExists: false }))).toMatchObject({
      refusal: 'BOOKING_MISSING',
    });
    expect(assessRetry(refused({ payment: null }))).toMatchObject({ refusal: 'NO_PAYMENT' });
    // A free booking has no payment and owes nothing: that one may be retried.
    expect(assessRetry(refused({ payment: null, amountMinor: 0 }))).toMatchObject({
      allowed: true,
    });
  });
});

describe('lastAnswerOf and providerRefsOf', () => {
  it('reads the newest attempt', () => {
    expect(lastAnswerOf([])).toBe('UNKNOWN');
    expect(lastAnswerOf([{ action: 'REFUND_FAILED' }])).toBe('REFUSED');
    expect(
      lastAnswerOf([
        { action: 'REFUND_FAILED' },
        { action: 'REFUND_RETRY_STARTED' },
        { action: 'REFUND_RETRY_RESULT', metadata: { outcome: 'FAILED' } },
      ]),
    ).toBe('REFUSED');
    expect(
      lastAnswerOf([
        { action: 'REFUND_FAILED' },
        { action: 'REFUND_RETRY_STARTED' },
        { action: 'REFUND_RETRY_RESULT', metadata: { outcome: 'ERROR' } },
      ]),
    ).toBe('UNKNOWN');
  });

  it('remembers every provider reference the refund has carried', () => {
    expect(
      providerRefsOf(
        [
          { action: 'REFUND_PROCESSING', metadata: { providerRef: 'rfnd_1' } },
          { action: 'REFUND_RETRY_STARTED', metadata: { previousProviderRef: 'rfnd_1' } },
          { action: 'REFUND_FAILED_AT_PROVIDER', metadata: { providerRefundId: 'rfnd_0' } },
        ],
        'rfnd_2',
      ).sort(),
    ).toEqual(['rfnd_0', 'rfnd_1', 'rfnd_2']);
  });
});

describe('assessRetry: the provider is asked first', () => {
  const unanswered = (over: Partial<RetryFacts> = {}) =>
    refused({ history: [{ action: 'REFUND_REQUESTED' }], ...over });

  it('records a refund the provider already made instead of sending one', () => {
    const a = assessRetry(
      unanswered({
        providerLookup: {
          kind: 'FOUND',
          providerRef: 'rfnd_9',
          status: 'COMPLETED',
          amountMinor: 5000,
        },
        // Razorpay's webhook may already have counted it against the payment.
        payment: { amountMinor: 5000, refundedMinor: 5000 },
      }),
    );
    expect(a).toMatchObject({
      allowed: true,
      action: 'RECORD_PROVIDER_REFUND',
      needsConfirmation: false,
    });
  });

  it('sends again without the dashboard check when the provider shows no refund', () => {
    const a = assessRetry(unanswered({ providerLookup: { kind: 'NONE' } }));
    expect(a).toMatchObject({ allowed: true, action: 'SEND', needsConfirmation: false });
    expect(a.message).toMatch(/same key/);
  });

  /*
    Real Razorpay does not list a refund while its create call is in flight. Right after a lost
    answer "no refund" is therefore not proof, and no tick unlocks it: the dashboard cannot show
    an unfinished refund either.
  */
  it('refuses to send on an empty lookup while the lost call may still be in flight', () => {
    const until = new Date('2026-10-16T12:10:00Z');
    for (const confirmedNoProviderRefund of [false, true]) {
      const a = assessRetry(
        unanswered({
          providerLookup: { kind: 'NONE' },
          noneBelievableAfter: until,
          confirmedNoProviderRefund,
        }),
      );
      expect(a).toMatchObject({ allowed: false, refusal: 'TOO_SOON', action: null });
      expect(a.message).toMatch(/2026-10-16 12:10 UTC/);
    }
    // A refund the provider DOES list is recorded whatever the clock says.
    const found = assessRetry(
      unanswered({
        providerLookup: {
          kind: 'FOUND',
          providerRef: 'rfnd_1',
          status: 'COMPLETED',
          amountMinor: 5000,
        },
        noneBelievableAfter: until,
      }),
    );
    expect(found).toMatchObject({ allowed: true, action: 'RECORD_PROVIDER_REFUND' });
  });

  it('still needs the dashboard check when the provider could not be asked', () => {
    const a = assessRetry(
      unanswered({
        providerLookup: { kind: 'UNAVAILABLE', reason: 'Razorpay answered 503' },
        manualReviewReason: 'Razorpay answered 503',
      }),
    );
    expect(a).toMatchObject({
      allowed: false,
      refusal: 'NEEDS_CONFIRMATION',
      manualReviewReason: 'Razorpay answered 503',
    });
    expect(a.message).toMatch(/manual check/);
  });

  it('refuses outright when the provider shows a refund it cannot match, even if confirmed', () => {
    const a = assessRetry(
      unanswered({
        providerLookup: { kind: 'UNMATCHED', reason: 'A refund of the same amount.' },
        confirmedNoProviderRefund: true,
      }),
    );
    expect(a).toMatchObject({ allowed: false, refusal: 'UNMATCHED_PROVIDER_REFUND', action: null });
  });

  it('does not let a found refund get past the tickets or the amount paid', () => {
    const found = {
      kind: 'FOUND' as const,
      providerRef: 'rfnd_9',
      status: 'COMPLETED' as const,
      amountMinor: 5000,
    };
    expect(assessRetry(unanswered({ providerLookup: found, ticketsLive: false })).refusal).toBe(
      'TICKETS_GONE',
    );
    expect(
      assessRetry(
        unanswered({
          providerLookup: found,
          otherRefunds: [{ status: 'COMPLETED', amountMinor: 1000 }],
        }),
      ).refusal,
    ).toBe('OVER_PAYMENT');
  });
});
