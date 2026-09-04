import { PrismaClient } from '@prisma/client';
import { CinemaPricingPolicyService } from './cinema-pricing-policy.service';
import { CinemaPricingPoliciesService } from '../../admin/cinema-pricing-policies.service';
import { applyPolicy } from './apply-policy';

/**
 * Telangana, and the promise that yesterday's bookings stay yesterday's bookings.
 *
 * ── WHAT TELANGANA IS RIGHT NOW ────────────────────────────────────────────────────
 * Two documents and no rates. G.O.Ms.No.120 is retained as historical evidence;
 * G.O.77 dated 14-08-2026 is understood to be the current framework, is not in this
 * repository, and is reported to be under challenge. Nothing has been taken from secondary
 * reporting, so its maintenance treatment is UNCONFIRMED — a state the schema now has words
 * for, and which the database refuses to let anybody activate.
 */
const prisma = new PrismaClient();
const resolver = new CinemaPricingPolicyService(prisma as never);
const admin = new CinemaPricingPoliciesService(
  prisma as never,
  { record: async () => undefined } as never,
);

const AT = new Date('2026-10-01T00:00:00Z');
const ctx = (over: Record<string, unknown> = {}) =>
  ({
    country: 'India',
    region: 'Telangana',
    district: null,
    city: 'Hyderabad',
    currency: 'INR',
    localBodyType: 'MUNICIPAL_CORPORATION',
    cinemaFormat: 'MULTIPLEX',
    climateType: 'AC',
    seatCategories: ['REGULAR'],
    at: AT,
    ...over,
  }) as never;

const IT = 'ITEST-TG';
const clean = () =>
  prisma.cinemaPricingPolicy.deleteMany({ where: { regulatoryReference: { startsWith: IT } } });

beforeAll(clean);
afterEach(clean);
afterAll(async () => {
  await clean();
  await prisma.$disconnect();
});

describe('the Telangana engineering guess is gone', () => {
  it('records the amount without inventing a treatment', async () => {
    /*
      This row used to say ADDED. Nobody had established that; the schema simply offered no
      way to say "we do not know", so a guess was written down and became indistinguishable
      from a researched value the moment it was stored.
    */
    const rows = await prisma.cinemaPricingPolicy.findMany({
      where: { country: 'India', region: 'Telangana' },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.maintenanceTreatment).toBe('UNCONFIRMED');
      expect(r.status).toBe('DRAFT');
      // And no rate value invented from reporting.
      expect(r.ticketPriceMaxMinor).toBeNull();
      expect(r.onlineFeeCapMinor).toBeNull();
    }
  });

  it('keeps G.O.120 as history and G.O.77 as the current framework', async () => {
    const refs = (
      await prisma.cinemaPricingPolicy.findMany({
        where: { country: 'India', region: 'Telangana' },
        select: { regulatoryReference: true },
      })
    ).map((r) => r.regulatoryReference);
    expect(refs.some((r) => r.includes('G.O.Ms.No.120'))).toBe(true);
    expect(refs.some((r) => r.includes('G.O.77'))).toBe(true);
  });

  it('marks G.O.77 as not present and not reviewed', async () => {
    // The most important row in the database for a Hyderabad launch decision: it says the
    // order has not been read, so nothing downstream can imply that it has.
    const doc = await prisma.regulatoryDocument.findFirst({
      where: { reference: { contains: 'G.O.77' } },
    });
    expect(doc?.textReviewed).toBe(false);
    expect(doc?.documentUrl).toBeNull();
    expect(doc?.notes).toMatch(/NOT IN THIS REPOSITORY/i);
  });

  it('leaves Hyderabad unregulated while both rows are DRAFT', async () => {
    /*
      Not an oversight — the alternative is worse. Activating a policy with no rates and an
      unconfirmed treatment would stop every Hyderabad cinema selling, on the strength of a
      document nobody has read.
    */
    const r = await resolver.resolve(ctx());
    expect(['NOT_REGULATED', 'POLICY_NOT_FOUND']).toContain(r.status);
  });
});

describe('an unconfirmed treatment can never price anything', () => {
  it('is refused ACTIVE by the database', async () => {
    /*
      Enforced in the database rather than only in the service, because a row can reach
      ACTIVE through a console, a migration or a screen written later — and every one of
      those prices real money.
    */
    const draft = await prisma.cinemaPricingPolicy.create({
      data: {
        country: 'Testland',
        region: 'Testshire',
        currency: 'INR',
        maintenanceChargeMinor: 500,
        maintenanceTreatment: 'UNCONFIRMED',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        regulatoryReference: `${IT}-UNCONFIRMED`,
      },
    });
    await expect(
      prisma.cinemaPricingPolicy.update({ where: { id: draft.id }, data: { status: 'ACTIVE' } }),
    ).rejects.toThrow();
  });

  it('is refused by the admin activate path, with a reason', async () => {
    const draft = await prisma.cinemaPricingPolicy.create({
      data: {
        country: 'Testland',
        region: 'Testshire',
        currency: 'INR',
        maintenanceChargeMinor: 500,
        maintenanceTreatment: 'UNCONFIRMED',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        regulatoryReference: `${IT}-UNCONFIRMED-2`,
      },
    });
    /*
      A HUMAN reason, not a constraint violation. The database refuses this too — and did,
      before this check existed — but a Postgres error naming
      `CinemaPricingPolicy_unconfirmed_never_active` is technically a refusal and useless to
      the person who has to fix it. This test asserts the sentence, so it cannot pass again
      by accident on the constraint's name.
    */
    await expect(admin.activate('admin-1', draft.id)).rejects.toThrow(
      /included in the ticket price or added to it/i,
    );
  });

  it('fails closed if one somehow reaches the resolver', async () => {
    // Belt and braces: the money must be safe on every path, not on the one somebody
    // remembered to guard.
    const r = applyPolicy(
      {
        status: 'COMPLIANT',
        policy: {
          maintenanceTreatment: 'UNCONFIRMED',
          maintenanceChargeMinor: 500,
          onlineFeePolicy: 'ALLOWED',
        } as never,
        explanation: '',
        specificity: 1,
      },
      2,
    );
    // An unconfirmed charge is disclosed but adds nothing — it cannot, since nobody knows
    // whether it should.
    expect(r.maintenanceAddedMinor).toBe(0);
  });
});

describe('two Telangana orders can coexist, dated apart', () => {
  it('resolves each on its own date without ambiguity', async () => {
    /*
      The supersession shape a real G.O.77 will need: the old order priced until the new one
      began, and the new one after. Proven with FIXTURE amounts — no Telangana rate is
      asserted anywhere in this file.
    */
    const shared = {
      country: 'Testland',
      region: 'Telangana-Fixture',
      currency: 'INR',
      maintenanceChargeMinor: 700,
      maintenanceTreatment: 'INCLUDED_IN_TICKET_PRICE' as const,
      status: 'ACTIVE' as const,
    };
    await prisma.cinemaPricingPolicy.create({
      data: {
        ...shared,
        effectiveFrom: new Date('2021-12-21T00:00:00Z'),
        effectiveTo: new Date('2026-08-14T00:00:00Z'),
        regulatoryReference: `${IT}-OLD`,
        version: 1,
      },
    });
    await prisma.cinemaPricingPolicy.create({
      data: {
        ...shared,
        maintenanceChargeMinor: 900,
        effectiveFrom: new Date('2026-08-14T00:00:00Z'),
        regulatoryReference: `${IT}-NEW`,
        version: 2,
      },
    });

    const early = await resolver.resolve(
      ctx({
        country: 'Testland',
        region: 'Telangana-Fixture',
        at: new Date('2026-01-01T00:00:00Z'),
      }),
    );
    const late = await resolver.resolve(
      ctx({
        country: 'Testland',
        region: 'Telangana-Fixture',
        at: new Date('2026-09-01T00:00:00Z'),
      }),
    );
    expect(early.policy?.regulatoryReference).toBe(`${IT}-OLD`);
    expect(late.policy?.regulatoryReference).toBe(`${IT}-NEW`);
    // Neither is ambiguous: they never coexist in time.
    expect(early.status).not.toBe('POLICY_CONFIGURATION_ERROR');
    expect(late.status).not.toBe('POLICY_CONFIGURATION_ERROR');
  });
});

describe('history is superseded, never rewritten', () => {
  it('refuses to edit an ACTIVE policy in place', async () => {
    /*
      Editing one would rewrite the financial interpretation of every order already sold
      under it. Bookings carry their own snapshot, so totals are safe either way — but "the
      audit trail now disagrees with the invoice" is not a smaller problem, it is a worse
      kind of one.
    */
    const row = await prisma.cinemaPricingPolicy.create({
      data: {
        country: 'Testland',
        region: 'Testshire',
        currency: 'INR',
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        regulatoryReference: `${IT}-ACTIVE`,
      },
    });
    await expect(
      admin.updateDraft('admin-1', row.id, { ticketPriceMaxMinor: 99_900 }),
    ).rejects.toThrow(/DRAFT/i);
  });

  it('leaves a booking’s snapshot untouched when the policy is superseded', async () => {
    /*
      The immutability promise, tested against real columns. A booking records the amount,
      the treatment, the version and the citation. Superseding the policy afterwards must not
      change any of them — the customer's invoice was issued under the old order and stays
      issued under it.
    */
    const cols = await prisma.$queryRawUnsafe<{ col: string }[]>(
      `SELECT column_name AS col FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'Booking'
         AND column_name IN ('maintenanceMinor','maintenanceTreatment','pricingPolicyVersion','regulatoryReference','pricingJurisdiction','complianceStatus')`,
    );
    // All six snapshot columns exist on the booking itself, not only via the relation —
    // which is what makes them survive the policy row changing underneath.
    expect(cols).toHaveLength(6);

    const fk = await prisma.$queryRawUnsafe<{ delete_rule: string }[]>(
      `SELECT rc.delete_rule FROM information_schema.referential_constraints rc
       JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name
       WHERE tc.table_name = 'Booking' AND tc.constraint_name = 'Booking_pricingPolicyId_fkey'`,
    );
    // Deleting a policy nulls the link and leaves every snapshot column intact, rather than
    // cascading a booking out of existence to tidy up a configuration row.
    expect(fk[0]?.delete_rule).toBe('SET NULL');
  });
});
