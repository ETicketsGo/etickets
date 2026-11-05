import { FeeMode } from '@eticketsgo/shared-types';
import { AdvertisedPriceService } from './advertised-price.service';
import { PricingService } from './pricing.service';
import type { FeePolicyRow } from './fee-policy';

/**
 * The card and the checkout resolve the SAME fee policy, through the same resolver.
 *
 * `AdvertisedPriceService` keeps its own copy of the fee bands (cached for the process), and
 * used to be the place a card and the checkout drifted apart. A waiver that only the checkout
 * knew about would advertise "from Rs 525" and charge Rs 510.
 */

const WAIVE: FeePolicyRow = {
  id: 'p1',
  scope: 'EVENT',
  eventId: 'ev1',
  organizationId: 'org1',
  kind: 'WAIVE',
  currency: null,
  startsAt: new Date(0),
  endsAt: null,
  maxOrders: null,
  usedOrders: 0,
  status: 'ACTIVE',
  version: 1,
};

function harness(policy: FeePolicyRow | null) {
  const prisma = { feeRule: { findMany: jest.fn().mockResolvedValue([]) } };
  const resolver = { resolve: jest.fn().mockResolvedValue(policy) };
  const config = { get: (k: string) => (k === 'PRICE_DISPLAY_MODE' ? 'all_in' : undefined) };
  const advertised = new AdvertisedPriceService(
    prisma as never,
    config as never,
    resolver as never,
  );
  const tax = {
    quote: jest.fn().mockResolvedValue({ taxLines: [], taxMinor: 0, taxAddedMinor: 0 }),
  };
  const pricing = new PricingService(
    prisma as never,
    tax as never,
    config as never,
    resolver as never,
  );
  return { advertised, pricing, resolver };
}

describe('advertised price follows the fee policy the checkout applies', () => {
  it.each([FeeMode.CUSTOMER_PAYS, FeeMode.SHARED, FeeMode.ORGANIZER_PAYS])(
    '%s: card == checkout total with a waiver, and without one',
    async (mode) => {
      for (const policy of [WAIVE, null]) {
        const { advertised, pricing } = harness(policy);
        const seller = { eventId: 'ev1', organizationId: 'org1' };
        const card = await advertised.forTicket(50_000, mode, 'INR', {}, seller);
        const checkout = await pricing.quote(50_000, mode, 0, 'INR', {}, undefined, undefined, {
          context: { ...seller, at: new Date() },
        });
        expect(card).toBe(checkout.totalMinor);
      }
    },
  );

  it('the waived card is cheaper by exactly the waived booking fee and its payment-fee share', async () => {
    const seller = { eventId: 'ev1', organizationId: 'org1' };
    const waived = await harness(WAIVE).advertised.forTicket(
      50_000,
      FeeMode.CUSTOMER_PAYS,
      'INR',
      {},
      seller,
    );
    const normal = await harness(null).advertised.forTicket(
      50_000,
      FeeMode.CUSTOMER_PAYS,
      'INR',
      {},
      seller,
    );
    expect(normal).toBe(52_530);
    expect(waived).toBe(51_000);
  });

  it('a card with no seller asks for no policy (every existing caller is unchanged)', async () => {
    const { advertised, resolver } = harness(WAIVE);
    expect(await advertised.forTicket(50_000, FeeMode.CUSTOMER_PAYS, 'INR')).toBe(52_530);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('quote without a policy selection is byte-for-byte the old result (no new keys)', async () => {
    const { pricing } = harness(WAIVE);
    const out = await pricing.quote(50_000, FeeMode.CUSTOMER_PAYS, 0, 'INR');
    expect(out.bookingFeeMinor).toBe(1_500);
    expect(Object.keys(out)).not.toContain('appliedFeePolicy');
    expect(Object.keys(out)).not.toContain('feeWaivedMinor');
  });
});
