import { bookingAdmits } from './booking-admission';

describe('bookingAdmits', () => {
  it.each(['CONFIRMED', 'PARTIALLY_REFUNDED', 'DISPUTED'])('admits a %s booking', (status) => {
    expect(bookingAdmits(status)).toBe(true);
  });

  it.each(['REFUNDED', 'CANCELLED', 'EXPIRED', 'PENDING_PAYMENT'])(
    'refuses a %s booking',
    (status) => {
      expect(bookingAdmits(status)).toBe(false);
    },
  );

  it('refuses when the status is missing (fail closed)', () => {
    expect(bookingAdmits(undefined)).toBe(false);
    expect(bookingAdmits(null)).toBe(false);
  });
});
