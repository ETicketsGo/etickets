import { FeeMode } from '@eticketsgo/shared-types';
import { calculateFees, feeForTier, feeTierFromRule, type FeeTier } from './fee-calculator';

/**
 * Booking-fee bands that charge a percentage as well as a fixed amount.
 *
 * The owner's words: "100 INR to 200 INR would like to collect 10 rs of booking fee but above
 * 5000 rs should be able to select 5%", with limits, for every country. Bands are still ranges
 * of the order amount; each one now says HOW it charges.
 */
describe('percentage booking-fee bands', () => {
  // The owner's schedule, in paise. Between Rs 200 and Rs 5,000 a fixed Rs 20, to close the gap.
  const schedule: FeeTier[] = [
    { minMinor: 10_000, maxMinor: 20_000, feeMinor: 1_000 }, // Rs 100 - 200 -> Rs 10
    { minMinor: 20_001, maxMinor: 500_000, feeMinor: 2_000 }, // Rs 200 - 5,000 -> Rs 20
    { minMinor: 500_001, maxMinor: null, feeMinor: 0, type: 'PERCENT', percentBps: 500 }, // 5%
  ];
  const fee = (subtotalMinor: number, tiers = schedule) =>
    calculateFees({ subtotalMinor, feeMode: FeeMode.CUSTOMER_PAYS, tiers, paymentFeeBps: 0 })
      .bookingFeeMinor;

  it('charges the fixed amount inside a fixed band', () => {
    expect(fee(15_000)).toBe(1_000); // Rs 150 -> Rs 10
  });

  it('charges 5% of the order above Rs 5,000', () => {
    expect(fee(600_000)).toBe(30_000); // Rs 6,000 -> Rs 300
    expect(fee(1_000_000)).toBe(50_000); // Rs 10,000 -> Rs 500
  });

  it('takes the percentage of the amount after any discount, like every other fee', () => {
    const result = calculateFees({
      subtotalMinor: 700_000,
      discountMinor: 100_000,
      feeMode: FeeMode.CUSTOMER_PAYS,
      tiers: schedule,
      paymentFeeBps: 0,
    });
    expect(result.netSubtotalMinor).toBe(600_000);
    expect(result.bookingFeeMinor).toBe(30_000); // 5% of Rs 6,000, not of Rs 7,000
  });

  it('rounds to the nearest minor unit, once, on the whole order', () => {
    // 2.5% of Rs 123.45 is Rs 3.08625 -> 309 paise.
    expect(
      feeForTier(
        { minMinor: 0, maxMinor: null, feeMinor: 0, type: 'PERCENT', percentBps: 250 },
        12_345,
      ),
    ).toBe(309);
  });

  describe('limits', () => {
    const capped: FeeTier = {
      minMinor: 0,
      maxMinor: null,
      feeMinor: 0,
      type: 'PERCENT',
      percentBps: 500,
      minFeeMinor: 2_000, // at least Rs 20
      maxFeeMinor: 50_000, // at most Rs 500
    };

    it('never charges less than the floor', () => {
      expect(feeForTier(capped, 10_000)).toBe(2_000); // 5% of Rs 100 is Rs 5 -> Rs 20
    });

    it('never charges more than the ceiling', () => {
      expect(feeForTier(capped, 5_000_000)).toBe(50_000); // 5% of Rs 50,000 is Rs 2,500 -> Rs 500
    });

    it('charges the plain percentage between them', () => {
      expect(feeForTier(capped, 600_000)).toBe(30_000);
    });

    it('holds to the ceiling even if a floor was set above it', () => {
      // The admin API refuses this; the calculator still never exceeds what was promised as a maximum.
      expect(feeForTier({ ...capped, minFeeMinor: 60_000, maxFeeMinor: 50_000 }, 100_000)).toBe(
        50_000,
      );
    });
  });

  describe('nothing that already works changes', () => {
    it('a band with no type is a fixed-amount band, exactly as before', () => {
      expect(feeForTier({ minMinor: 0, maxMinor: null, feeMinor: 1_500 }, 999_999)).toBe(1_500);
    });

    it('the built-in schedule still charges what it always charged', () => {
      const builtIn = (subtotalMinor: number) =>
        calculateFees({ subtotalMinor, feeMode: FeeMode.CUSTOMER_PAYS, paymentFeeBps: 0 })
          .bookingFeeMinor;
      expect([builtIn(10_000), builtIn(30_000), builtIn(60_000), builtIn(500_000)]).toEqual([
        500, 1_000, 1_500, 2_000,
      ]);
    });

    it('a free order still pays no fee, whatever the band says', () => {
      expect(fee(0)).toBe(0);
    });

    it('who pays the fee is unchanged: organizer-pays keeps it off the customer', () => {
      const result = calculateFees({
        subtotalMinor: 600_000,
        feeMode: FeeMode.ORGANIZER_PAYS,
        tiers: schedule,
        paymentFeeBps: 0,
      });
      expect(result.organizerFeeMinor).toBe(30_000);
      expect(result.customerFeeMinor).toBe(0);
      expect(result.totalMinor).toBe(600_000);
    });
  });

  it('works in any currency, because it is a share of minor units', () => {
    // $150.00 at 4% with a $2 floor: 4% is $6.00.
    const usd = calculateFees({
      subtotalMinor: 15_000,
      feeMode: FeeMode.CUSTOMER_PAYS,
      currency: 'USD',
      paymentFeeBps: 0,
      tiers: [
        {
          minMinor: 0,
          maxMinor: null,
          feeMinor: 0,
          type: 'PERCENT',
          percentBps: 400,
          minFeeMinor: 200,
        },
      ],
    });
    expect(usd.currency).toBe('USD');
    expect(usd.bookingFeeMinor).toBe(600);
  });

  describe('feeTierFromRule', () => {
    it('reads a stored PERCENT row as a percentage band', () => {
      expect(
        feeTierFromRule({
          minMinor: 500_001,
          maxMinor: null,
          feeMinor: 0,
          feeType: 'PERCENT',
          feePercentBps: 500,
          minFeeMinor: null,
          maxFeeMinor: 50_000,
        }),
      ).toEqual({
        minMinor: 500_001,
        maxMinor: null,
        feeMinor: 0,
        type: 'PERCENT',
        percentBps: 500,
        minFeeMinor: null,
        maxFeeMinor: 50_000,
      });
    });

    it('reads a row written before percentages existed as FLAT', () => {
      expect(feeTierFromRule({ minMinor: 0, maxMinor: 19_900, feeMinor: 500 }).type).toBe('FLAT');
    });
  });
});
