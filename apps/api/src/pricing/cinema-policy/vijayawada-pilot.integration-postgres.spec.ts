import { PrismaClient } from '@prisma/client';
import { BookingsService } from '../../bookings/bookings.service';
import { CinemaPricingPolicyService } from './cinema-pricing-policy.service';

/**
 * The Vijayawada pilot, proved against the code a real booking runs through.
 *
 * ── WHY THIS GOES THROUGH BookingsService AND NOT THE RESOLVER ─────────────────────
 * The resolver was already well covered, and the ceilings still were not enforced on a single
 * sale. `admissionLinesFor` handed the policy engine the EVENT's category — the literal string
 * "MOVIE" — as the cart's seat class. No rate row names a class called "MOVIE", so every real
 * booking fell past the class-specific rows onto the class-agnostic fallback, which carries a
 * maintenance charge and no maximum price. ₹150 and ₹250 were displayed in the compliance
 * screen and enforced on nothing.
 *
 * A test that resolves policies directly cannot see that, because it passes the right input by
 * hand. So these tests build the cart the way the booking does and call the same private
 * methods the booking calls.
 *
 * ── WHY IT CLONES THE SEEDED ROWS INTO ITS OWN COUNTRY ─────────────────────────────
 * The seeded India rows are DRAFT and another suite asserts they stay that way. Jest runs
 * suites in parallel against one database, so activating them here would fail that suite from
 * a distance. The rows are copied — values included, so the ceilings under test are the real
 * transcribed ones — into a country only this file uses, and deleted afterwards.
 */
const prisma = new PrismaClient();

const TEST_COUNTRY = 'IndiaVijayawadaPilotTest';
const REGION = 'Andhra Pradesh';
const CITY = 'Vijayawada';

/** Vijayawada is a Municipal Corporation, which is what selects the slab under test. */
const CINEMA = {
  country: TEST_COUNTRY,
  region: REGION,
  district: null,
  city: CITY,
  localBodyType: 'MUNICIPAL_CORPORATION' as const,
  cinemaFormat: 'MULTIPLEX' as const,
  climateType: 'AC' as const,
  venue: null,
};

const session = { screen: { cinema: CINEMA } };

const policyService = new CinemaPricingPolicyService(prisma as never);

/** The nine constructor arguments none of these tests reach, plus the policy service. */
const bookings = new BookingsService(
  {} as never, // prisma
  {} as never, // pricing
  {} as never, // pricingStrategies
  {} as never, // audit
  {} as never, // inventory
  {} as never, // addOnInventory
  {} as never, // metrics
  {} as never, // lockShadow
  {} as never, // bookingShadow
  undefined, // config
  undefined, // payments
  policyService,
);

type Line = {
  unitPriceMinor: number;
  quantity: number;
  category: string | null;
  seatCategoryName: string | null;
};

/** Build the cart exactly as the booking path does, from ticket types and their seat categories. */
const cartFor = (
  seats: { name: string; regulatoryClass: string | null; priceMinor: number; qty?: number }[],
): Line[] =>
  (
    bookings as unknown as {
      admissionLinesFor: (e: unknown, i: unknown, m: unknown) => Line[];
    }
  ).admissionLinesFor(
    { experienceType: 'MOVIE', category: null },
    seats.map((s, i) => ({ ticketTypeId: `tt${i}`, quantity: s.qty ?? 1 })),
    new Map(
      seats.map((s, i) => [
        `tt${i}`,
        {
          priceMinor: s.priceMinor,
          seatCategory: { name: s.name, regulatoryClass: s.regulatoryClass },
        },
      ]),
    ),
  );

const resolveFor = async (lines: Line[]) =>
  (
    bookings as unknown as {
      resolveCinemaPolicy: (
        s: unknown,
        c: string,
        l: unknown,
        at: Date,
      ) => Promise<{
        resolution: {
          status: string;
          explanation: string;
          policy: { ticketPriceMaxMinor: number | null; regulatoryReference: string } | null;
        };
        effect: {
          maintenanceMinor: number;
          maintenanceAddedMinor: number;
          maxOnlineFeeMinor: number | null;
        };
        overCeiling: { seatCategoryName: string | null; priceMinor: number; reason: string }[];
      }>;
    }
  ).resolveCinemaPolicy(session, 'INR', lines, new Date('2026-09-04T10:00:00Z'));

beforeAll(async () => {
  await prisma.cinemaPricingPolicy.deleteMany({ where: { country: TEST_COUNTRY } });

  const seeded = await prisma.cinemaPricingPolicy.findMany({
    where: {
      country: 'India',
      region: REGION,
      localBodyType: 'MUNICIPAL_CORPORATION',
      cinemaFormat: 'MULTIPLEX',
    },
  });
  const fallbacks = await prisma.cinemaPricingPolicy.findMany({
    where: { country: 'India', region: REGION, climateType: 'AC', seatCategory: null },
  });
  if (seeded.length === 0) {
    throw new Error('Andhra Pradesh policies are not seeded; run db:seed:india-cinema first.');
  }

  for (const row of [...seeded, ...fallbacks]) {
    const { id: _i, createdAt: _c, updatedAt: _u, supersedesId: _s, ...values } = row;
    await prisma.cinemaPricingPolicy.create({
      data: { ...values, country: TEST_COUNTRY, status: 'ACTIVE' },
    });
  }
});

afterAll(async () => {
  await prisma.cinemaPricingPolicy.deleteMany({ where: { country: TEST_COUNTRY } });
  await prisma.$disconnect();
});

describe('the Vijayawada Municipal Corporation multiplex slab', () => {
  it('sells a regular seat at exactly the permitted ₹150', async () => {
    const r = await resolveFor(
      cartFor([{ name: 'Gold', regulatoryClass: 'REGULAR', priceMinor: 15000 }]),
    );
    expect(r.overCeiling).toEqual([]);
    expect(r.resolution.policy?.ticketPriceMaxMinor).toBe(15000);
  });

  it('refuses a regular seat at ₹151 — one rupee over is over', async () => {
    const r = await resolveFor(
      cartFor([{ name: 'Gold', regulatoryClass: 'REGULAR', priceMinor: 15100 }]),
    );
    expect(r.overCeiling).toHaveLength(1);
    expect(r.overCeiling[0].priceMinor).toBe(15100);
    // The refusal has to name the ORDER, or an organizer cannot tell whether the platform
    // invented the limit or the state did.
    expect(r.overCeiling[0].reason).toMatch(/G\.O\.Ms\.No\.13/);
  });

  it('sells a recliner at exactly the permitted ₹250', async () => {
    const r = await resolveFor(
      cartFor([{ name: 'Lounger', regulatoryClass: 'RECLINER', priceMinor: 25000 }]),
    );
    expect(r.overCeiling).toEqual([]);
  });

  it('refuses a recliner at ₹251', async () => {
    const r = await resolveFor(
      cartFor([{ name: 'Lounger', regulatoryClass: 'RECLINER', priceMinor: 25100 }]),
    );
    expect(r.overCeiling).toHaveLength(1);
    expect(r.overCeiling[0].seatCategoryName).toBe('Lounger');
  });

  it('does not lend the recliner ceiling to a regular seat in the same cart', async () => {
    // The failure this prevents: one cart-wide resolution would cap BOTH classes at whichever
    // row won, so a ₹250 regular seat would pass under the recliner's ceiling.
    const r = await resolveFor(
      cartFor([
        { name: 'Gold', regulatoryClass: 'REGULAR', priceMinor: 25000 },
        { name: 'Lounger', regulatoryClass: 'RECLINER', priceMinor: 25000 },
      ]),
    );
    expect(r.overCeiling).toHaveLength(1);
    expect(r.overCeiling[0].seatCategoryName).toBe('Gold');
  });

  it('does not condemn a legal recliner under the regular ceiling', async () => {
    const r = await resolveFor(
      cartFor([
        { name: 'Gold', regulatoryClass: 'REGULAR', priceMinor: 15000 },
        { name: 'Lounger', regulatoryClass: 'RECLINER', priceMinor: 25000 },
      ]),
    );
    expect(r.overCeiling).toEqual([]);
  });

  it('SELLS a cart holding both a regular seat and a recliner', async () => {
    /*
      The defect this pins down: resolving the cart against every seat class at once matched
      the regular row and the recliner row, which are equally specific, and the resolver
      reported "2 equally specific policies match this order". That status blocks a booking.
      Buying one of each is an ordinary purchase, and it was refused outright — the fail-closed
      rule firing on a completely legal sale.
    */
    const r = await resolveFor(
      cartFor([
        { name: 'Gold', regulatoryClass: 'REGULAR', priceMinor: 15000 },
        { name: 'Lounger', regulatoryClass: 'RECLINER', priceMinor: 25000 },
      ]),
    );
    expect(r.resolution.status).not.toBe('POLICY_CONFIGURATION_ERROR');
    expect(r.resolution.status).not.toBe('POLICY_NOT_FOUND');
    // Still disclosed per head across both classes.
    expect(r.effect.maintenanceMinor).toBe(1000);
    expect(r.effect.maxOnlineFeeMinor).toBe(0);
  });

  it('still catches an over-ceiling line inside a mixed cart', async () => {
    const r = await resolveFor(
      cartFor([
        { name: 'Gold', regulatoryClass: 'REGULAR', priceMinor: 15100 },
        { name: 'Lounger', regulatoryClass: 'RECLINER', priceMinor: 25000 },
      ]),
    );
    expect(r.resolution.status).not.toBe('POLICY_CONFIGURATION_ERROR');
    expect(r.overCeiling).toHaveLength(1);
    expect(r.overCeiling[0].seatCategoryName).toBe('Gold');
  });
});

describe('seat categories the operator has not mapped', () => {
  it('refuses the sale and names the category, rather than selling it uncapped', async () => {
    const r = await resolveFor(
      cartFor([{ name: 'Platinum Executive', regulatoryClass: null, priceMinor: 90000 }]),
    );
    expect(r.resolution.status).toBe('INVALID_CINEMA_CLASSIFICATION');
    expect(r.resolution.explanation).toContain('Platinum Executive');
  });

  it('never infers a class from a name that happens to match one', async () => {
    // "Recliner" as a display name with no mapping is still unmapped. Reading the label would
    // be the exact inference the regulatoryClass column exists to prevent.
    const r = await resolveFor(
      cartFor([{ name: 'Recliner', regulatoryClass: null, priceMinor: 25000 }]),
    );
    expect(r.resolution.status).toBe('INVALID_CINEMA_CLASSIFICATION');
  });

  it('is not confused by a ticket type with no seat category at all', async () => {
    // An unseated ticket is not an unmapped seat. It must still price.
    const r = await resolveFor([
      { unitPriceMinor: 15000, quantity: 1, category: null, seatCategoryName: null },
    ]);
    expect(r.resolution.status).not.toBe('INVALID_CINEMA_CLASSIFICATION');
  });
});

describe('the maintenance charge', () => {
  it('is ₹5 per ticket and does NOT increase what the customer pays', async () => {
    const r = await resolveFor(
      cartFor([{ name: 'Gold', regulatoryClass: 'REGULAR', priceMinor: 15000, qty: 2 }]),
    );
    // Two tickets → ₹10 disclosed.
    expect(r.effect.maintenanceMinor).toBe(1000);
    // …and ₹0 added, because the order says it is already inside the ₹150.
    expect(r.effect.maintenanceAddedMinor).toBe(0);
  });

  it('scales per head, not per line', async () => {
    const r = await resolveFor(
      cartFor([{ name: 'Gold', regulatoryClass: 'REGULAR', priceMinor: 15000, qty: 3 }]),
    );
    expect(r.effect.maintenanceMinor).toBe(1500);
  });
});

describe('the online booking fee', () => {
  it('is capped at ZERO while the AP position is unresolved', async () => {
    const r = await resolveFor(
      cartFor([{ name: 'Gold', regulatoryClass: 'REGULAR', priceMinor: 15000 }]),
    );
    // REQUIRES_APPROVAL with no recorded cap. Reading that null as "unrestricted" would
    // apply the platform's ordinary convenience fee on top of a regulated rate.
    expect(r.effect.maxOnlineFeeMinor).toBe(0);
  });
});
