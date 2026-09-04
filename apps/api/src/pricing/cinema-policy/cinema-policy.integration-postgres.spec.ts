import { PrismaClient } from '@prisma/client';
import { CinemaPricingPolicyService } from './cinema-pricing-policy.service';
import { applyPolicy } from './apply-policy';

/**
 * The parts a unit test cannot prove.
 *
 * ── WHY REAL POSTGRES ──────────────────────────────────────────────────────────────
 * Three things here exist only in the database and would pass against a mock while being
 * wrong in production: the CHECK constraints that stop a half-written policy being stored at
 * all, the enum values actually created by the migration, and the fact that the service's
 * own query returns rows the pure resolver then agrees with. A mocked Prisma would accept a
 * CAPPED policy with no cap and prove nothing.
 *
 * Every amount below is a FIXTURE. No government order is encoded in this file.
 */
const prisma = new PrismaClient();
const service = new CinemaPricingPolicyService(prisma as never);

/** Namespaced so a failed run cannot leave rows that price a later test. */
const REF = 'ITEST-CINEMA-POLICY';
const AT = new Date('2026-06-01T00:00:00Z');

const base = {
  country: 'Testland',
  region: '*',
  district: '*',
  city: '*',
  currency: 'INR',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  regulatoryReference: REF,
};

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    country: 'Testland',
    region: 'Testshire',
    district: null,
    city: 'Testville',
    currency: 'INR',
    localBodyType: null,
    cinemaFormat: null,
    climateType: 'AC',
    seatCategories: ['GOLD'],
    at: AT,
    ...over,
  }) as never;

const clean = () => prisma.cinemaPricingPolicy.deleteMany({ where: { regulatoryReference: REF } });

beforeAll(clean);
afterEach(clean);
afterAll(async () => {
  await clean();
  await prisma.$disconnect();
});

describe('the database refuses a half-written policy', () => {
  it('rejects a CAPPED policy with no cap', async () => {
    /*
      An unlimited fee wearing a limit's name — worse than no policy, because it LOOKS
      configured. The service refuses it too; both, because a row inserted by a migration, a
      console or a future admin screen still prices real orders.
    */
    await expect(
      prisma.cinemaPricingPolicy.create({
        data: { ...base, onlineFeePolicy: 'CAPPED', onlineFeeCapMinor: null },
      }),
    ).rejects.toThrow();
  });

  it('rejects a maintenance charge with no treatment', async () => {
    // An amount nobody said how to apply cannot be applied. Silently ignoring it would
    // under-collect; silently adding it would over-charge.
    await expect(
      prisma.cinemaPricingPolicy.create({
        data: { ...base, maintenanceChargeMinor: 500, maintenanceTreatment: 'NOT_APPLICABLE' },
      }),
    ).rejects.toThrow();
  });

  it('rejects a treatment with no amount', async () => {
    await expect(
      prisma.cinemaPricingPolicy.create({
        data: {
          ...base,
          maintenanceChargeMinor: 0,
          maintenanceTreatment: 'ADDED_TO_TICKET_PRICE',
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects an inverted price band and an inverted effective window', async () => {
    await expect(
      prisma.cinemaPricingPolicy.create({
        data: { ...base, ticketPriceMinMinor: 20_000, ticketPriceMaxMinor: 10_000 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.cinemaPricingPolicy.create({
        data: { ...base, effectiveTo: new Date('2025-01-01T00:00:00Z') },
      }),
    ).rejects.toThrow();
  });

  it('accepts a coherent policy', async () => {
    const row = await prisma.cinemaPricingPolicy.create({
      data: {
        ...base,
        maintenanceChargeMinor: 700,
        maintenanceTreatment: 'ADDED_TO_TICKET_PRICE',
        onlineFeePolicy: 'CAPPED',
        onlineFeeCapMinor: 2_500,
      },
    });
    expect(row.status).toBe('DRAFT');
  });
});

describe('resolution against real rows', () => {
  it('ignores DRAFT policies entirely', async () => {
    /*
      The whole point of a draft. A policy being written must not start pricing orders
      halfway through being written, and this is the only test that proves the service's
      own WHERE clause says so — the pure resolver is handed pre-filtered rows.
    */
    await prisma.cinemaPricingPolicy.create({
      data: { ...base, region: 'Testshire', status: 'DRAFT' },
    });
    expect((await service.resolve(ctx())).status).toBe('NOT_REGULATED');
  });

  it('ignores SUPERSEDED and DISABLED policies', async () => {
    await prisma.cinemaPricingPolicy.create({
      data: { ...base, region: 'Testshire', status: 'SUPERSEDED' },
    });
    await prisma.cinemaPricingPolicy.create({
      data: { ...base, region: 'Testshire', city: 'Testville', status: 'DISABLED' },
    });
    expect((await service.resolve(ctx())).status).toBe('NOT_REGULATED');
  });

  it('resolves an ACTIVE policy and computes the charge per ticket', async () => {
    await prisma.cinemaPricingPolicy.create({
      data: {
        ...base,
        region: 'Testshire',
        climateType: 'AC',
        maintenanceChargeMinor: 700,
        maintenanceTreatment: 'ADDED_TO_TICKET_PRICE',
        status: 'ACTIVE',
      },
    });
    const resolution = await service.resolve(ctx());
    expect(resolution.status).toBe('REQUIRES_APPROVAL'); // default fee posture
    const effect = applyPolicy(resolution, 2);
    expect(effect.maintenanceMinor).toBe(1_400);
    expect(effect.maintenanceAddedMinor).toBe(1_400);
    // And no platform fee may be charged on an unconfirmed position.
    expect(effect.maxOnlineFeeMinor).toBe(0);
  });

  it('FAILS CLOSED for a regulated country with no matching row', async () => {
    await prisma.cinemaPricingPolicy.create({
      data: { ...base, region: 'Testshire', status: 'ACTIVE' },
    });
    const r = await service.resolve(ctx({ region: 'Elsewhere' }));
    expect(r.status).toBe('POLICY_NOT_FOUND');
    // Absence of a rule is never permission.
    expect(applyPolicy(r, 1).maxOnlineFeeMinor).toBe(0);
  });

  it('picks the policy in force on the business date, from real rows', async () => {
    await prisma.cinemaPricingPolicy.create({
      data: {
        ...base,
        region: 'Testshire',
        status: 'ACTIVE',
        maintenanceChargeMinor: 700,
        maintenanceTreatment: 'ADDED_TO_TICKET_PRICE',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        effectiveTo: new Date('2026-10-01T00:00:00Z'),
      },
    });
    await prisma.cinemaPricingPolicy.create({
      data: {
        ...base,
        region: 'Testshire',
        status: 'ACTIVE',
        maintenanceChargeMinor: 900,
        maintenanceTreatment: 'ADDED_TO_TICKET_PRICE',
        effectiveFrom: new Date('2026-10-01T00:00:00Z'),
      },
    });
    const before = applyPolicy(
      await service.resolve(ctx({ at: new Date('2026-06-01T00:00:00Z') })),
      1,
    );
    const after = applyPolicy(
      await service.resolve(ctx({ at: new Date('2026-11-01T00:00:00Z') })),
      1,
    );
    expect(before.maintenanceMinor).toBe(700);
    expect(after.maintenanceMinor).toBe(900);
  });

  it('refuses two equally specific ACTIVE rows rather than picking one', async () => {
    /*
      The database cannot express "no two ACTIVE policies may overlap in scope" as a unique
      index — the scopes are ranges and wildcards, not values. So the service refuses at
      resolution time, and this proves it does so against rows that really are both stored.
    */
    await prisma.cinemaPricingPolicy.create({
      data: { ...base, region: 'Testshire', status: 'ACTIVE', regulatoryReference: `${REF}` },
    });
    await prisma.cinemaPricingPolicy.create({
      data: { ...base, region: 'Testshire', status: 'ACTIVE', regulatoryReference: `${REF}` },
    });
    const r = await service.resolve(ctx());
    expect(r.status).toBe('POLICY_CONFIGURATION_ERROR');
    expect(applyPolicy(r, 1).maxOnlineFeeMinor).toBe(0);
  });
});

describe('the seeded India policies', () => {
  it('ship as DRAFT, so activating India is a deliberate act', async () => {
    /*
      Not a test of the seed script — a test of the posture. If these ever arrive ACTIVE from
      a deploy, every unclassified Indian cinema stops selling that afternoon, and the person
      who ran the deploy did not choose that.
    */
    const active = await prisma.cinemaPricingPolicy.count({
      where: { country: 'India', status: 'ACTIVE' },
    });
    expect(active).toBe(0);
  });

  it('carry AP ceilings from a cited order, and NOTHING for Telangana', async () => {
    /*
      This assertion used to be "no policy records any ceiling", which was true when no rate
      table had been transcribed and became wrong the moment one was. The point was never
      "no numbers" — it was "no INVENTED numbers", and the two states are now in different
      epistemic positions:

        Andhra Pradesh — a rate table exists, transcribed from a brief citing G.O.Ms.No.13.
        Telangana      — G.O.77 is not in this repository, so no rate, cap or treatment.

      No online-fee cap exists for either, because neither state's position on what a
      third-party platform may charge has been established.
    */
    const rows = await prisma.cinemaPricingPolicy.findMany({ where: { country: 'India' } });
    expect(rows.length).toBeGreaterThan(0);

    const ap = rows.filter((r) => r.region === 'Andhra Pradesh');
    const tg = rows.filter((r) => r.region === 'Telangana');

    expect(ap.some((r) => r.ticketPriceMaxMinor !== null)).toBe(true);
    for (const r of ap) {
      expect(r.regulatoryReference).toContain('G.O.Ms.No.13');
      expect(r.maintenanceTreatment).toBe('INCLUDED_IN_TICKET_PRICE');
    }

    for (const r of tg) {
      expect(r.ticketPriceMaxMinor).toBeNull();
      expect(r.ticketPriceMinMinor).toBeNull();
      expect(r.maintenanceTreatment).toBe('UNCONFIRMED');
    }

    // Neither state, at any specificity, records a cap on the online booking fee.
    for (const r of rows) {
      expect(r.onlineFeeCapMinor).toBeNull();
      expect(r.onlineFeePolicy).toBe('REQUIRES_APPROVAL');
    }
  });
});
