import {
  allocateCurrencySettlement,
  allocatedNet,
  type AllocationBookingRow,
  type AllocationRefundRow,
} from './payout-allocation';
import { calculateCurrencySettlement } from './currency-settlement.calculator';

/**
 * The one claim that makes allocations trustworthy:
 *
 *   for every currency, SUM(allocatedNetMinor) === CurrencySettlement.net
 *
 * Both sides are computed from the SAME rows by the real functions. Neither arithmetic is
 * reimplemented here - a test that recomputed the expected net would only prove this file agrees
 * with itself.
 */

const settlementFor = (
  bookings: readonly AllocationBookingRow[],
  refunds: readonly AllocationRefundRow[],
) =>
  calculateCurrencySettlement({
    revenue: bookings.map((b) => ({
      currency: b.currency,
      subtotalMinor: b.subtotalMinor,
      discountMinor: b.discountMinor,
      bookingFeeMinor: b.bookingFeeMinor,
      paymentFeeMinor: b.paymentFeeMinor,
      organizerFeeMinor: b.organizerFeeMinor,
    })),
    refunds: refunds.map((r) => ({
      currency: r.currency,
      amountMinor: r.amountMinor,
      taxAddedMinor: r.taxAddedMinor,
    })),
  });

/** Asserts the invariant for every currency on either side, and that neither invents one. */
const expectAgreement = (
  bookings: readonly AllocationBookingRow[],
  refunds: readonly AllocationRefundRow[],
) => {
  const settlements = settlementFor(bookings, refunds);
  const allocations = allocateCurrencySettlement({ bookings, refunds });

  // Neither side may contain a currency the other does not, or a payout would be written with
  // no allocations, or allocations stranded under no payout.
  expect([...allocations.keys()].sort()).toEqual(settlements.map((s) => s.currency).sort());

  for (const settlement of settlements) {
    const drafts = allocations.get(settlement.currency) ?? [];
    // Compared as a labelled string so a failure names the currency rather than "2 !== 3".
    expect(`${settlement.currency} net=${allocatedNet(drafts)}`).toBe(
      `${settlement.currency} net=${settlement.net}`,
    );
  }
  return { settlements, allocations };
};

const booking = (over: Partial<AllocationBookingRow> & { id: string }): AllocationBookingRow => ({
  eventId: 'ev',
  currency: 'INR',
  subtotalMinor: 0,
  discountMinor: 0,
  bookingFeeMinor: 0,
  paymentFeeMinor: 0,
  organizerFeeMinor: 0,
  ...over,
});

describe('allocateCurrencySettlement', () => {
  it('splits a payout into contributions that add back to its net', () => {
    const bookings = [
      booking({
        id: 'b1',
        subtotalMinor: 150_000,
        discountMinor: 10_000,
        organizerFeeMinor: 7_500,
      }),
      booking({ id: 'b2', subtotalMinor: 99_999, organizerFeeMinor: 4_999 }),
    ];
    const { allocations } = expectAgreement(bookings, []);
    expect(allocations.get('INR')).toHaveLength(2);
  });

  it('mirrors the calculator term for term, fees excluded', () => {
    const bookings = [
      booking({
        id: 'b1',
        subtotalMinor: 12_000,
        discountMinor: 1_000,
        organizerFeeMinor: 1_000,
        // Large enough that deducting either would be unmistakable in the total.
        bookingFeeMinor: 5_000,
        paymentFeeMinor: 4_000,
      }),
    ];
    const { allocations } = expectAgreement(bookings, []);
    const draft = allocations.get('INR')![0];
    expect(draft.allocatedNetMinor).toBe(10_000);
    // Carried for reporting, absent from the equation.
    expect(draft.bookingFeeMinor).toBe(5_000);
    expect(draft.paymentFeeMinor).toBe(4_000);
  });

  it('attributes a refund to the booking it returns', () => {
    const bookings = [booking({ id: 'b1', subtotalMinor: 50_000, organizerFeeMinor: 2_500 })];
    const refunds: AllocationRefundRow[] = [
      { bookingId: 'b1', eventId: 'ev', currency: 'INR', amountMinor: 10_000, taxAddedMinor: 0 },
    ];
    const { allocations } = expectAgreement(bookings, refunds);
    const draft = allocations.get('INR')![0];
    expect(draft.refundShareMinor).toBe(10_000);
    expect(draft.allocatedNetMinor).toBe(50_000 - 2_500 - 10_000);
  });

  it('keeps the platform tax out of the organizer share, as the calculator does', () => {
    const bookings = [booking({ id: 'b1', subtotalMinor: 50_000, currency: 'USD' })];
    const refunds: AllocationRefundRow[] = [
      // Tax ADDED on top was the platform's to remit; charging it back takes money the
      // organizer never received.
      { bookingId: 'b1', eventId: 'ev', currency: 'USD', amountMinor: 10_000, taxAddedMinor: 800 },
    ];
    const { allocations } = expectAgreement(bookings, refunds);
    expect(allocations.get('USD')![0].refundShareMinor).toBe(9_200);
  });

  it('clamps a refund recorded as more tax than money, rather than paying it out', () => {
    const bookings = [booking({ id: 'b1', subtotalMinor: 50_000, currency: 'USD' })];
    const refunds: AllocationRefundRow[] = [
      { bookingId: 'b1', eventId: 'ev', currency: 'USD', amountMinor: 1_000, taxAddedMinor: 9_000 },
    ];
    const { allocations } = expectAgreement(bookings, refunds);
    // Not -8000: a negative share would ADD to the organizer's proceeds.
    expect(allocations.get('USD')![0].refundShareMinor).toBe(0);
  });

  describe('a refund outside this payout revenue window', () => {
    it('still gets an allocation, as a pure clawback', () => {
      /*
        Revenue is selected on booking.confirmedAt and refunds on refund.updatedAt, so this is
        an ordinary case, not an edge one. If the clawback were dropped the allocation sum would
        exceed netMinor and the payout would be refused.
      */
      const refunds: AllocationRefundRow[] = [
        { bookingId: 'old', eventId: 'ev9', currency: 'INR', amountMinor: 6_000, taxAddedMinor: 0 },
      ];
      const { allocations } = expectAgreement([], refunds);
      const draft = allocations.get('INR')![0];
      expect(draft.subtotalMinor).toBe(0);
      expect(draft.allocatedNetMinor).toBe(-6_000);
      expect(draft.eventId).toBe('ev9');
    });

    it('produces a negative net when refunds exceed the revenue present', () => {
      const bookings = [booking({ id: 'b1', subtotalMinor: 1_000 })];
      const refunds: AllocationRefundRow[] = [
        { bookingId: 'b1', eventId: 'ev', currency: 'INR', amountMinor: 6_000, taxAddedMinor: 0 },
      ];
      const { settlements } = expectAgreement(bookings, refunds);
      // A clawback nobody recorded is a clawback nobody collects.
      expect(settlements[0].net).toBe(-5_000);
    });
  });

  it('adds several refunds against one booking into one allocation', () => {
    const bookings = [booking({ id: 'b1', subtotalMinor: 50_000 })];
    const refunds: AllocationRefundRow[] = [
      { bookingId: 'b1', eventId: 'ev', currency: 'INR', amountMinor: 1_000, taxAddedMinor: 0 },
      { bookingId: 'b1', eventId: 'ev', currency: 'INR', amountMinor: 2_000, taxAddedMinor: 0 },
    ];
    const { allocations } = expectAgreement(bookings, refunds);
    // One row per booking per payout - the unique key would refuse two.
    expect(allocations.get('INR')).toHaveLength(1);
    expect(allocations.get('INR')![0].refundShareMinor).toBe(3_000);
  });

  it('folds currency case the same way the calculator does', () => {
    const bookings = [
      booking({ id: 'b1', currency: 'inr', subtotalMinor: 1_000 }),
      booking({ id: 'b2', currency: 'INR', subtotalMinor: 2_000 }),
    ];
    const { allocations } = expectAgreement(bookings, []);
    // Two rows, one currency: allocations stranded under lowercase would belong to no payout.
    expect([...allocations.keys()]).toEqual(['INR']);
    expect(allocations.get('INR')).toHaveLength(2);
    expect(allocations.get('INR')!.every((d) => d.currency === 'INR')).toBe(true);
  });

  it('never mixes currencies within one allocation set', () => {
    const bookings = [
      booking({ id: 'b1', currency: 'INR', subtotalMinor: 1_000 }),
      booking({ id: 'b2', currency: 'USD', subtotalMinor: 2_000 }),
      booking({ id: 'b3', currency: 'CAD', subtotalMinor: 3_000 }),
    ];
    const { allocations } = expectAgreement(bookings, []);
    for (const [currency, drafts] of allocations) {
      expect(drafts.every((d) => d.currency === currency)).toBe(true);
    }
  });

  it('refuses a booking passed twice rather than double-counting it', () => {
    const twice = [booking({ id: 'b1', subtotalMinor: 1_000 }), booking({ id: 'b1' })];
    expect(() => allocateCurrencySettlement({ bookings: twice, refunds: [] })).toThrow(
      /appeared twice/,
    );
  });

  it('holds over randomly generated populations', () => {
    /*
      The invariant is meant to hold for inputs nobody chose. Seeded so a failure is reproducible
      from the printed case rather than appearing once and vanishing.
    */
    let seed = 20261002;
    const rand = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    const currencies = ['INR', 'usd', 'CAD', 'inr'];

    for (let trial = 0; trial < 300; trial += 1) {
      const bookings: AllocationBookingRow[] = [];
      const bookingCount = rand(9);
      for (let i = 0; i < bookingCount; i += 1) {
        bookings.push(
          booking({
            id: `t${trial}-b${i}`,
            eventId: `ev${rand(3)}`,
            currency: currencies[rand(currencies.length)],
            subtotalMinor: rand(200_000),
            // Deliberately unconstrained: a discount larger than its own subtotal is a real
            // data state and must not break the equality.
            discountMinor: rand(60_000),
            organizerFeeMinor: rand(20_000),
            bookingFeeMinor: rand(5_000),
            paymentFeeMinor: rand(5_000),
          }),
        );
      }
      const refunds: AllocationRefundRow[] = [];
      const refundCount = rand(6);
      for (let i = 0; i < refundCount; i += 1) {
        // Some against a booking present, some against one that is not.
        const target =
          bookings.length > 0 && rand(2) === 0 ? bookings[rand(bookings.length)] : null;
        refunds.push({
          bookingId: target ? target.id : `t${trial}-absent${i}`,
          eventId: target ? target.eventId : `ev${rand(3)}`,
          currency: target ? target.currency : currencies[rand(currencies.length)],
          amountMinor: rand(80_000),
          taxAddedMinor: rand(2) === 0 ? rand(9_000) : null,
        });
      }

      try {
        expectAgreement(bookings, refunds);
      } catch (error) {
        throw new Error(
          `trial ${trial} failed: ${(error as Error).message}\n` +
            `bookings=${JSON.stringify(bookings)}\nrefunds=${JSON.stringify(refunds)}`,
        );
      }
    }
  });
});
