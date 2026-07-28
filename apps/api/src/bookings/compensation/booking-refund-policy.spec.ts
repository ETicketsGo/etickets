import type { ConfigService } from '@nestjs/config';
import {
  DefaultBookingRefundPolicy,
  type BookingRefundPolicyContext,
  type RefundPolicyMode,
} from './booking-refund-policy';

function policy(mode: RefundPolicyMode) {
  const config = {
    get: jest.fn((k: string, d?: unknown) => (k === 'BOOKING_REFUND_POLICY_MODE' ? mode : d)),
  } as unknown as ConfigService;
  return new DefaultBookingRefundPolicy(config);
}

const ctx = (over: Partial<BookingRefundPolicyContext> = {}): BookingRefundPolicyContext => ({
  bookingId: 'b1',
  bookingStatus: 'CANCELLED',
  paymentStatus: 'SUCCEEDED',
  paymentProvider: 'mock',
  amountPaidMinor: 5000,
  currency: 'USD',
  ticketIssued: false,
  ticketCheckedIn: false,
  sessionStarted: false,
  eventCancelled: false,
  customerCancellation: true,
  settlementStatus: 'NONE',
  requestedAt: '2026-07-28T00:00:00.000Z',
  ...over,
});

describe('DefaultBookingRefundPolicy', () => {
  it('MANUAL_ONLY (default) reviews everything — never auto-eligible', () => {
    const d = policy('MANUAL_ONLY').evaluate(ctx());
    expect(d.eligible).toBe(false);
    expect(d.refundType).toBe('MANUAL_REVIEW');
    expect(d.reasonCode).toBe('POLICY_MANUAL_ONLY');
    expect(d.policyVersion).toBe('MANUAL_ONLY:v1');
  });

  it('TICKET_ONLY is not approved for automatic refunds', () => {
    expect(policy('TICKET_ONLY').evaluate(ctx()).requiresManualReview).toBe(true);
  });

  it('FULL_GROSS approves a full refund of the captured amount on a customer cancellation', () => {
    const d = policy('FULL_GROSS').evaluate(ctx({ customerCancellation: true }));
    expect(d.eligible).toBe(true);
    expect(d.refundType).toBe('FULL');
    expect(d.refundableAmountMinor).toBe(5000);
    expect(d.refundableCurrency).toBe('USD');
    expect(d.inventoryResellable).toBe(false); // never auto-restore
  });

  it('EVENT_CANCELLATION_FULL requires the event to be cancelled', () => {
    expect(
      policy('EVENT_CANCELLATION_FULL').evaluate(ctx({ eventCancelled: false }))
        .requiresManualReview,
    ).toBe(true);
    expect(policy('EVENT_CANCELLATION_FULL').evaluate(ctx({ eventCancelled: true })).eligible).toBe(
      true,
    );
  });

  it('never auto-refunds after check-in', () => {
    const d = policy('FULL_GROSS').evaluate(ctx({ ticketCheckedIn: true }));
    expect(d.requiresManualReview).toBe(true);
    expect(d.reasonCode).toBe('TICKET_CHECKED_IN');
  });

  it('blocks when the payment is not captured', () => {
    const d = policy('FULL_GROSS').evaluate(ctx({ paymentStatus: 'AUTHORIZED' }));
    expect(d.eligible).toBe(false);
    expect(d.reasonCode).toBe('PAYMENT_NOT_CAPTURED');
  });

  it('blocks on uncertain or completed settlement (fail closed)', () => {
    expect(
      policy('FULL_GROSS').evaluate(ctx({ settlementStatus: undefined })).requiresManualReview,
    ).toBe(true);
    expect(
      policy('FULL_GROSS').evaluate(ctx({ settlementStatus: 'COMPLETED' })).requiresManualReview,
    ).toBe(true);
  });

  it('blocks when provider cancellation is required but unsupported', () => {
    const d = policy('FULL_GROSS').evaluate(
      ctx({ providerCancellationRequired: true, providerCancellationSupported: false }),
    );
    expect(d.requiresManualReview).toBe(true);
    expect(d.reasonCode).toBe('PROVIDER_CANCELLATION_REQUIRED_UNSUPPORTED');
  });

  it('is deterministic', () => {
    const c = ctx();
    const p = policy('FULL_GROSS');
    expect(JSON.stringify(p.evaluate(c))).toEqual(JSON.stringify(p.evaluate(c)));
  });
});
