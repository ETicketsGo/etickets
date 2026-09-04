import { PrismaClient } from '@prisma/client';
import { CinemaPricingPolicyService } from './cinema-pricing-policy.service';
import { applyPolicy, checkTicketPrice } from './apply-policy';

/**
 * The Andhra Pradesh rate table, against the rows actually stored.
 *
 * ── WHY THIS IS THE POSTGRES SUITE AND NOT A UNIT TEST ─────────────────────────────
 * These assertions are about CONFIGURATION, not about logic. The resolver's own tests use
 * invented fixtures precisely so no test becomes the place the law lives; this file does the
 * opposite job — it reads the rows the seed wrote and checks the transcription. A fixture
 * here would prove the seed correct by restating it.
 *
 * ── VIJAYAWADA ─────────────────────────────────────────────────────────────────────
 * Vijayawada is a Municipal Corporation, so that slab is the one the first rollout runs on
 * and it gets the most attention below.
 *
 * ── WHAT THESE TESTS CANNOT ESTABLISH ──────────────────────────────────────────────
 * That the numbers match G.O.Ms.No.13. They match the brief the numbers were transcribed
 * from. The order is not in this repository and `RegulatoryDocument.textReviewed` says so.
 */
const prisma = new PrismaClient();
const service = new CinemaPricingPolicyService(prisma as never);

const AT = new Date('2026-10-01T00:00:00Z');

/**
 * ── WHY THIS SUITE COPIES THE SEEDED ROWS INSTEAD OF ACTIVATING THEM ───────────────
 * It used to flip the real Andhra Pradesh rows to ACTIVE and back. Jest runs suites in
 * parallel workers against ONE database, so another suite asserting "the seeded India
 * policies ship as DRAFT" saw 41 active rows and failed — a false alarm caused entirely by
 * this file, and the kind that gets a real assertion deleted for being "flaky".
 *
 * So the rows are CLONED into a test-only country and activated there. The values are copied
 * from the seeded rows rather than restated, so this still verifies the transcription — it
 * just stops one suite reaching into another's state to do it.
 */
const apWhere = { country: 'India', region: 'Andhra Pradesh' };
const TEST_COUNTRY = 'IndiaRateTableTest';

beforeAll(async () => {
  await prisma.cinemaPricingPolicy.deleteMany({ where: { country: TEST_COUNTRY } });
  const seeded = await prisma.cinemaPricingPolicy.findMany({ where: apWhere });
  if (seeded.length === 0) throw new Error('AP policies are not seeded; run the seed first.');
  for (const row of seeded) {
    const { id: _id, createdAt: _c, updatedAt: _u, supersedesId: _s, ...values } = row;
    await prisma.cinemaPricingPolicy.create({
      data: { ...values, country: TEST_COUNTRY, status: 'ACTIVE' },
    });
  }
});
afterAll(async () => {
  await prisma.cinemaPricingPolicy.deleteMany({ where: { country: TEST_COUNTRY } });
  await prisma.$disconnect();
});

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    country: TEST_COUNTRY,
    region: 'Andhra Pradesh',
    district: null,
    city: 'Vijayawada',
    currency: 'INR',
    localBodyType: 'MUNICIPAL_CORPORATION',
    cinemaFormat: 'MULTIPLEX',
    climateType: 'AC',
    seatCategories: ['REGULAR'],
    at: AT,
    ...over,
  }) as never;

describe('Vijayawada — Municipal Corporation multiplex', () => {
  it('permits a regular ticket at exactly ₹150', async () => {
    // The rollout case. Inclusive bound: "up to ₹150" includes ₹150.
    const r = await service.resolve(ctx());
    expect(checkTicketPrice(r, 15_000).ok).toBe(true);
  });

  it('refuses ₹151, and names the order it broke', async () => {
    const r = await service.resolve(ctx());
    const check = checkTicketPrice(r, 15_100);
    expect(check.ok).toBe(false);
    expect(check.status).toBe('PRICE_EXCEEDS_LIMIT');
    expect(check.reason).toContain('G.O.Ms.No.13');
  });

  it('permits a recliner at ₹250', async () => {
    const r = await service.resolve(ctx({ seatCategories: ['RECLINER'] }));
    expect(checkTicketPrice(r, 25_000).ok).toBe(true);
    expect(checkTicketPrice(r, 25_100).ok).toBe(false);
  });

  it('holds a regular ticket to ₹150 even in a recliner-capable hall', async () => {
    /*
      Both classes exist in one multiplex. The rule matched must be the one for the seat
      being sold — otherwise every regular seat in a recliner hall silently gains a ₹100
      ceiling it is not entitled to.
    */
    const r = await service.resolve(ctx({ seatCategories: ['REGULAR'] }));
    expect(checkTicketPrice(r, 25_000).ok).toBe(false);
  });
});

describe('the Municipal Corporation slab, across classifications', () => {
  const cases: [string, Record<string, unknown>, number][] = [
    [
      'AC single screen, non-premium',
      { cinemaFormat: 'SINGLE_SCREEN', climateType: 'AC', seatCategories: ['NON_PREMIUM'] },
      7_000,
    ],
    [
      'AC single screen, premium',
      { cinemaFormat: 'SINGLE_SCREEN', climateType: 'AC', seatCategories: ['PREMIUM'] },
      10_000,
    ],
    [
      'non-AC single screen, non-premium',
      { cinemaFormat: 'SINGLE_SCREEN', climateType: 'NON_AC', seatCategories: ['NON_PREMIUM'] },
      4_000,
    ],
    [
      'non-AC single screen, premium',
      { cinemaFormat: 'SINGLE_SCREEN', climateType: 'NON_AC', seatCategories: ['PREMIUM'] },
      6_000,
    ],
    [
      'special theatre, non-premium',
      { cinemaFormat: 'SPECIAL_THEATRE', climateType: null, seatCategories: ['NON_PREMIUM'] },
      10_000,
    ],
    [
      'special theatre, premium',
      { cinemaFormat: 'SPECIAL_THEATRE', climateType: null, seatCategories: ['PREMIUM'] },
      12_500,
    ],
  ];

  it.each(cases)(
    '%s permits exactly its rate and refuses one rupee more',
    async (_label, over, max) => {
      const r = await service.resolve(ctx(over));
      expect(checkTicketPrice(r, max).ok).toBe(true);
      expect(checkTicketPrice(r, max + 100).ok).toBe(false);
    },
  );
});

describe('the smaller local bodies', () => {
  it('prices a Municipality lower than a Corporation for the same hall', async () => {
    // ₹125 against ₹150. The classification is what moves it, not the city's name.
    const muni = await service.resolve(ctx({ localBodyType: 'MUNICIPALITY' }));
    expect(checkTicketPrice(muni, 12_500).ok).toBe(true);
    expect(checkTicketPrice(muni, 15_000).ok).toBe(false);
  });

  it('prices a Nagar Panchayat lower again', async () => {
    const np = await service.resolve(ctx({ localBodyType: 'NAGAR_PANCHAYAT' }));
    expect(checkTicketPrice(np, 10_000).ok).toBe(true);
    expect(checkTicketPrice(np, 10_100).ok).toBe(false);
  });

  it('gives a Gram Panchayat its own rows rather than borrowing them', async () => {
    // Two local-body types share one column in the brief; each is written out, so removing
    // one later cannot silently reprice the other.
    const gp = await service.resolve(ctx({ localBodyType: 'GRAM_PANCHAYAT' }));
    expect(gp.policy).not.toBeNull();
    expect(checkTicketPrice(gp, 10_000).ok).toBe(true);
  });

  it('records NO recliner ceiling where the brief gave none', async () => {
    /*
      Nagar/Gram Panchayat multiplexes have a regular rate and no recliner rate in the brief.
      An absent rate stays absent: inheriting ₹250 from a Municipal Corporation would be an
      invention, and one that permits a HIGHER price than anything recorded.
    */
    const r = await service.resolve(
      ctx({ localBodyType: 'GRAM_PANCHAYAT', seatCategories: ['RECLINER'] }),
    );
    // Falls through to the maintenance-only row, which states no ceiling at all.
    expect(r.policy?.ticketPriceMaxMinor ?? null).toBeNull();
  });
});

describe('maintenance under the AP order', () => {
  it('is ₹5 in a cooled hall, included, and does NOT raise the total', async () => {
    /*
      The order states the rate is INCLUSIVE of maintenance. A ₹150 ticket stays ₹150; the
      ₹5 is disclosed, never added. Adding it would raise every regulated price in the state
      by the charge, on every order.
    */
    const r = await service.resolve(ctx());
    const effect = applyPolicy(r, 1);
    expect(effect.maintenanceMinor).toBe(500);
    expect(effect.maintenanceTreatment).toBe('INCLUDED_IN_TICKET_PRICE');
    expect(effect.maintenanceAddedMinor).toBe(0);
  });

  it('is ₹3 in a non-AC hall, also included', async () => {
    const r = await service.resolve(
      ctx({
        cinemaFormat: 'SINGLE_SCREEN',
        climateType: 'NON_AC',
        seatCategories: ['NON_PREMIUM'],
      }),
    );
    const effect = applyPolicy(r, 1);
    expect(effect.maintenanceMinor).toBe(300);
    expect(effect.maintenanceAddedMinor).toBe(0);
  });

  it('counts two tickets as two charges while still adding nothing', async () => {
    // Disclosed per head — ₹10 for two — and still zero on top of the subtotal.
    const effect = applyPolicy(await service.resolve(ctx()), 2);
    expect(effect.maintenanceMinor).toBe(1_000);
    expect(effect.maintenanceAddedMinor).toBe(0);
  });

  it('resolves maintenance even when the seat class is unrecognised', async () => {
    /*
      An organizer names a category "Gold". No rate row matches it, and in a regulated market
      an unmatched order FAILS CLOSED — a customer unable to buy because of a category name.
      The maintenance-only fallback catches it: correct charge, no ceiling, and the organizer
      panel says the ceiling could not be matched.
    */
    const r = await service.resolve(ctx({ seatCategories: ['GOLD'] }));
    expect(r.policy).not.toBeNull();
    expect(applyPolicy(r, 1).maintenanceMinor).toBe(500);
    expect(r.policy?.ticketPriceMaxMinor ?? null).toBeNull();
  });
});

describe('the AP online booking fee', () => {
  it('charges NOTHING, and a null cap is not permission', async () => {
    /*
      The regression this exists for. The order says the rate is inclusive of online service
      charges; what ETicketsGo may charge as a third party is unanswered. `onlineFeeCapMinor`
      is null — and null in this column must never be read as "unrestricted", which is the
      reading that would apply the standard ₹5/₹10/₹15/₹20 schedule on top of a regulated
      rate in a state that says the rate already includes it.
    */
    const r = await service.resolve(ctx());
    expect(r.status).toBe('REQUIRES_APPROVAL');
    expect(r.policy?.onlineFeeCapMinor).toBeNull();
    expect(applyPolicy(r, 1).maxOnlineFeeMinor).toBe(0);
  });

  it('still sells the ticket', async () => {
    // Charging nothing cannot overcharge anybody. Refusing to sell in the whole state over
    // an unconfirmed fee schedule would be the larger harm.
    expect((await service.resolve(ctx())).policy).not.toBeNull();
  });
});

describe('provenance is recorded, including what was not read', () => {
  it('cites the actual order rather than a placeholder', async () => {
    const row = await prisma.cinemaPricingPolicy.findFirst({ where: apWhere });
    expect(row?.regulatoryReference).toContain('G.O.Ms.No.13');
    expect(row?.regulatoryReference).not.toMatch(/NOT YET RECORDED/i);
  });

  it('marks the order as NOT text-reviewed, because it has not been', async () => {
    /*
      The honest half. Every rate above came from a brief citing the order, not from the
      order. That is a different epistemic state and a launch decision has to be able to see
      it — which it cannot if the only record is a citation that looks equally authoritative
      either way.
    */
    const doc = await prisma.regulatoryDocument.findFirst({
      where: { reference: { contains: 'G.O.Ms.No.13' } },
    });
    expect(doc).not.toBeNull();
    expect(doc?.textReviewed).toBe(false);
    expect(doc?.documentUrl).toBeNull();
  });

  it('shares one document row across every AP rule', async () => {
    // ~41 rows, one citation. Retyping it per row guarantees that one day forty say one
    // thing and the forty-first says another, with no way to tell which is the typo.
    const rows = await prisma.cinemaPricingPolicy.findMany({ where: apWhere });
    const docIds = new Set(rows.map((r) => r.regulatoryDocumentId));
    expect(docIds.size).toBe(1);
    expect(rows.length).toBeGreaterThan(30);
  });
});
