import { PrismaClient } from '@prisma/client';
import { CinemaPricingPoliciesService } from './cinema-pricing-policies.service';

/**
 * What must be true before a policy is allowed to price real money.
 *
 * ── WHY THIS IS A GATE AND NOT A VALIDATION ────────────────────────────────────────
 * Activation is the single moment a jurisdiction starts being enforced: from then on every
 * cinema in scope must resolve a policy, and unclassified ones stop selling. A row that is
 * merely well-formed is not the same as a row anybody has checked against a government order,
 * and the difference is invisible once it is ACTIVE.
 *
 * The check that matters most is `textReviewed`. Andhra Pradesh's rates were transcribed from
 * a brief citing G.O.Ms.No.13, not from the order text. That is a fine state for QA and an
 * unacceptable one for production, where the platform would be enforcing prices against
 * customers that nobody has read from the source.
 */
const prisma = new PrismaClient();

const audit = { record: async () => undefined } as never;
const service = new CinemaPricingPoliciesService(prisma as never, audit);

const REF = 'ACTIVATION-GATE-TEST ORDER';
const COUNTRY = 'ActivationGateTestLand';

let documentId: string;

const draft = async (over: Record<string, unknown> = {}) =>
  prisma.cinemaPricingPolicy.create({
    data: {
      country: COUNTRY,
      region: 'Test Region',
      district: '*',
      city: '*',
      currency: 'INR',
      status: 'DRAFT',
      effectiveFrom: new Date('2020-01-01'),
      regulatoryReference: REF,
      regulatoryDocumentId: documentId,
      maintenanceChargeMinor: 0,
      maintenanceTreatment: 'NOT_APPLICABLE',
      onlineFeePolicy: 'ALLOWED',
      ...over,
    },
  });

const codes = async (id: string) =>
  (await service.activationPreflight(id)).blockers.map((b) => b.code);

beforeAll(async () => {
  await prisma.cinemaPricingPolicy.deleteMany({ where: { country: COUNTRY } });
  await prisma.regulatoryDocument.deleteMany({ where: { reference: REF } });
  const doc = await prisma.regulatoryDocument.create({
    data: {
      reference: REF,
      country: 'ActivationGateTestLand',
      region: 'Test Region',
      textReviewed: true,
      notes: 'fixture',
    },
  });
  documentId = doc.id;
});

afterEach(async () => {
  await prisma.cinemaPricingPolicy.deleteMany({ where: { country: COUNTRY } });
});

afterAll(async () => {
  await prisma.cinemaPricingPolicy.deleteMany({ where: { country: COUNTRY } });
  await prisma.regulatoryDocument.deleteMany({ where: { reference: REF } });
  await prisma.$disconnect();
});

describe('the activation gate', () => {
  it('lets a complete, reviewed policy through', async () => {
    const p = await draft();
    const result = await service.activationPreflight(p.id);
    expect(result.blockers).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('refuses a policy that names no order', async () => {
    const p = await draft({ regulatoryReference: '   ' });
    expect(await codes(p.id)).toContain('NO_REFERENCE');
  });

  it('refuses an unconfirmed maintenance treatment', async () => {
    const p = await draft({ maintenanceChargeMinor: 500, maintenanceTreatment: 'UNCONFIRMED' });
    expect(await codes(p.id)).toContain('MAINTENANCE_UNCONFIRMED');
  });

  /*
    The next two were written as preflight tests and could not be: the DATABASE refuses these
    rows outright, so they cannot be stored long enough to be checked. That is a stronger
    guarantee than the service check, and worth pinning down as the real one — the equivalent
    blockers in `activationPreflight` stay as defence in depth for any row that reaches ACTIVE
    by another route, but nothing can create one here.
  */
  it('cannot even STORE an amount alongside "maintenance does not apply"', async () => {
    await expect(
      draft({ maintenanceChargeMinor: 500, maintenanceTreatment: 'NOT_APPLICABLE' }),
    ).rejects.toThrow();
  });

  it('cannot even STORE a CAPPED fee with no cap — a null cap reads as unlimited', async () => {
    await expect(draft({ onlineFeePolicy: 'CAPPED', onlineFeeCapMinor: null })).rejects.toThrow();
  });

  it('accepts REQUIRES_APPROVAL with no cap, which is a resolved position', async () => {
    const p = await draft({ onlineFeePolicy: 'REQUIRES_APPROVAL', onlineFeeCapMinor: null });
    expect(await codes(p.id)).not.toContain('CAP_MISSING');
  });

  it('refuses a seat-class rate row with no maximum price', async () => {
    // Otherwise the row silently permits any price for that class — the opposite of a rate.
    const p = await draft({ seatCategory: 'REGULAR', ticketPriceMaxMinor: null });
    expect(await codes(p.id)).toContain('NO_CEILING');
  });

  it('refuses anything that is not a DRAFT', async () => {
    const p = await draft({ status: 'DISABLED' });
    expect(await codes(p.id)).toContain('NOT_DRAFT');
  });

  it('reports every blocker at once rather than one per attempt', async () => {
    // Fix-retry-discover-the-next-one turns preparing a launch into a guessing game.
    const p = await draft({
      regulatoryReference: '  ',
      seatCategory: 'REGULAR',
      ticketPriceMaxMinor: null,
      status: 'DISABLED',
    });
    const found = await codes(p.id);
    expect(found).toEqual(expect.arrayContaining(['NO_REFERENCE', 'NO_CEILING', 'NOT_DRAFT']));
  });

  it('refuses a second policy with the same scope and specificity', async () => {
    const first = await draft();
    await prisma.cinemaPricingPolicy.update({
      where: { id: first.id },
      data: { status: 'ACTIVE' },
    });
    const second = await draft();
    expect(await codes(second.id)).toContain('AMBIGUOUS');
  });
});

describe('rates nobody has checked against the order', () => {
  const unreviewedRef = `${REF} UNREVIEWED`;
  let unreviewedId: string;

  beforeAll(async () => {
    await prisma.regulatoryDocument.deleteMany({ where: { reference: unreviewedRef } });
    const doc = await prisma.regulatoryDocument.create({
      data: {
        reference: unreviewedRef,
        country: 'ActivationGateTestLand',
        region: 'Test Region',
        textReviewed: false,
      },
    });
    unreviewedId = doc.id;
  });

  afterAll(async () => {
    await prisma.regulatoryDocument.deleteMany({ where: { reference: unreviewedRef } });
  });

  it('is a WARNING outside production, so QA can be prepared', async () => {
    const p = await draft({
      regulatoryReference: unreviewedRef,
      regulatoryDocumentId: unreviewedId,
    });
    const r = await service.activationPreflight(p.id);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain('TEXT_NOT_REVIEWED');
  });

  it('is a BLOCKER in production', async () => {
    const before = process.env.APP_ENV;
    process.env.APP_ENV = 'production';
    try {
      const p = await draft({
        regulatoryReference: unreviewedRef,
        regulatoryDocumentId: unreviewedId,
      });
      const r = await service.activationPreflight(p.id);
      expect(r.ok).toBe(false);
      expect(r.blockers.map((b) => b.code)).toContain('TEXT_NOT_REVIEWED');
    } finally {
      if (before === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = before;
    }
  });

  it('blocks in production when no document is recorded at all', async () => {
    const before = process.env.APP_ENV;
    process.env.APP_ENV = 'production';
    try {
      const p = await draft({
        regulatoryReference: 'AN ORDER NOBODY RECORDED',
        regulatoryDocumentId: null,
      });
      const r = await service.activationPreflight(p.id);
      expect(r.blockers.map((b) => b.code)).toContain('TEXT_NOT_REVIEWED');
    } finally {
      if (before === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = before;
    }
  });

  it('refuses activate() itself, not merely the preflight', async () => {
    const before = process.env.APP_ENV;
    process.env.APP_ENV = 'production';
    try {
      const p = await draft({
        regulatoryReference: unreviewedRef,
        regulatoryDocumentId: unreviewedId,
      });
      await expect(service.activate('admin-1', p.id)).rejects.toThrow(/not been reviewed/i);
      const after = await prisma.cinemaPricingPolicy.findUnique({ where: { id: p.id } });
      expect(after?.status).toBe('DRAFT');
    } finally {
      if (before === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = before;
    }
  });
});
