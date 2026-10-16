import { describe, expect, it } from 'vitest';
import {
  bookingStatusLabel,
  bookingStatusTone,
  cashPaymentLabel,
  narrowingOptions,
} from './booking-status';

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

describe('cashPaymentLabel', () => {
  it('names a counter sale instead of "-"', () => {
    expect(
      cashPaymentLabel({ paymentMethod: 'CASH', status: 'CONFIRMED', cashCollected: true }),
    ).toBe('Cash at the counter');
  });
  it('says whether the cash of a cancelled booking went back', () => {
    const base = { paymentMethod: 'CASH', status: 'CANCELLED', cashCollected: true };
    expect(cashPaymentLabel({ ...base, cashReturned: false })).toBe('Cash to give back');
    expect(cashPaymentLabel({ ...base, cashReturned: true })).toBe('Cash given back');
  });
  it('says an online reservation is still to be paid at the counter', () => {
    expect(cashPaymentLabel({ paymentMethod: 'CASH', status: 'PENDING_PAYMENT' })).toBe(
      'Cash, to pay at the counter',
    );
  });
  it('leaves an online booking to its payment status', () => {
    expect(cashPaymentLabel({ paymentMethod: 'ONLINE', status: 'CONFIRMED' })).toBeNull();
    expect(cashPaymentLabel({ status: 'CONFIRMED' })).toBeNull();
  });
});
