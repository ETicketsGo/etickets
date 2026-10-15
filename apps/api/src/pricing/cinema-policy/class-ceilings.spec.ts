import { ceilingFrom, classCeilings, priceOutsideBand } from './class-ceilings';
import type { PolicyResolution, PolicyRow } from './cinema-pricing-policy.resolver';

/**
 * The per-class limit is a READING of the resolver's answer, judged by checkout's own tests.
 * These pin the three shapes an answer can take: a rated class, a class the order has no
 * rate for (the climate-only fallback), and no rules at all (Telangana).
 */
const row = (over: Partial<PolicyRow>): PolicyRow =>
  ({
    id: 'p',
    version: 1,
    country: 'India',
    region: 'Andhra Pradesh',
    district: '*',
    city: '*',
    currency: 'INR',
    localBodyType: 'MUNICIPAL_CORPORATION',
    cinemaFormat: 'MULTIPLEX',
    climateType: 'AC',
    seatCategory: 'RECLINER',
    maintenanceChargeMinor: 0,
    maintenanceTreatment: 'INCLUDED_IN_TICKET_PRICE',
    maintenanceTaxCategory: null,
    onlineFeePolicy: 'REQUIRES_APPROVAL',
    onlineFeeCapMinor: null,
    ticketPriceMinMinor: null,
    ticketPriceMaxMinor: 25_000,
    ticketPriceRule: null,
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
    regulatoryReference: 'G.O.Ms.No.13',
    ...over,
  }) as PolicyRow;

const compliant = (policy: PolicyRow): PolicyResolution => ({
  status: 'REQUIRES_APPROVAL',
  policy,
  explanation: 'matched',
  specificity: 10,
});
const notRegulated: PolicyResolution = {
  status: 'NOT_REGULATED',
  policy: null,
  explanation: 'none',
  specificity: -1,
};
const noRules: PolicyResolution = {
  status: 'POLICY_NOT_FOUND',
  policy: null,
  explanation: 'Telangana has no rules',
  specificity: -1,
};

describe('ceilingFrom', () => {
  it('a rated class carries its limit and reference', () => {
    expect(ceilingFrom('RECLINER', compliant(row({})))).toEqual({
      regulatoryClass: 'RECLINER',
      regulated: true,
      sellable: true,
      maxMinor: 25_000,
      minMinor: null,
      regulatoryReference: 'G.O.Ms.No.13',
      status: 'REQUIRES_APPROVAL',
    });
  });

  it('the climate-only fallback (no class, no maximum) is NOT a rate: not sellable', () => {
    const c = ceilingFrom(
      'PREMIUM',
      compliant(row({ seatCategory: null, ticketPriceMaxMinor: null })),
    );
    expect(c.regulated).toBe(true);
    expect(c.sellable).toBe(false);
    expect(c.maxMinor).toBeNull();
  });

  it('no rules at all is regulated and sells nothing (Telangana)', () => {
    const c = ceilingFrom('REGULAR', noRules);
    expect(c).toMatchObject({ regulated: true, sellable: false, maxMinor: null });
  });

  it('an unregulated place has no limit and sells', () => {
    expect(ceilingFrom('REGULAR', notRegulated)).toMatchObject({
      regulated: false,
      sellable: true,
      maxMinor: null,
    });
  });

  it('classCeilings asks once per class, in a fixed order', async () => {
    const asked: string[] = [];
    const all = await classCeilings(async (cls) => {
      asked.push(cls);
      return notRegulated;
    });
    expect(asked).toEqual(['REGULAR', 'RECLINER', 'PREMIUM', 'NON_PREMIUM']);
    expect(all).toHaveLength(4);
  });
});

describe('priceOutsideBand', () => {
  const ask = (priceMinor: number, resolution = compliant(row({}))) =>
    priceOutsideBand(resolution, {
      regulatoryClass: 'RECLINER',
      seatCategoryName: 'Lounge',
      priceMinor,
      currency: 'INR',
      place: 'Andhra Pradesh',
    });

  it('names the category, the state, the limit and what to enter', () => {
    expect(ask(30_000)).toBe(
      'Lounge: Andhra Pradesh allows at most ₹250 for a Recliner seat at this cinema, so ₹300 cannot be sold. Enter ₹250 or less.',
    );
  });

  it('exactly the limit is lawful (inclusive, like checkout)', () => {
    expect(ask(25_000)).toBeNull();
  });

  it('a minimum is enforced too', () => {
    expect(ask(5_000, compliant(row({ ticketPriceMinMinor: 10_000 })))).toMatch(
      /requires at least ₹100/,
    );
  });

  it('says nothing where there is no stated band: unregulated, or no rate for the class', () => {
    expect(ask(99_000, notRegulated)).toBeNull();
    expect(ask(99_000, noRules)).toBeNull();
    expect(
      ask(99_000, compliant(row({ seatCategory: null, ticketPriceMaxMinor: null }))),
    ).toBeNull();
  });
});
