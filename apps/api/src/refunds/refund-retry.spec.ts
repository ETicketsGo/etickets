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
