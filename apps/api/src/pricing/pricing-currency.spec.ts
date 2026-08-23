import { PricingService } from './pricing.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Fee tiers must be resolved per currency.
 *
 * Amounts are integer minor units, so a ₹5 fee and a $5 fee are both stored as 500 while
 * meaning entirely different sums, and the bands (₹0–₹199 vs $0–$9.99) do not correspond.
 * Before multi-currency rules existed the query returned every active rule — harmless only
 * because the table held nothing but INR. These tests pin the filtering so seeding USD, CAD
 * and AUD bands cannot start mis-pricing INR orders.
 */
describe('PricingService currency isolation', () => {
  const INR = [
    { minMinor: 0, maxMinor: 19_900, feeMinor: 500, currency: 'INR' },
    { minMinor: 20_000, maxMinor: null, feeMinor: 2_000, currency: 'INR' },
  ];
  const USD = [
    { minMinor: 0, maxMinor: 999, feeMinor: 49, currency: 'USD' },
    { minMinor: 1_000, maxMinor: null, feeMinor: 199, currency: 'USD' },
  ];

  function make(rows: typeof INR, taxRows: unknown[] = []) {
    const findMany = jest.fn().mockResolvedValue(rows);
    const taxFindMany = jest.fn().mockResolvedValue(taxRows);
    const prisma = {
      feeRule: { findMany },
      taxRule: { findMany: taxFindMany },
    } as unknown as PrismaService;
    return { svc: new PricingService(prisma), findMany, taxFindMany };
  }

  it('queries only the requested currency', async () => {
    const { svc, findMany } = make(USD);
    await svc.quote(5_000, 'ABSORB' as never, 0, 'USD');
    expect(findMany.mock.calls[0][0].where).toEqual({ active: true, currency: 'USD' });
  });

  it('defaults to INR so existing callers are unchanged', async () => {
    const { svc, findMany } = make(INR);
    await svc.quote(10_000, 'ABSORB' as never);
    expect(findMany.mock.calls[0][0].where).toEqual({ active: true, currency: 'INR' });
  });

  // The regression this guards: a $12.00 order must use the $10+ band (199 cents), not the
  // INR band that also happens to contain 1200 minor units.
  it('charges the USD band for a USD order, not an INR band with the same numeric range', async () => {
    const { svc } = make(USD);
    const usd = await svc.quote(1_200, 'PASS_THROUGH' as never, 0, 'USD');
    expect(usd.bookingFeeMinor).toBe(199);

    const { svc: inrSvc } = make(INR);
    const inr = await inrSvc.quote(1_200, 'PASS_THROUGH' as never, 0, 'INR');
    expect(inr.bookingFeeMinor).toBe(500);
  });

  it('falls back to the built-in defaults when a currency has no rules', async () => {
    const { svc } = make([]);
    const res = await svc.quote(10_000, 'PASS_THROUGH' as never, 0, 'CAD');
    // DEFAULT_FEE_TIERS: 0–19 900 -> 500.
    expect(res.bookingFeeMinor).toBe(500);
  });

  // Tax rules are currency-scoped for exactly the same reason fee tiers are: a 1_800 basis
  // point rate is currency-neutral, but a rule row seeded for one market must not be picked
  // up by another. '*' is the deliberate "any currency" escape hatch.
  it('queries tax rules for the requested currency plus the wildcard', async () => {
    const { svc, taxFindMany } = make(USD);
    await svc.quote(5_000, 'PASS_THROUGH' as never, 0, 'USD');
    expect(taxFindMany.mock.calls[0][0].where).toEqual({
      active: true,
      currency: { in: ['USD', '*'] },
    });
  });

  it('charges no tax when the table is empty, which is the shipped default', async () => {
    const { svc } = make(INR);
    const res = await svc.quote(100_000, 'PASS_THROUGH' as never);
    expect(res.taxMinor).toBe(0);
    expect(res.taxLines).toEqual([]);
  });
});
