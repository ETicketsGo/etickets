import { MODULE_METADATA } from '@nestjs/common/constants';
import { loadConfig } from '../config/configuration';
import { BookingsModule } from './bookings.module';
import {
  BookingHoldLimitsService,
  DEFAULT_HOLD_LIMITS,
  aggregateTicketQuantities,
  assertOrderSize,
  holdLimitsFrom,
} from './booking-hold-limits';
import { bookingIdempotency } from './booking-idempotency';

/**
 * The configuration and wiring the hold limits depend on. The behaviour under load is in
 * booking-hold-abuse.spec.ts and, against a real database, the integration-postgres spec.
 */
describe('hold limit configuration', () => {
  const ORIGINAL = process.env;
  const STRONG = 'a'.repeat(40);
  const LOCAL = {
    DATABASE_URL: 'postgres://u:p@db/x',
    JWT_ACCESS_SECRET: STRONG,
    JWT_REFRESH_SECRET: STRONG,
    QR_SIGNING_SECRET: STRONG,
    PAYMENT_WEBHOOK_SECRET: STRONG,
  };
  afterEach(() => {
    process.env = ORIGINAL;
  });

  it('boots with the documented defaults', () => {
    process.env = { ...LOCAL };
    const cfg = loadConfig();
    expect({
      seatsPerOrder: cfg.BOOKING_MAX_SEATS_PER_ORDER,
      perUser: cfg.BOOKING_MAX_ACTIVE_HOLDS_PER_USER,
      perEmail: cfg.BOOKING_MAX_ACTIVE_HOLDS_PER_EMAIL,
      perIp: cfg.BOOKING_MAX_ACTIVE_HOLDS_PER_IP,
      cashPerShow: cfg.BOOKING_MAX_CASH_RESERVATIONS_PER_SHOW,
      cashTotal: cfg.BOOKING_MAX_CASH_RESERVATIONS_TOTAL,
      cashSeats: cfg.BOOKING_MAX_SEATS_PER_CASH_RESERVATION,
    }).toEqual(DEFAULT_HOLD_LIMITS);
    // The hold window itself is untouched by any of this.
    expect(cfg.BOOKING_HOLD_MINUTES).toBe(10);
  });

  it('refuses a value that is not a whole number at boot', () => {
    process.env = { ...LOCAL, BOOKING_MAX_ACTIVE_HOLDS_PER_IP: 'lots' };
    expect(() => loadConfig()).toThrow(/BOOKING_MAX_ACTIVE_HOLDS_PER_IP/);
  });

  it('reads overrides, and falls back to the default (never to "no limit") on junk', () => {
    const get = (values: Record<string, unknown>) => ({ get: (k: string) => values[k] });
    expect(holdLimitsFrom(get({ BOOKING_MAX_ACTIVE_HOLDS_PER_IP: 50 })).perIp).toBe(50);
    expect(holdLimitsFrom(get({ BOOKING_MAX_ACTIVE_HOLDS_PER_IP: '7' })).perIp).toBe(7);
    expect(holdLimitsFrom(get({ BOOKING_MAX_ACTIVE_HOLDS_PER_USER: -1 })).perUser).toBe(3);
    expect(holdLimitsFrom(get({ BOOKING_MAX_ACTIVE_HOLDS_PER_USER: 'x' })).perUser).toBe(3);
    expect(holdLimitsFrom(null)).toEqual(DEFAULT_HOLD_LIMITS);
  });

  it('is provided by BookingsModule, which is what makes the limits real', () => {
    // BookingsService takes it as optional only for hand-built test harnesses.
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, BookingsModule) as unknown[];
    expect(providers).toContain(BookingHoldLimitsService);
  });
});

describe('order size', () => {
  it('adds up repeated lines of one ticket type', () => {
    const totals = aggregateTicketQuantities([
      { ticketTypeId: 'a', quantity: 6 },
      { ticketTypeId: 'b', quantity: 1 },
      { ticketTypeId: 'a', quantity: 6 },
    ]);
    expect(totals.get('a')).toBe(12);
    expect(totals.get('b')).toBe(1);
  });

  it('leaves counter sales and a switched-off ceiling alone', () => {
    expect(() =>
      assertOrderSize(500, DEFAULT_HOLD_LIMITS, { counterSale: true, wantsCash: true }),
    ).not.toThrow();
    expect(() =>
      assertOrderSize(500, { ...DEFAULT_HOLD_LIMITS, seatsPerOrder: 0 }, { wantsCash: false }),
    ).not.toThrow();
    expect(() => assertOrderSize(21, DEFAULT_HOLD_LIMITS, { wantsCash: false })).toThrow(
      /at most 20 tickets/,
    );
    expect(() => assertOrderSize(20, DEFAULT_HOLD_LIMITS, { wantsCash: false })).not.toThrow();
  });
});

describe('idempotency scope', () => {
  const base = { rawKey: 'k-1', userId: 'u-1', buyerEmail: 'a@t.test', body: { x: 1 } };

  it('is per actor and per body, and does not depend on key order in the body', () => {
    const mine = bookingIdempotency(base);
    expect(bookingIdempotency({ ...base, userId: 'u-2' }).key).not.toBe(mine.key);
    expect(bookingIdempotency({ ...base, body: { x: 2 } }).requestHash).not.toBe(mine.requestHash);
    expect(
      bookingIdempotency({ ...base, body: { a: 1, b: [1, { c: 2, d: 3 }] } }).requestHash,
    ).toBe(bookingIdempotency({ ...base, body: { b: [1, { d: 3, c: 2 }], a: 1 } }).requestHash);
    // A guest is scoped by the address on the order, however it is capitalised.
    const guest = { ...base, userId: null };
    expect(bookingIdempotency({ ...guest, buyerEmail: 'A@T.test' }).key).toBe(
      bookingIdempotency(guest).key,
    );
    expect(bookingIdempotency({ ...guest, buyerEmail: 'b@t.test' }).key).not.toBe(
      bookingIdempotency(guest).key,
    );
  });

  it('refuses an unreasonably long key', () => {
    expect(() => bookingIdempotency({ ...base, rawKey: 'x'.repeat(201) })).toThrow(
      /at most 200 characters/,
    );
  });
});
