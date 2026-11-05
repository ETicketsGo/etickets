import { FeeMode } from '@eticketsgo/shared-types';
import { PricingService } from './pricing.service';
import type { FeePolicyRow } from './fee-policy';

/**
 * The quote names the fee schedule that priced it, so a booking can tell when the schedule
 * was published over in between; and a published schedule never outranks a fee policy.
 */

const usd = (feeMinor: number) => [
  {
    id: 'usd-1',
    minMinor: 0,
    maxMinor: null,
    feeMinor,
    feeType: 'FLAT',
    country: 'United States',
    region: '*',
    active: true,
  },
];

function harness(byCurrency: Record<string, unknown[]>, policy: FeePolicyRow | null = null) {
  const prisma = {
    feeRule: {
      findMany: jest.fn(
        async ({ where }: { where: { currency: string } }) => byCurrency[where.currency] ?? [],
      ),
    },
  };
  const tax = {
    quote: jest.fn().mockResolvedValue({ taxLines: [], taxMinor: 0, taxAddedMinor: 0 }),
  };
  const resolver = { resolve: jest.fn().mockResolvedValue(policy) };
  const pricing = new PricingService(
    prisma as never,
    tax as never,
    { get: () => undefined } as never,
    resolver as never,
  );
  const quote = (currency: string, withPolicy = false) =>
    pricing.quote(
      10_000,
      FeeMode.CUSTOMER_PAYS,
      0,
      currency,
      { country: currency === 'USD' ? 'United States' : 'India' },
      undefined,
      undefined,
      withPolicy
        ? { context: { eventId: 'ev1', organizationId: 'org1', at: new Date() } }
        : undefined,
    );
  return { byCurrency, quote };
}

describe('feeScheduleVersion on a quote', () => {
  it('is the same for the same schedule and changes when the schedule changes', async () => {
    const h = harness({ USD: usd(199) });
    const a = await h.quote('USD');
    const b = await h.quote('USD');
    expect(a.feeScheduleVersion).toBe(b.feeScheduleVersion);
    h.byCurrency.USD = usd(299);
    const c = await h.quote('USD');
    expect(c.feeScheduleVersion).not.toBe(a.feeScheduleVersion);
    expect(c.bookingFeeMinor).toBe(299);
  });

  it('a USD publish leaves the INR version and fee alone', async () => {
    const inr = [{ ...usd(500)[0], id: 'inr-1', country: 'India' }];
    const h = harness({ USD: usd(199), INR: inr });
    const before = await h.quote('INR');
    h.byCurrency.USD = usd(299);
    const after = await h.quote('INR');
    expect(after.feeScheduleVersion).toBe(before.feeScheduleVersion);
    expect(after.bookingFeeMinor).toBe(before.bookingFeeMinor);
  });

  it('an event waiver still beats a newly published schedule', async () => {
    const waiver: FeePolicyRow = {
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
    const h = harness({ USD: usd(299) }, waiver);
    expect((await h.quote('USD', true)).bookingFeeMinor).toBe(0);
    expect((await h.quote('USD', false)).bookingFeeMinor).toBe(299);
  });
});
