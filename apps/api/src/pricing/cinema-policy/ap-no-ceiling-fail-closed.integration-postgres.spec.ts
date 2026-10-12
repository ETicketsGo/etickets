import { PrismaClient } from '@prisma/client';
import { CinemaPricingPolicyService } from './cinema-pricing-policy.service';
import {
  cartSaleEligibility,
  sessionSaleEligibility,
  type AdmissionLine,
  type PolicyCinema,
} from './sale-eligibility';

/**
 * integration-real-postgres - a known seat class with no rate row is refused (gap G10).
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * An Andhra Pradesh multiplex has rate rows for REGULAR and RECLINER only. A seat category
 * mapped to PREMIUM or NON_PREMIUM matches neither, so the resolver fell to the climate-only
 * fallback row, which carries maintenance and states NO maximum price. The sale completed,
 * looked normal, and was capped by nothing.
 *
 * ── THE FIXTURE ────────────────────────────────────────────────────────────────────
 * Like the rate-table suite, this CLONES the seeded Andhra Pradesh rows into a test-only
 * country and activates the clones there. The values are copied, not restated, so the test
 * runs against the real transcription; the seeded rows are never touched, so the suite that
 * asserts they ship as DRAFT cannot see this one. Everything it creates is deleted.
 */
const prisma = new PrismaClient();
const service = new CinemaPricingPolicyService(prisma as never);
const resolve = (ctx: never) => service.resolve(ctx);

const AT = new Date('2026-10-01T00:00:00Z');
const stamp = Date.now();
const AP_COUNTRY = `ApFailClosedTest${stamp}`;
const CEILING_COUNTRY = `ApFailClosedCeiling${stamp}`;
const UNREGULATED_COUNTRY = `ApFailClosedNone${stamp}`;

const multiplex = (country: string): PolicyCinema => ({
  id: 'cinema-under-test',
  country,
  region: 'Andhra Pradesh',
  district: null,
  city: 'Vijayawada',
  localBodyType: 'MUNICIPAL_CORPORATION',
  cinemaFormat: 'MULTIPLEX',
  climateType: 'AC',
});

const line = (
  category: string | null,
  unitPriceMinor: number,
  extra: Partial<AdmissionLine> = {},
): AdmissionLine => ({
  unitPriceMinor,
  quantity: 1,
  category,
  seatCategoryName: category ? `Seat ${category}` : null,
  ticketTypeId: `tt-${category ?? 'none'}`,
  ticketTypeName: `Ticket ${category ?? 'none'}`,
  ...extra,
});

beforeAll(async () => {
  await prisma.cinemaPricingPolicy.deleteMany({
    where: { country: { in: [AP_COUNTRY, CEILING_COUNTRY] } },
  });
  const seeded = await prisma.cinemaPricingPolicy.findMany({
    where: { country: 'India', region: 'Andhra Pradesh' },
  });
  if (seeded.length === 0) throw new Error('AP policies are not seeded; run the seed first.');
  for (const row of seeded) {
    const { id: _id, createdAt: _c, updatedAt: _u, supersedesId: _s, ...values } = row;
    await prisma.cinemaPricingPolicy.create({
      data: { ...values, country: AP_COUNTRY, status: 'ACTIVE' },
    });
  }
  // A class-agnostic rule that DOES state a ceiling: a real rate for every class.
  const template = seeded.find((r) => r.seatCategory === null && r.ticketPriceMaxMinor === null);
  if (!template) throw new Error('Expected a seeded class-agnostic fallback row.');
  const { id: _i, createdAt: _c2, updatedAt: _u2, supersedesId: _s2, ...base } = template;
  await prisma.cinemaPricingPolicy.create({
    data: {
      ...base,
      country: CEILING_COUNTRY,
      status: 'ACTIVE',
      ticketPriceMaxMinor: 30_000,
      regulatoryReference: `${base.regulatoryReference} (ceiling fixture)`,
    },
  });
});
afterAll(async () => {
  await prisma.cinemaPricingPolicy.deleteMany({
    where: { country: { in: [AP_COUNTRY, CEILING_COUNTRY] } },
  });
  await prisma.$disconnect();
});

const cart = (country: string, lines: AdmissionLine[]) =>
  cartSaleEligibility(resolve as never, multiplex(country), 'INR', lines, AT);

describe('an AP multiplex seat class with no rate row', () => {
  it.each(['PREMIUM', 'NON_PREMIUM'])(
    '%s is refused, not priced against the fallback',
    async (c) => {
      const { eligibility } = await cart(AP_COUNTRY, [line(c, 20_000)]);
      expect(eligibility.sellable).toBe(false);
      expect(eligibility.blockers).toHaveLength(1);
      const b = eligibility.blockers[0];
      expect(b.code).toBe('SEAT_CLASS_UNMAPPED');
      expect(b.owner).toBe('ORGANIZER');
      expect(b.fixPath).toContain('seat-classes');
      expect(b.organizerMessage).toContain(`Seat ${c}`);
      expect(b.organizerMessage).toMatch(/no price limit on record for Andhra Pradesh/);
      // The buyer is not told why.
      expect(b.buyerMessage).toMatch(/not open for this show yet/);
    },
  );

  it('is refused at ANY price, including one a ceiling would have allowed', async () => {
    const { eligibility } = await cart(AP_COUNTRY, [line('PREMIUM', 100)]);
    expect(eligibility.sellable).toBe(false);
  });

  it('REGULAR and RECLINER are unchanged: sell inside the ceiling, refuse above it', async () => {
    expect((await cart(AP_COUNTRY, [line('REGULAR', 15_000)])).eligibility.sellable).toBe(true);
    expect((await cart(AP_COUNTRY, [line('RECLINER', 25_000)])).eligibility.sellable).toBe(true);
    const over = (await cart(AP_COUNTRY, [line('REGULAR', 15_100)])).eligibility.blockers;
    expect(over.map((b) => b.code)).toEqual(['PRICE_OVER_CEILING']);
  });

  it('a mixed cart is refused for the unrated class only, and names its ticket type', async () => {
    const { eligibility } = await cart(AP_COUNTRY, [
      line('REGULAR', 15_000),
      line('PREMIUM', 20_000),
    ]);
    expect(eligibility.sellable).toBe(false);
    expect(eligibility.blockers).toHaveLength(1);
    expect(eligibility.blockers[0].ticketTypeIds).toEqual(['tt-PREMIUM']);
  });

  it('a show keeps its sellable ticket types open while the unrated one closes', async () => {
    const types = ['REGULAR', 'RECLINER', 'PREMIUM'].map((c) => ({
      id: `tt-${c}`,
      name: `Ticket ${c}`,
      priceMinor: c === 'RECLINER' ? 25_000 : 15_000,
      currency: 'INR',
      seatCategory: { name: `Seat ${c}`, regulatoryClass: c },
    }));
    const r = await sessionSaleEligibility(
      resolve as never,
      multiplex(AP_COUNTRY),
      types,
      'India',
      AT,
    );
    expect(r.sellable).toBe(false);
    expect(r.sellableTicketTypeIds.sort()).toEqual(['tt-RECLINER', 'tt-REGULAR']);
    expect(r.blockers.map((b) => b.code)).toEqual(['SEAT_CLASS_UNMAPPED']);
  });
});

describe('what stays as it was', () => {
  it('a class-agnostic rule that states a ceiling is a real rate for every class', async () => {
    const { eligibility } = await cart(CEILING_COUNTRY, [line('PREMIUM', 20_000)]);
    expect(eligibility.sellable).toBe(true);
    const over = await cart(CEILING_COUNTRY, [line('PREMIUM', 30_100)]);
    expect(over.eligibility.blockers.map((b) => b.code)).toEqual(['PRICE_OVER_CEILING']);
  });

  it('a market no active rule claims is not regulated, whatever the class', async () => {
    const { eligibility } = await cart(UNREGULATED_COUNTRY, [line('PREMIUM', 99_999)]);
    expect(eligibility.sellable).toBe(true);
  });

  it('a seated category with a class and a ceiling still sells (REGULAR 150, RECLINER 250)', async () => {
    expect((await cart(AP_COUNTRY, [line('REGULAR', 15_000)])).eligibility.sellable).toBe(true);
    expect((await cart(AP_COUNTRY, [line('RECLINER', 25_000)])).eligibility.sellable).toBe(true);
  });
});

describe('a seated ticket whose seat category has NO regulatory class (owner 2026-10-12)', () => {
  const unmappedSeat = (price: number) =>
    line(null, price, {
      seatCategoryName: 'Platinum Executive',
      ticketTypeId: 'tt-plat',
      ticketTypeName: 'Platinum',
    });

  it('is refused at any price, as SEAT_CLASS_UNMAPPED with a fix link', async () => {
    for (const price of [100, 20_000, 99_999]) {
      const { eligibility } = await cart(AP_COUNTRY, [unmappedSeat(price)]);
      expect(eligibility.sellable).toBe(false);
      const b = eligibility.blockers[0];
      expect(b.code).toBe('SEAT_CLASS_UNMAPPED');
      expect(b.owner).toBe('ORGANIZER');
      expect(b.fixPath).toContain('seat-classes');
      expect(b.organizerMessage).toContain('Platinum Executive');
    }
  });

  it('closes only its own ticket type on a show, leaving REGULAR/RECLINER open', async () => {
    const types = [
      {
        id: 'tt-reg',
        name: 'Reg',
        priceMinor: 15_000,
        currency: 'INR',
        seatCategory: { name: 'R', regulatoryClass: 'REGULAR' },
      },
      {
        id: 'tt-rec',
        name: 'Rec',
        priceMinor: 25_000,
        currency: 'INR',
        seatCategory: { name: 'C', regulatoryClass: 'RECLINER' },
      },
      {
        id: 'tt-plat',
        name: 'Plat',
        priceMinor: 20_000,
        currency: 'INR',
        seatCategory: { name: 'Platinum Executive', regulatoryClass: null },
      },
    ];
    const r = await sessionSaleEligibility(
      resolve as never,
      multiplex(AP_COUNTRY),
      types,
      'India',
      AT,
    );
    expect(r.sellableTicketTypeIds.sort()).toEqual(['tt-rec', 'tt-reg']);
    expect(r.blockers.map((b) => b.code)).toEqual(['SEAT_CLASS_UNMAPPED']);
  });

  it('an unregulated market still sells it', async () => {
    expect((await cart(UNREGULATED_COUNTRY, [unmappedSeat(99_999)])).eligibility.sellable).toBe(
      true,
    );
  });
});

describe('a ticket with no seat category at all (general admission) at a regulated cinema', () => {
  it('is refused when the only rule that applies states no ceiling', async () => {
    const { eligibility } = await cart(AP_COUNTRY, [line(null, 20_000)]);
    expect(eligibility.sellable).toBe(false);
    const b = eligibility.blockers[0];
    expect(b.code).toBe('SEAT_CLASS_UNMAPPED');
    expect(b.owner).toBe('ORGANIZER');
    expect(b.fixPath).toContain('seat-classes');
    expect(b.organizerMessage).toMatch(/has no seat category/);
    expect(b.ticketTypeIds).toEqual(['tt-none']);
  });

  it('prices against a class-agnostic rule that DOES state a ceiling', async () => {
    expect((await cart(CEILING_COUNTRY, [line(null, 20_000)])).eligibility.sellable).toBe(true);
    const over = await cart(CEILING_COUNTRY, [line(null, 30_100)]);
    expect(over.eligibility.blockers.map((b) => b.code)).toEqual(['PRICE_OVER_CEILING']);
  });

  it('a market no active rule claims is not regulated: it sells', async () => {
    expect((await cart(UNREGULATED_COUNTRY, [line(null, 20_000)])).eligibility.sellable).toBe(true);
  });

  it('beside a REGULAR seat, only the classless ticket type is stopped', async () => {
    const { eligibility } = await cart(AP_COUNTRY, [line('REGULAR', 15_000), line(null, 5_000)]);
    expect(eligibility.blockers.map((b) => b.ticketTypeIds)).toEqual([['tt-none']]);
  });
});
