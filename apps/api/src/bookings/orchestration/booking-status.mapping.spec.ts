import { BookingWorkflowState as WS } from './booking-workflow-state';
import { toPublicBookingStatus } from './booking-status.mapping';

describe('toPublicBookingStatus', () => {
  it('maps confirmed/ticket states to CONFIRMED', () => {
    for (const s of [WS.CONFIRMED, WS.TICKET_PENDING, WS.TICKET_ISSUED]) {
      expect(toPublicBookingStatus(s)).toBe('CONFIRMED');
    }
  });

  it('maps in-flight states to PENDING', () => {
    for (const s of [
      WS.DRAFT,
      WS.INVENTORY_RESOLVED,
      WS.LOCK_PENDING,
      WS.LOCKED,
      WS.PAYMENT_PENDING,
      WS.PAYMENT_AUTHORIZED,
      WS.CONFIRMING,
    ]) {
      expect(toPublicBookingStatus(s)).toBe('PENDING');
    }
  });

  it('maps cancellation/expiry/refund states to their public equivalents', () => {
    expect(toPublicBookingStatus(WS.CANCELLATION_PENDING)).toBe('CANCELLED');
    expect(toPublicBookingStatus(WS.CANCELLED)).toBe('CANCELLED');
    expect(toPublicBookingStatus(WS.EXPIRING)).toBe('EXPIRED');
    expect(toPublicBookingStatus(WS.EXPIRED)).toBe('EXPIRED');
    expect(toPublicBookingStatus(WS.REFUND_PENDING)).toBe('REFUND_PENDING');
    expect(toPublicBookingStatus(WS.REFUNDED)).toBe('REFUNDED');
  });

  it('never leaks internal states and never shows them as CONFIRMED', () => {
    for (const s of [WS.MANUAL_REVIEW, WS.COMPENSATION_PENDING, WS.COMPENSATED, WS.FAILED]) {
      const pub = toPublicBookingStatus(s);
      expect(pub).toBe('ACTION_REQUIRED');
      expect(pub).not.toBe('CONFIRMED');
    }
    // The internal provider-confirm states are pending to the customer, never leaked.
    expect(toPublicBookingStatus(WS.PROVIDER_CONFIRM_PENDING)).toBe('PENDING');
    expect(toPublicBookingStatus(WS.PROVIDER_CONFIRMED)).toBe('PENDING');
  });
});
