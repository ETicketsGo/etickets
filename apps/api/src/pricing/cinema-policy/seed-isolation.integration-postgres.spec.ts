import { PrismaClient } from '@prisma/client';

/**
 * The canonical seeded policies are nobody's fixture.
 *
 * ── THE FAILURE THIS PREVENTS ──────────────────────────────────────────────────────
 * A suite testing the Andhra Pradesh rate table flipped the real seeded rows to ACTIVE in
 * `beforeAll` and back in `afterAll`. Jest runs suites in PARALLEL against one database, so
 * while it ran, a different suite asserting "the seed ships DRAFT" saw 41 active rows and
 * failed. Nothing was wrong with the code under test in either file.
 *
 * That is the worst kind of failure to leave lying around: it is intermittent, it accuses an
 * innocent assertion, and the cheapest way to make it stop is to delete the assertion — which
 * is exactly the assertion protecting a jurisdiction from being switched on by accident.
 *
 * Suites that need ACTIVE policies now CLONE the rows into a country only they use, copying
 * the values so they still verify the real transcription. This file states the invariant they
 * are protecting, so that if anyone reverts to mutating the canonical rows, the thing that
 * fails is a test whose name says what the rule is.
 */
const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the canonical India policy rows', () => {
  it('are all DRAFT — no suite may leave a jurisdiction switched on', async () => {
    const active = await prisma.cinemaPricingPolicy.count({
      where: { country: 'India', status: { not: 'DRAFT' } },
    });
    expect(active).toBe(0);
  });

  it('are 41 for Andhra Pradesh and 2 for Telangana — no suite may add or delete them', async () => {
    const ap = await prisma.cinemaPricingPolicy.count({
      where: { country: 'India', region: 'Andhra Pradesh' },
    });
    const tg = await prisma.cinemaPricingPolicy.count({
      where: { country: 'India', region: 'Telangana' },
    });
    expect({ ap, tg }).toEqual({ ap: 41, tg: 2 });
  });

  it('still record Telangana with no monetary value of any kind', async () => {
    /*
      This assertion caught a real one. Both Telangana rows carried ₹5 maintenance, taken from
      the constant the seed uses for ANDHRA PRADESH's G.O.Ms.No.13 — an Andhra Pradesh figure
      standing in for a Telangana one, on the row for an order nobody has read. Zero here is
      the absence of a figure, not a claim that Telangana charges nothing; UNCONFIRMED
      alongside it says which.
    */
    const tg = await prisma.cinemaPricingPolicy.findMany({
      where: { country: 'India', region: 'Telangana' },
    });
    expect(tg).toHaveLength(2);
    for (const row of tg) {
      expect(row.ticketPriceMaxMinor).toBeNull();
      expect(row.ticketPriceMinMinor).toBeNull();
      expect(row.onlineFeeCapMinor).toBeNull();
      expect(row.maintenanceChargeMinor).toBe(0);
      expect(row.maintenanceTreatment).toBe('UNCONFIRMED');
    }
  });

  it('keep textReviewed false, because nobody has read the orders yet', async () => {
    const reviewed = await prisma.regulatoryDocument.count({
      where: { country: 'India', textReviewed: true },
    });
    // If this ever fails, somebody has marked an order as verified. That is a real event and
    // should be a deliberate commit, not a side effect of running a test suite.
    expect(reviewed).toBe(0);
  });
});
