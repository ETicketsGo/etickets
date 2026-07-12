import { FeeMode } from '@eticketsgo/shared-types';
import { calculateFees, DEFAULT_FEE_TIERS } from './fee-calculator';

describe('calculateFees', () => {
  it('applies the correct India tier for a low-value order', () => {
    const r = calculateFees({ subtotalMinor: 15_000, feeMode: FeeMode.CUSTOMER_PAYS });
    expect(r.bookingFeeMinor).toBe(500); // ₹5
  });

  it('applies the ₹20 cap for high-value orders', () => {
    const r = calculateFees({ subtotalMinor: 500_000, feeMode: FeeMode.CUSTOMER_PAYS });
    expect(r.bookingFeeMinor).toBe(2_000); // ₹20 max
  });

  it('CUSTOMER_PAYS charges subtotal plus all fees', () => {
    const r = calculateFees({ subtotalMinor: 100_000, feeMode: FeeMode.CUSTOMER_PAYS });
    // booking fee ₹20 = 2000; payment fee 2% of (100000+2000)=2040
    expect(r.bookingFeeMinor).toBe(2_000);
    expect(r.paymentFeeMinor).toBe(2_040);
    expect(r.customerFeeMinor).toBe(4_040);
    expect(r.organizerFeeMinor).toBe(0);
    expect(r.totalMinor).toBe(104_040);
  });

  it('ORGANIZER_PAYS keeps the customer total at the net subtotal', () => {
    const r = calculateFees({ subtotalMinor: 100_000, feeMode: FeeMode.ORGANIZER_PAYS });
    expect(r.totalMinor).toBe(100_000);
    expect(r.organizerFeeMinor).toBe(4_040);
    expect(r.customerFeeMinor).toBe(0);
  });

  it('SHARED splits fees with no rounding leak', () => {
    const r = calculateFees({ subtotalMinor: 100_000, feeMode: FeeMode.SHARED });
    expect(r.customerFeeMinor + r.organizerFeeMinor).toBe(r.bookingFeeMinor + r.paymentFeeMinor);
    expect(r.customerFeeMinor).toBeGreaterThanOrEqual(r.organizerFeeMinor);
  });

  it('applies discount before computing the fee tier', () => {
    const r = calculateFees({
      subtotalMinor: 60_000,
      discountMinor: 45_000,
      feeMode: FeeMode.CUSTOMER_PAYS,
    });
    expect(r.netSubtotalMinor).toBe(15_000);
    expect(r.bookingFeeMinor).toBe(500); // dropped into the ₹5 tier
  });

  it('charges no fees on a fully discounted order', () => {
    const r = calculateFees({
      subtotalMinor: 50_000,
      discountMinor: 50_000,
      feeMode: FeeMode.CUSTOMER_PAYS,
    });
    expect(r.bookingFeeMinor).toBe(0);
    expect(r.paymentFeeMinor).toBe(0);
    expect(r.totalMinor).toBe(0);
  });

  it('covers every default tier boundary', () => {
    expect(DEFAULT_FEE_TIERS).toHaveLength(4);
    expect(
      calculateFees({ subtotalMinor: 19_900, feeMode: FeeMode.CUSTOMER_PAYS }).bookingFeeMinor,
    ).toBe(500);
    expect(
      calculateFees({ subtotalMinor: 20_000, feeMode: FeeMode.CUSTOMER_PAYS }).bookingFeeMinor,
    ).toBe(1_000);
    expect(
      calculateFees({ subtotalMinor: 49_900, feeMode: FeeMode.CUSTOMER_PAYS }).bookingFeeMinor,
    ).toBe(1_000);
    expect(
      calculateFees({ subtotalMinor: 50_000, feeMode: FeeMode.CUSTOMER_PAYS }).bookingFeeMinor,
    ).toBe(1_500);
    expect(
      calculateFees({ subtotalMinor: 99_900, feeMode: FeeMode.CUSTOMER_PAYS }).bookingFeeMinor,
    ).toBe(1_500);
    expect(
      calculateFees({ subtotalMinor: 100_000, feeMode: FeeMode.CUSTOMER_PAYS }).bookingFeeMinor,
    ).toBe(2_000);
  });
});
