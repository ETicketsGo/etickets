import { bookingTone, isLiveBooking } from '../schema';

/**
 * These pin the statuses the deployed API actually emits, taken from a live QA account
 * rather than from a fixture: PENDING_PAYMENT, EXPIRED and CONFIRMED all appeared in one
 * `GET /bookings` response. Both defects below were invisible against invented data.
 */
describe('bookingTone', () => {
  it('treats PENDING_PAYMENT as needing attention', () => {
    // REGRESSION: only PENDING / HELD / AWAITING_PAYMENT were listed, so the one status
    // that actually needs the customer to do something fell through to the neutral grey
    // reserved for statuses this app does not recognise.
    expect(bookingTone('PENDING_PAYMENT')).toBe('warning');
  });

  it('still maps the states it already knew', () => {
    expect(bookingTone('CONFIRMED')).toBe('success');
    expect(bookingTone('COMPLETED')).toBe('success');
    expect(bookingTone('AWAITING_PAYMENT')).toBe('warning');
    expect(bookingTone('EXPIRED')).toBe('error');
    expect(bookingTone('CANCELLED')).toBe('error');
    expect(bookingTone('REFUNDED')).toBe('error');
  });

  it('is case-insensitive, since the tone must not depend on API casing', () => {
    expect(bookingTone('pending_payment')).toBe('warning');
    expect(bookingTone('confirmed')).toBe('success');
  });

  it('falls back to neutral for a status from a newer API', () => {
    expect(bookingTone('PARTIALLY_REFUNDED_PENDING_REVIEW')).toBe('neutral');
  });
});

describe('isLiveBooking', () => {
  it('excludes bookings the customer no longer holds', () => {
    // REGRESSION: two EXPIRED holds for future dates sat in the Upcoming tab on a real QA
    // account and were counted in its badge, so it read "Upcoming (3)" against exactly
    // one real ticket.
    expect(isLiveBooking('EXPIRED')).toBe(false);
    expect(isLiveBooking('CANCELLED')).toBe(false);
    expect(isLiveBooking('FAILED')).toBe(false);
  });

  it('keeps everything the customer might still use', () => {
    expect(isLiveBooking('CONFIRMED')).toBe(true);
    expect(isLiveBooking('PENDING_PAYMENT')).toBe(true);
    expect(isLiveBooking('COMPLETED')).toBe(true);
  });

  it('keeps REFUNDED, which is a real ticket that was paid for', () => {
    // A refunded booking is history rather than a dead hold, and the session-time split
    // already files it under Past. Hiding it from both tabs would lose the receipt.
    expect(isLiveBooking('REFUNDED')).toBe(true);
  });

  it('treats an unrecognised status as live rather than hiding it', () => {
    // Matched by exclusion on purpose: a status from a newer API must not silently vanish
    // from both tabs, which is what an allow-list would do.
    expect(isLiveBooking('SOME_FUTURE_STATE')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isLiveBooking('expired')).toBe(false);
  });
});

/**
 * The partition itself, as the list computes it. Upcoming keeps live future bookings;
 * Past must be its exact COMPLEMENT, or a lapsed hold for a future date would be filtered
 * out of Upcoming by status and out of Past by time, and become unreachable in the UI.
 */
describe('upcoming/past partition', () => {
  const now = Date.parse('2026-08-07T12:00:00Z');
  const rows = [
    { id: 'future-confirmed', startsAt: '2026-08-13T14:00:00Z', status: 'CONFIRMED' },
    { id: 'future-expired', startsAt: '2026-08-13T14:00:00Z', status: 'EXPIRED' },
    { id: 'future-pending', startsAt: '2026-08-15T14:00:00Z', status: 'PENDING_PAYMENT' },
    { id: 'past-confirmed', startsAt: '2026-08-01T14:00:00Z', status: 'CONFIRMED' },
  ];

  const isUpcoming = (r: (typeof rows)[number]) =>
    Date.parse(r.startsAt) >= now && isLiveBooking(r.status);

  const upcoming = rows.filter(isUpcoming).map((r) => r.id);
  const past = rows.filter((r) => !isUpcoming(r)).map((r) => r.id);

  it('counts only live future bookings as upcoming', () => {
    expect(upcoming).toEqual(['future-confirmed', 'future-pending']);
  });

  it('files a lapsed future hold under past instead of dropping it', () => {
    expect(past).toContain('future-expired');
  });

  it('loses nothing: every booking lands in exactly one tab', () => {
    expect([...upcoming, ...past].sort()).toEqual(rows.map((r) => r.id).sort());
    expect(upcoming.filter((id) => past.includes(id))).toEqual([]);
  });
});
