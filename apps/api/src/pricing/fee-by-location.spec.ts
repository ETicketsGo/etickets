import { PricingService } from './pricing.service';

/**
 * Fees that know where they are, and a platform fee a customer can read in one number.
 *
 * ── WHY LOCATION ───────────────────────────────────────────────────────────────────
 * Fee bands were selected by CURRENCY alone, which is not the unit anybody regulates.
 * Several Indian states cap what may be charged for booking a cinema ticket online, and the
 * cap differs by state — so one INR schedule cannot be correct for the whole country.
 *
 * ── WHY ONE ROW ────────────────────────────────────────────────────────────────────
 * "What does this platform charge me" has one answer. Split into a ₹40 fee and ₹7.20 of tax
 * two rows apart, neither number is it, and the customer is left doing arithmetic to find
 * out. The itemisation still exists for the invoice; this is a second view of the same money.
 */
const tax = (lines: unknown[] = [], taxAddedMinor = 0) => ({
  quote: jest.fn().mockResolvedValue({
    taxLines: lines,
    taxMinor: (lines as { amountMinor: number }[]).reduce((s, l) => s + l.amountMinor, 0),
    taxAddedMinor,
    provider: 'manual',
    providerRef: null,
  }),
});

const service = (rules: unknown[], taxStub = tax()) =>
  new PricingService(
    { feeRule: { findMany: jest.fn().mockResolvedValue(rules) } } as never,
    taxStub as never,
    { get: () => undefined } as never,
  );

const band = (over: Record<string, unknown> = {}) => ({
  minMinor: 0,
  maxMinor: null,
  feeMinor: 2_000,
  country: '*',
  region: '*',
  ...over,
});

describe('fee bands by location', () => {
  it('uses the national schedule when no state names itself', async () => {
    const svc = service([band({ country: 'India', feeMinor: 2_000 })]);
    const r = await svc.quote(50_000, 'CUSTOMER_PAYS', 0, 'INR', {
      country: 'India',
      region: 'KA',
    });
    expect(r.bookingFeeMinor).toBe(2_000);
  });

  it('lets a STATE override the national schedule', async () => {
    /*
      The case this exists for. A state that caps the online booking charge needs its own
      number, and getting it should not mean editing the national default.
    */
    const svc = service([
      band({ country: 'India', feeMinor: 2_000 }),
      band({ country: 'India', region: 'TG', feeMinor: 500 }),
    ]);
    const r = await svc.quote(50_000, 'CUSTOMER_PAYS', 0, 'INR', {
      country: 'India',
      region: 'TG',
    });
    expect(r.bookingFeeMinor).toBe(500);
  });

  it('does not leak one state’s schedule into another', async () => {
    const svc = service([
      band({ country: 'India', feeMinor: 2_000 }),
      band({ country: 'India', region: 'TG', feeMinor: 500 }),
    ]);
    const r = await svc.quote(50_000, 'CUSTOMER_PAYS', 0, 'INR', {
      country: 'India',
      region: 'MH',
    });
    expect(r.bookingFeeMinor).toBe(2_000);
  });

  it('takes the winning specificity WHOLESALE, never a blend', async () => {
    /*
      A state schedule replaces the national one rather than merging with it. Mixing a
      Telangana ₹5 band with a national ₹20 band would produce a schedule nobody wrote, where
      the charge depends on which band an order happens to land in.
    */
    const svc = service([
      band({ country: 'India', minMinor: 0, maxMinor: 19_900, feeMinor: 500 }),
      band({ country: 'India', minMinor: 20_000, maxMinor: null, feeMinor: 2_000 }),
      // Telangana names ONE band. It must not inherit the national band above it.
      band({ country: 'India', region: 'TG', minMinor: 0, maxMinor: null, feeMinor: 300 }),
    ]);
    const big = await svc.quote(500_000, 'CUSTOMER_PAYS', 0, 'INR', {
      country: 'India',
      region: 'TG',
    });
    expect(big.bookingFeeMinor).toBe(300);
  });

  it('falls back to the built-in defaults when nothing matches', async () => {
    // A rule set that names only other countries must not leave a sale with no fee schedule
    // at all — that would silently make the platform free.
    const svc = service([band({ country: 'USA', feeMinor: 9_900 })]);
    const r = await svc.quote(50_000, 'CUSTOMER_PAYS', 0, 'INR', { country: 'India' });
    expect(r.bookingFeeMinor).toBeGreaterThan(0);
  });

  it('keeps working for a caller that names no location at all', async () => {
    // Every existing caller. A wildcard rule still matches an unknown place.
    const svc = service([band({ feeMinor: 1_500 })]);
    const r = await svc.quote(50_000, 'CUSTOMER_PAYS', 0, 'INR');
    expect(r.bookingFeeMinor).toBe(1_500);
  });
});

describe('the platform fee as one number', () => {
  const feeTax = (amountMinor: number, inclusive: boolean, baseMinor: number) => [
    { label: 'GST', rateBasisPoints: 1_800, baseMinor, amountMinor, basis: 'FEES', inclusive },
  ];

  it('adds the tax to the fee when the tax is charged on top', async () => {
    /*
      The BookMyShow shape: a ₹40 base fee with 18% added is ₹47.20 to the customer, and
      ₹47.20 is the only number worth putting in front of them.
    */
    const svc = service([band({ feeMinor: 4_000 })], tax(feeTax(720, false, 4_000), 720));
    const r = await svc.quote(30_000, 'CUSTOMER_PAYS', 0, 'INR');

    expect(r.customerFeeInclusiveMinor).toBe(r.customerFeeMinor + 720);
    expect(r.feeTaxRateBasisPoints).toBe(1_800);
    expect(r.feeTaxMinor).toBe(720);
  });

  it('does NOT add it again when the tax was already inside the fee', async () => {
    // The inclusive case. Adding here would charge the tax twice — the same mistake the
    // receipt made when it listed inclusive tax above the total.
    const svc = service([band({ feeMinor: 4_720 })], tax(feeTax(720, true, 4_000), 0));
    const r = await svc.quote(30_000, 'CUSTOMER_PAYS', 0, 'INR');
    expect(r.customerFeeInclusiveMinor).toBe(r.customerFeeMinor);
  });

  it('counts only tax on the FEE, never the ticket’s', async () => {
    /*
      Folding admission tax into the fee would make the platform look like most of the order.
      The basis on each line is what makes this unambiguous — inferring it from the amounts
      was wrong the moment a tax was inclusive.
    */
    const svc = service(
      [band({ feeMinor: 4_000 })],
      tax(
        [
          {
            label: 'CGST',
            rateBasisPoints: 900,
            baseMinor: 25_424,
            amountMinor: 2_288,
            basis: 'TICKETS',
            inclusive: true,
          },
          {
            label: 'IGST',
            rateBasisPoints: 1_800,
            baseMinor: 4_000,
            amountMinor: 720,
            basis: 'FEES',
            inclusive: false,
          },
        ],
        720,
      ),
    );
    const r = await svc.quote(30_000, 'CUSTOMER_PAYS', 0, 'INR');
    expect(r.feeTaxMinor).toBe(720);
    expect(r.feeTaxRateBasisPoints).toBe(1_800);
  });

  it('reports the fee unchanged and a zero rate when nothing is taxed', async () => {
    // The default that ships. No tax configured must leave every number exactly as it was.
    const svc = service([band({ feeMinor: 1_500 })]);
    const r = await svc.quote(50_000, 'CUSTOMER_PAYS', 0, 'INR');
    expect(r.customerFeeInclusiveMinor).toBe(r.customerFeeMinor);
    expect(r.feeTaxRateBasisPoints).toBe(0);
  });

  it('still foots: net + fee + added tax equals the total', async () => {
    // The invariant the all-in figure must not disturb. It is a VIEW of the money, not a
    // second charge.
    const svc = service([band({ feeMinor: 4_000 })], tax(feeTax(720, false, 4_000), 720));
    const r = await svc.quote(30_000, 'CUSTOMER_PAYS', 0, 'INR');
    expect(r.netSubtotalMinor + r.customerFeeMinor + 720).toBe(r.totalMinor);
  });
});
