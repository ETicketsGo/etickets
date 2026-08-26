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

/*
  Whose policy decides.

  The cut-off used to be a constant here — 48 hours, for every event on the platform. That
  meant showing buyers a refund button the organizer had never agreed to honour, and granting
  requests they would have refused. The money still leaves when that happens, so the platform
  was underwriting a promise it had no standing to make.
*/
describe('the organizer owns the refund policy', () => {
  const base = {
    bookingStatus: 'CONFIRMED' as never,
    sessionStartsAt: new Date('2026-09-01T00:00:00Z'),
    now: new Date('2026-08-01T00:00:00Z'),
  };

  it('refuses outright when the organizer does not offer refunds', () => {
    const out = checkRefundEligibility({ ...base, refundsEnabled: false });
    expect(out.eligible).toBe(false);
    expect(out.reason).toMatch(/does not offer refunds/i);
  });

  it('honours a cut-off the organizer chose, not the platform default', () => {
    // Ten days out. Fine under the 48-hour default, refused under a 30-day policy.
    const near = { ...base, now: new Date('2026-08-22T00:00:00Z') };
    expect(checkRefundEligibility(near).eligible).toBe(true);
    expect(checkRefundEligibility({ ...near, policyHours: 24 * 30 }).eligible).toBe(false);
  });

  it('lets an organizer accept refunds right up to the start', () => {
    // policyHours 0 is a real choice, and must not be read as "unset, use 48".
    const out = checkRefundEligibility({
      ...base,
      policyHours: 0,
      now: new Date('2026-08-31T23:00:00Z'),
    });
    expect(out.eligible).toBe(true);
  });

  it('behaves exactly as before for an event nobody has configured', () => {
    // The defaults must not change the answer for existing events.
    expect(checkRefundEligibility(base).eligible).toBe(true);
    expect(
      checkRefundEligibility({ ...base, now: new Date('2026-08-31T00:00:00Z') }).eligible,
    ).toBe(false);
  });

  it('still refuses a status that was never refundable, whatever the policy says', () => {
    // An organizer enabling refunds cannot make a cancelled booking refundable.
    const out = checkRefundEligibility({
      ...base,
      bookingStatus: 'CANCELLED' as never,
      refundsEnabled: true,
    });
    expect(out.eligible).toBe(false);
  });
});
