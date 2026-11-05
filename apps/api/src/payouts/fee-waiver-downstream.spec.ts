import { FeeMode, computeMarketplaceSplit } from '@eticketsgo/shared-types';
import { DEFAULT_FEE_TIERS } from '../pricing/fee-calculator';
import {
  appliedFeePolicy,
  calculateFeesWithPolicy,
  type FeePolicyRow,
} from '../pricing/fee-policy';
import { allocateCurrencySettlement, allocatedNet } from './payout-allocation';
import {
  calculateCurrencySettlement,
  organizerShareOfRefund,
} from './currency-settlement.calculator';
import { platformFinanceEntry } from '../finance/platform-finance.producer';

/**
 * A waived booking, through everything downstream of the money.
 *
 * Settlement, payouts, payout allocations, the platform finance producer and the marketplace
 * split all read the booking's SNAPSHOT columns, and a waiver writes the charged amounts into
 * exactly those columns (bookingFeeMinor 0, the payment fee as charged). So nothing downstream
 * needed to change - and these tests are what prove that, with real figures from the real
 * calculator rather than hand-written ones.
 */

const WAIVE: FeePolicyRow = {
  id: 'p-waive',
  scope: 'ORGANIZATION',
  eventId: null,
  organizationId: 'org',
  kind: 'WAIVE',
  currency: null,
  startsAt: new Date(0),
  endsAt: null,
  maxOrders: null,
  usedOrders: 0,
  status: 'ACTIVE',
  version: 1,
};

/** A booking row priced by the real calculator, waived or not. */
function booking(id: string, feeMode: FeeMode, waived: boolean, subtotalMinor = 50_000) {
  const { fees } = calculateFeesWithPolicy({
    subtotalMinor,
    feeMode,
    currency: 'INR',
    baseTiers: DEFAULT_FEE_TIERS,
    policy: waived ? { ...WAIVE, applied: appliedFeePolicy(WAIVE) } : null,
  });
  return {
    id,
    eventId: 'ev',
    currency: 'INR',
    subtotalMinor: fees.subtotalMinor,
    discountMinor: fees.discountMinor,
    bookingFeeMinor: fees.bookingFeeMinor,
    paymentFeeMinor: fees.paymentFeeMinor,
    organizerFeeMinor: fees.organizerFeeMinor,
    customerFeeMinor: fees.customerFeeMinor,
    taxMinor: fees.taxMinor,
    totalMinor: fees.totalMinor,
  };
}

function payoutFor(
  rows: ReturnType<typeof booking>[],
  refunds: { bookingId: string; amountMinor: number; platformFeeRefundedMinor?: number }[] = [],
) {
  const refundRows = refunds.map((r) => ({
    bookingId: r.bookingId,
    eventId: 'ev',
    currency: 'INR',
    amountMinor: r.amountMinor,
    taxAddedMinor: 0,
    platformFeeRefundedMinor: r.platformFeeRefundedMinor ?? 0,
  }));
  const [settlement] = calculateCurrencySettlement({ revenue: rows, refunds: refundRows });
  const drafts = allocateCurrencySettlement({ bookings: rows, refunds: refundRows }).get('INR')!;
  const payout = {
    id: 'po',
    organizationId: 'org',
    eventId: 'ev',
    currency: 'INR',
    status: 'PENDING',
    periodStart: null,
    periodEnd: null,
    grossMinor: settlement!.gross,
    bookingFeeMinor: settlement!.bookingFee,
    paymentFeeMinor: settlement!.paymentFee,
    refundMinor: settlement!.refund,
    netMinor: settlement!.net,
    allocatedFrom: new Date(),
  };
  return { settlement: settlement!, drafts, finance: platformFinanceEntry(payout, drafts) };
}

describe('a waived booking downstream of the money', () => {
  it('CUSTOMER_PAYS: the organizer is paid exactly what an unwaived booking pays them', () => {
    const normal = booking('b1', FeeMode.CUSTOMER_PAYS, false);
    const waived = booking('b2', FeeMode.CUSTOMER_PAYS, true);
    expect(waived.bookingFeeMinor).toBe(0);
    expect(waived.paymentFeeMinor).toBe(1_000);

    const a = payoutFor([normal]);
    const b = payoutFor([waived]);
    expect(b.settlement.net).toBe(a.settlement.net);
    expect(b.settlement.bookingFee).toBe(0);
    // The allocation invariant and the producer's integrity checks hold with a zero fee line.
    expect(allocatedNet(b.drafts)).toBe(b.settlement.net);
    expect(b.finance.integrity).toEqual([]);
    expect(payoutFor([normal, waived]).finance.integrity).toEqual([]);
  });

  it('ORGANIZER_PAYS: the waiver is the organizer saving - their fee falls by the waived amount', () => {
    const normal = booking('b1', FeeMode.ORGANIZER_PAYS, false);
    const waived = booking('b2', FeeMode.ORGANIZER_PAYS, true);
    expect(normal.organizerFeeMinor).toBe(2_530);
    expect(waived.organizerFeeMinor).toBe(1_000); // payment processing is still theirs to bear
    const a = payoutFor([normal]);
    const b = payoutFor([waived]);
    expect(b.settlement.net - a.settlement.net).toBe(1_530);
    expect(allocatedNet(b.drafts)).toBe(b.settlement.net);
    expect(b.finance.integrity).toEqual([]);
  });

  it('the marketplace split never goes negative and the platform keeps only the fees charged', () => {
    for (const mode of [FeeMode.CUSTOMER_PAYS, FeeMode.ORGANIZER_PAYS, FeeMode.SHARED]) {
      const w = booking('b', mode, true);
      const split = computeMarketplaceSplit({
        subtotalMinor: w.subtotalMinor,
        organizerFeeMinor: w.organizerFeeMinor,
        discountMinor: w.discountMinor,
        taxMinor: w.taxMinor,
        totalMinor: w.totalMinor,
      });
      expect(split.platformFeeMinor).toBe(w.paymentFeeMinor); // booking fee 0, nothing else
      expect(split.organizerNetMinor + split.platformFeeMinor).toBe(w.totalMinor);
    }
  });

  it('a refund of a waived booking: a cancellation returns what was paid, the organizer bears only the ticket', () => {
    const w = booking('b', FeeMode.CUSTOMER_PAYS, true);
    // A cancelled show returns everything the buyer paid: the ticket plus the payment fee.
    // There is no booking fee to return, and nothing negative appears anywhere.
    const platformFeeRefundedMinor = w.totalMinor - w.subtotalMinor;
    expect(platformFeeRefundedMinor).toBe(1_000);
    const refund = { bookingId: 'b', amountMinor: w.totalMinor, platformFeeRefundedMinor };
    expect(
      organizerShareOfRefund({
        currency: 'INR',
        amountMinor: w.totalMinor,
        taxAddedMinor: 0,
        platformFeeRefundedMinor,
      }),
    ).toBe(w.subtotalMinor);
    const out = payoutFor([w], [refund]);
    expect(out.settlement.net).toBe(0);
    expect(allocatedNet(out.drafts)).toBe(0);
    expect(out.finance.integrity).toEqual([]);
  });
});
