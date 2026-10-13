import { describe, expect, it } from 'vitest';
import { isCurrentBooking, splitBookings } from './booking-list';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const row = (status: string, startsAt: string) => ({ status, eventSession: { startsAt } });

describe('which bookings the list opens with', () => {
  it('keeps a paid booking for a show still to come', () => {
    expect(isCurrentBooking(row('CONFIRMED', '2026-10-20T12:00:00Z'), NOW)).toBe(true);
  });

  it('keeps a show that started a little while ago (a film is still running)', () => {
    expect(isCurrentBooking(row('CONFIRMED', '2026-10-13T09:00:00Z'), NOW)).toBe(true);
  });

  it('moves a show that ended days ago to the past list', () => {
    expect(isCurrentBooking(row('CONFIRMED', '2026-10-01T12:00:00Z'), NOW)).toBe(false);
  });

  it('moves every expired hold, cancelled and refunded booking, whatever its date', () => {
    for (const status of ['EXPIRED', 'CANCELLED', 'REFUNDED']) {
      expect(isCurrentBooking(row(status, '2026-12-01T12:00:00Z'), NOW)).toBe(false);
    }
  });

  it('keeps an unpaid booking whose hold is live and a disputed one', () => {
    expect(isCurrentBooking(row('PENDING_PAYMENT', '2026-10-20T12:00:00Z'), NOW)).toBe(true);
    expect(isCurrentBooking(row('DISPUTED', '2026-10-20T12:00:00Z'), NOW)).toBe(true);
  });

  it('never loses a row: current plus past is the whole list, in order', () => {
    const rows = [
      row('CONFIRMED', '2026-10-20T12:00:00Z'),
      row('EXPIRED', '2026-10-20T12:00:00Z'),
      row('CONFIRMED', '2026-09-01T12:00:00Z'),
      row('PENDING_PAYMENT', '2026-11-01T12:00:00Z'),
    ];
    const { current, past } = splitBookings(rows, NOW);
    expect(current).toEqual([rows[0], rows[3]]);
    expect(past).toEqual([rows[1], rows[2]]);
    expect(current.length + past.length).toBe(rows.length);
  });

  it('shows a row whose date cannot be read', () => {
    expect(isCurrentBooking(row('CONFIRMED', 'not a date'), NOW)).toBe(true);
  });
});
