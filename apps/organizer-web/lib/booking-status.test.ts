import { describe, expect, it } from 'vitest';
import { bookingStatusLabel, bookingStatusTone, narrowingOptions } from './booking-status';

describe('booking status for the counter', () => {
  it('names the state in words and colours it by what the desk can do', () => {
    expect(bookingStatusLabel('PENDING_PAYMENT')).toBe('Awaiting payment');
    expect(bookingStatusTone('CONFIRMED')).toBe('success');
    expect(bookingStatusTone('CANCELLED')).toBe('error');
    // A refund is the normal end of a sale, not an error.
    expect(bookingStatusTone('REFUNDED')).toBe('info');
  });

  it('keeps a state it does not know legible and neutral', () => {
    expect(bookingStatusLabel('HELD_AT_DOOR')).toBe('Held at door');
    expect(bookingStatusTone('HELD_AT_DOOR')).toBe('neutral');
  });
});

describe('narrowingOptions', () => {
  it('offers only what is in the results, with how many each would leave', () => {
    const rows = [{ s: 'CONFIRMED' }, { s: 'EXPIRED' }, { s: 'CONFIRMED' }];
    expect(narrowingOptions(rows, (r) => r.s, bookingStatusLabel)).toEqual([
      { value: 'CONFIRMED', label: 'Confirmed', count: 2 },
      { value: 'EXPIRED', label: 'Expired', count: 1 },
    ]);
  });
});
