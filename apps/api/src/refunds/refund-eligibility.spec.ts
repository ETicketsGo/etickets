import { BookingStatus } from '@eticketsgo/shared-types';
import { checkRefundEligibility } from './refund-eligibility';

const base = {
  bookingStatus: BookingStatus.CONFIRMED,
  sessionStartsAt: new Date('2026-08-01T18:00:00Z'),
};

describe('checkRefundEligibility', () => {
  it('allows a refund well before the cut-off', () => {
    const r = checkRefundEligibility({ ...base, now: new Date('2026-07-20T00:00:00Z') });
    expect(r.eligible).toBe(true);
  });

  it('blocks a refund inside the 48h window', () => {
    const r = checkRefundEligibility({ ...base, now: new Date('2026-07-31T00:00:00Z') });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/48 hours/);
  });

  it('blocks a refund on a non-refundable booking', () => {
    const r = checkRefundEligibility({
      ...base,
      bookingStatus: BookingStatus.EXPIRED,
      now: new Date('2026-07-01T00:00:00Z'),
    });
    expect(r.eligible).toBe(false);
  });

  it('respects a custom policy window', () => {
    const r = checkRefundEligibility({
      ...base,
      now: new Date('2026-07-31T00:00:00Z'),
      policyHours: 2,
    });
    expect(r.eligible).toBe(true);
  });
});
