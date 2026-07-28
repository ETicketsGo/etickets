import { classifyRefundReconciliation, type RefundReconInput } from './refund-reconciliation';

const base = (over: Partial<RefundReconInput> = {}): RefundReconInput => ({
  paymentStatus: 'SUCCEEDED',
  capturedMinor: 5000,
  refundedMinor: 0,
  currency: 'USD',
  localRefunds: [],
  providerRefund: null,
  settlementConfirmed: true,
  ...over,
});

describe('classifyRefundReconciliation', () => {
  it('captured with no refund → CONSISTENT_NO_REFUND / NONE', () => {
    const r = classifyRefundReconciliation(base());
    expect(r.classification).toBe('CONSISTENT_NO_REFUND');
    expect(r.consistent).toBe(true);
  });

  it('fully refunded and matched → CONSISTENT_FULL_REFUND / NONE', () => {
    const r = classifyRefundReconciliation(
      base({
        paymentStatus: 'REFUNDED',
        refundedMinor: 5000,
        localRefunds: [{ status: 'COMPLETED', amountMinor: 5000, currency: 'USD' }],
        providerRefund: { status: 'COMPLETED', amountMinor: 5000, currency: 'USD' },
      }),
    );
    expect(r.classification).toBe('CONSISTENT_FULL_REFUND');
    expect(r.action).toBe('NONE');
  });

  it('over-refund is a critical invariant breach → OVER_REFUND / MANUAL_REVIEW', () => {
    const r = classifyRefundReconciliation(base({ refundedMinor: 6000 }));
    expect(r.classification).toBe('OVER_REFUND');
    expect(r.action).toBe('MANUAL_REVIEW');
  });

  it('negative refund is a critical invariant breach → NEGATIVE_REFUND', () => {
    expect(classifyRefundReconciliation(base({ refundedMinor: -1 })).classification).toBe(
      'NEGATIVE_REFUND',
    );
  });

  it('two completed refunds for one capture → DUPLICATE_COMPLETED_REFUND', () => {
    const r = classifyRefundReconciliation(
      base({
        paymentStatus: 'REFUNDED',
        refundedMinor: 5000,
        localRefunds: [
          { status: 'COMPLETED', amountMinor: 5000 },
          { status: 'COMPLETED', amountMinor: 5000 },
        ],
      }),
    );
    expect(r.classification).toBe('DUPLICATE_COMPLETED_REFUND');
  });

  it('provider currency differs → CURRENCY_MISMATCH', () => {
    const r = classifyRefundReconciliation(
      base({ providerRefund: { status: 'COMPLETED', amountMinor: 5000, currency: 'EUR' } }),
    );
    expect(r.classification).toBe('CURRENCY_MISMATCH');
  });

  it('local REFUNDED but provider missing → LOCAL_REFUNDED_PROVIDER_MISSING', () => {
    const r = classifyRefundReconciliation(
      base({
        paymentStatus: 'REFUNDED',
        refundedMinor: 5000,
        providerRefund: { status: 'NOT_FOUND' },
      }),
    );
    expect(r.classification).toBe('LOCAL_REFUNDED_PROVIDER_MISSING');
  });

  it('provider completed but local not finalized → PROVIDER_REFUNDED_LOCAL_MISSING', () => {
    const r = classifyRefundReconciliation(
      base({ providerRefund: { status: 'COMPLETED', amountMinor: 5000, currency: 'USD' } }),
    );
    expect(r.classification).toBe('PROVIDER_REFUNDED_LOCAL_MISSING');
  });

  it('refunded locally but amount differs from provider → AMOUNT_MISMATCH', () => {
    const r = classifyRefundReconciliation(
      base({
        paymentStatus: 'REFUNDED',
        refundedMinor: 5000,
        providerRefund: { status: 'COMPLETED', amountMinor: 4000, currency: 'USD' },
      }),
    );
    expect(r.classification).toBe('AMOUNT_MISMATCH');
  });

  it('refunded but settlement unconfirmed → SETTLEMENT_UNKNOWN', () => {
    const r = classifyRefundReconciliation(
      base({ paymentStatus: 'REFUNDED', refundedMinor: 5000, settlementConfirmed: false }),
    );
    expect(r.classification).toBe('SETTLEMENT_UNKNOWN');
  });

  it('open intent, no provider outcome, past threshold → INTENT_WITHOUT_OUTCOME / RETRY_STATUS_QUERY', () => {
    const r = classifyRefundReconciliation(
      base({
        localRefunds: [{ status: 'PROCESSING', amountMinor: 5000 }],
        openIntentAgeSeconds: 1000,
      }),
    );
    expect(r.classification).toBe('INTENT_WITHOUT_OUTCOME');
    expect(r.action).toBe('RETRY_STATUS_QUERY');
  });

  it('fresh open intent → REFUND_IN_FLIGHT / NONE (still watching)', () => {
    const r = classifyRefundReconciliation(
      base({
        localRefunds: [{ status: 'PROCESSING', amountMinor: 5000 }],
        openIntentAgeSeconds: 10,
      }),
    );
    expect(r.classification).toBe('REFUND_IN_FLIGHT');
    expect(r.consistent).toBe(true);
  });

  it('provider FAILED with an open intent → PROVIDER_REFUND_FAILED', () => {
    const r = classifyRefundReconciliation(
      base({
        localRefunds: [{ status: 'PROCESSING', amountMinor: 5000 }],
        providerRefund: { status: 'FAILED' },
      }),
    );
    expect(r.classification).toBe('PROVIDER_REFUND_FAILED');
  });

  it('is deterministic', () => {
    const i = base({ paymentStatus: 'REFUNDED', refundedMinor: 5000 });
    expect(JSON.stringify(classifyRefundReconciliation(i))).toEqual(
      JSON.stringify(classifyRefundReconciliation(i)),
    );
  });
});
