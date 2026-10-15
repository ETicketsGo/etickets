import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { CinemaComplianceService } from './cinema-compliance.service';
import { CinemasController } from './cinemas.controller';
import { OrgAccessService } from '../tenancy/org-access.service';
import {
  resolvePolicy,
  type PolicyRow,
} from '../pricing/cinema-policy/cinema-pricing-policy.resolver';

/**
 * Who may say which regulatory class a seat is, and what they may say.
 *
 * The class decides the legal price ceiling a seat sells under. Membership alone was enough to
 * change it, so check-in staff could move a recliner onto the regular rate or clear a mapping and
 * stop a seat selling; and the body went to the database unvalidated.
 */

const MEMBER = { id: 'u-1', email: 'm@x.test', fullName: 'M', roles: [] };

/** The real access service over a membership of the given role, so the rule is not mocked away. */
function setup(role: string) {
  const prisma = {
    organizationMember: {
      findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', role }),
    },
    cinema: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'org-1' }) },
    seatCategory: {
      findFirst: jest.fn().mockResolvedValue({ id: 'sc-1' }),
      update: jest.fn().mockResolvedValue({ id: 'sc-1', name: 'Gold', regulatoryClass: 'PREMIUM' }),
    },
  };
  const svc = new CinemaComplianceService(
    prisma as never,
    new OrgAccessService(prisma as never, { record: async () => undefined } as never),
    {} as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { svc, prisma };
}

describe('CinemaComplianceService.setSeatClass — who may change it', () => {
  it('refuses check-in staff, and writes nothing', async () => {
    const { svc, prisma } = setup('CHECKIN_STAFF');
    await expect(svc.setSeatClass(MEMBER, 'cin-1', 'sc-1', 'REGULAR')).rejects.toThrow(
      /role does not permit/i,
    );
    expect(prisma.seatCategory.update).not.toHaveBeenCalled();
  });

  it.each(['ORGANIZER_OWNER', 'ORGANIZER_MANAGER'])('lets %s change it', async (role) => {
    const { svc, prisma } = setup(role);
    await svc.setSeatClass(MEMBER, 'cin-1', 'sc-1', 'PREMIUM');
    expect(prisma.seatCategory.update).toHaveBeenCalled();
  });

  it('still lets any member READ the mapping', async () => {
    const { svc, prisma } = setup('CHECKIN_STAFF');
    Object.assign(prisma.seatCategory, { findMany: jest.fn().mockResolvedValue([]) });
    await expect(svc.seatClassesFor(MEMBER, 'cin-1')).resolves.toEqual([]);
  });
});

describe('PATCH /cinemas/:id/seat-classes/:seatCategoryId — what may be said', () => {
  /*
    Read from the route's own metadata and run through the pipes Nest would run, so this fails if
    the validation is removed from the route — not merely if a schema somewhere is wrong.
  */
  const runBodyPipes = (value: unknown) => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, CinemasController, 'setSeatClass') as
      Record<string, { pipes?: { transform: (v: unknown, m: unknown) => unknown }[] }> | undefined;
    const body = Object.entries(args ?? {}).find(([key]) =>
      key.startsWith(`${RouteParamtypes.BODY}:`),
    )?.[1];
    const pipes = body?.pipes ?? [];
    if (pipes.length === 0) throw new Error('the body reaches the handler unvalidated');
    return pipes.reduce((v, pipe) => pipe.transform(v, { type: 'body' }), value);
  };

  it('refuses a class the schema does not define', () => {
    expect(() => runBodyPipes({ regulatoryClass: 'GOLD' })).toThrow(/failed validation/i);
  });

  it('refuses a body with no class, rather than silently clearing the mapping', () => {
    expect(() => runBodyPipes({})).toThrow(/failed validation/i);
  });

  it('accepts a defined class, and an explicit null to clear it', () => {
    expect(runBodyPipes({ regulatoryClass: 'RECLINER' })).toEqual({ regulatoryClass: 'RECLINER' });
    expect(runBodyPipes({ regulatoryClass: null })).toEqual({ regulatoryClass: null });
  });
});

describe('CinemaComplianceService.forCinema - what the panel may blame, and what it says about the fee', () => {
  const NOW = new Date('2026-10-11T10:00:00Z');
  const policy = {
    regulatoryReference: 'G.O. 120',
    version: 1,
    effectiveFrom: new Date('2020-01-01'),
    ticketPriceMaxMinor: 15000,
    ticketPriceMinMinor: null,
    maintenanceChargeMinor: 0,
    maintenanceTreatment: 'NOT_APPLICABLE',
    onlineFeePolicy: 'ALLOWED',
    onlineFeeCapMinor: null,
  };

  function build(resolution: unknown, ticketTypes: unknown[]) {
    const prisma = {
      cinema: {
        findUnique: jest.fn().mockResolvedValue({
          organizationId: 'org-1',
          country: 'IN',
          region: null,
          district: null,
          city: null,
          localBodyType: null,
          cinemaFormat: null,
          climateType: null,
          venue: null,
        }),
      },
      ticketType: { findMany: jest.fn().mockResolvedValue(ticketTypes) },
      organizationMember: {
        findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', role: 'ORGANIZER_OWNER' }),
      },
    };
    return new CinemaComplianceService(
      prisma as never,
      new OrgAccessService(prisma as never, { record: async () => undefined } as never),
      { resolveForCinema: jest.fn().mockResolvedValue(resolution) } as never,
      {} as never,
    );
  }
  const tt = (name: string, priceMinor: number, startsAt: string) => ({
    id: name,
    name,
    priceMinor,
    seatCategory: null,
    eventSession: { startsAt: new Date(startsAt) },
  });

  it("flags a finished show's ticket as history and keeps it out of the summary", async () => {
    const svc = build({ status: 'COMPLIANT', policy, explanation: 'ok' }, [
      tt('Old test', 15100, '2026-09-01T10:00:00Z'),
      tt('Gold', 12000, '2026-10-20T10:00:00Z'),
    ]);
    const v = await svc.forCinema(MEMBER, 'cin-1', NOW);
    expect(v.prices.find((p) => p.name === 'Old test')).toMatchObject({
      ok: false,
      upcoming: false,
    });
    expect(v.prices.find((p) => p.name === 'Gold')).toMatchObject({ ok: true, upcoming: true });
    expect(v.summary).toMatch(/^Compliant/);
    expect(v.summary).not.toMatch(/Old test/);
  });

  it('still names an over-ceiling price on a show to come', async () => {
    const svc = build({ status: 'COMPLIANT', policy, explanation: 'ok' }, [
      tt('Gold', 15100, '2026-10-20T10:00:00Z'),
    ]);
    expect((await svc.forCinema(MEMBER, 'cin-1', NOW)).summary).toMatch(/Gold/);
  });

  it('reports the fee as held at 0 when no policy resolves, as checkout does', async () => {
    const svc = build({ status: 'POLICY_NOT_FOUND', policy: null, explanation: 'none' }, []);
    const v = await svc.forCinema(MEMBER, 'cin-1', NOW);
    expect(v.onlineFee.maxMinor).toBe(0);
    expect(v.onlineFee.description).toMatch(/holds the booking fee at 0/);
    expect(v.onlineFee.description).not.toMatch(/may be charged/);
  });

  it('keeps "may be charged" for a policy that allows a fee, with no ceiling', async () => {
    const svc = build({ status: 'COMPLIANT', policy, explanation: 'ok' }, []);
    const v = await svc.forCinema(MEMBER, 'cin-1', NOW);
    expect(v.onlineFee).toMatchObject({ policy: 'ALLOWED', maxMinor: null });
  });
});

describe('CinemaComplianceService.forCinema - INVALID_CINEMA_CLASSIFICATION names its real cause (F3)', () => {
  /*
    Through the REAL resolver, so the status (and therefore what sells) is the engine's own
    answer and only the words are under test. The fixture rates are invented, as elsewhere.
  */
  const NOW = new Date('2026-10-11T10:00:00Z');
  const rows: PolicyRow[] = [
    {
      id: 'ap-mc-multiplex-regular',
      version: 1,
      country: 'IN',
      region: 'Andhra Pradesh',
      district: '*',
      city: '*',
      currency: '*',
      localBodyType: 'MUNICIPAL_CORPORATION',
      cinemaFormat: 'MULTIPLEX',
      climateType: 'AC',
      seatCategory: 'REGULAR',
      maintenanceChargeMinor: 0,
      maintenanceTreatment: 'NOT_APPLICABLE',
      maintenanceTaxCategory: null,
      onlineFeePolicy: 'ALLOWED',
      onlineFeeCapMinor: null,
      ticketPriceMinMinor: null,
      ticketPriceMaxMinor: 15000,
      ticketPriceRule: null,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      effectiveTo: null,
      regulatoryReference: 'FIXTURE-ORDER-1',
    } as PolicyRow,
  ];
  const CLASSIFIED: Classification = {
    localBodyType: 'MUNICIPAL_CORPORATION',
    cinemaFormat: 'MULTIPLEX',
    climateType: 'AC',
  };
  const UNCLASSIFIED: Classification = {
    localBodyType: null,
    cinemaFormat: null,
    climateType: null,
  };

  type Classification = {
    localBodyType: string | null;
    cinemaFormat: string | null;
    climateType: string | null;
  };
  function build(classification: Classification, ticketTypes: unknown[]) {
    const cinema = {
      organizationId: 'org-1',
      country: 'IN',
      region: 'Andhra Pradesh',
      district: null,
      city: 'Vijayawada',
      venue: null,
      ...classification,
    };
    const prisma = {
      cinema: { findUnique: jest.fn().mockResolvedValue(cinema) },
      ticketType: { findMany: jest.fn().mockResolvedValue(ticketTypes) },
      organizationMember: {
        findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', role: 'ORGANIZER_OWNER' }),
      },
    };
    // The same context the real service builds, handed to the real resolver.
    const policies = {
      resolveForCinema: async (
        c: typeof cinema,
        currency: string,
        seatCategories: string[],
        at: Date,
        unmappedSeatCategories: string[] = [],
      ) =>
        resolvePolicy(rows, {
          country: c.country,
          region: c.region,
          district: c.district,
          city: c.city,
          currency,
          localBodyType: c.localBodyType as never,
          cinemaFormat: c.cinemaFormat as never,
          climateType: c.climateType as never,
          seatCategories,
          unmappedSeatCategories,
          at,
        }),
    };
    return new CinemaComplianceService(
      prisma as never,
      new OrgAccessService(prisma as never, { record: async () => undefined } as never),
      policies as never,
      {} as never,
    );
  }
  const tt = (name: string, seatCategory: { name: string; regulatoryClass: string | null }) => ({
    id: name,
    name,
    priceMinor: 12000,
    seatCategory,
    eventSession: { startsAt: new Date('2026-10-20T10:00:00Z') },
  });
  const PLATINUM = { name: 'Platinum Executive', regulatoryClass: null };
  const GOLD = { name: 'Gold', regulatoryClass: 'REGULAR' };

  it('blames the unmapped seat class, by name, when the cinema IS classified', async () => {
    const svc = build(CLASSIFIED, [tt('Gold', GOLD), tt('Platinum', PLATINUM)]);
    const v = await svc.forCinema(MEMBER, 'cin-1', NOW);
    // Sellability is the engine's and is unchanged: still refused, for the same status.
    expect(v.status).toBe('INVALID_CINEMA_CLASSIFICATION');
    expect(v.blocksPublishing).toBe(true);
    expect(v.reasonCode).toBe('SEAT_CLASS_UNMAPPED');
    expect(v.unmappedSeatCategories).toEqual(['Platinum Executive']);
    expect(v.summary).toMatch(/Seats in "Platinum Executive" cannot be sold yet/);
    expect(v.summary).toMatch(/no regulatory seat class/);
    expect(v.summary).toMatch(/Seat classes/);
    expect(v.summary).not.toMatch(/no type recorded/);
    expect(v.summary).not.toMatch(/local body/);
  });

  it('keeps the classification message for a cinema that is genuinely unclassified', async () => {
    const svc = build(UNCLASSIFIED, [tt('Gold', GOLD)]);
    const v = await svc.forCinema(MEMBER, 'cin-1', NOW);
    expect(v.status).toBe('INVALID_CINEMA_CLASSIFICATION');
    expect(v.blocksPublishing).toBe(true);
    expect(v.reasonCode).toBe('CINEMA_NOT_CLASSIFIED');
    expect(v.unmappedSeatCategories).toEqual([]);
    expect(v.summary).toMatch(/no type recorded/);
  });

  it('names the seat class first and the missing classification after, when both are wrong', async () => {
    const svc = build(UNCLASSIFIED, [tt('Platinum', PLATINUM)]);
    const v = await svc.forCinema(MEMBER, 'cin-1', NOW);
    expect(v.blocksPublishing).toBe(true);
    expect(v.reasonCode).toBe('SEAT_CLASS_UNMAPPED');
    expect(v.summary).toMatch(/"Platinum Executive"/);
    expect(v.summary).toMatch(/also needs its local body, format and climate type/);
  });

  it('reports no reason code for a cinema that sells', async () => {
    const svc = build(CLASSIFIED, [tt('Gold', GOLD)]);
    const v = await svc.forCinema(MEMBER, 'cin-1', NOW);
    expect(v.status).toBe('COMPLIANT');
    expect(v.blocksPublishing).toBe(false);
    expect(v.reasonCode).toBeNull();
  });

  /*
    Walking QA: a room with two classes resolved at state level, so the panel read "Order: None
    applies" for a cinema the order covers. The per-class rows are what the exhibitor needs.
  */
  it('lists the limit of every class, even when the room has several', async () => {
    const svc = build(CLASSIFIED, [tt('Gold', GOLD), tt('Platinum', PLATINUM)]);
    const v = await svc.forCinema(MEMBER, 'cin-1', NOW);
    const by = Object.fromEntries(v.classRates.map((r) => [r.regulatoryClass, r]));
    expect(by.REGULAR).toMatchObject({
      sellable: true,
      maxMinor: 15000,
      regulatoryReference: 'FIXTURE-ORDER-1',
    });
    // The fixture has no recliner rate: regulated, and not sellable at any price.
    expect(by.RECLINER).toMatchObject({ regulated: true, sellable: false, maxMinor: null });
  });

  it('says it in terms of selling, never "Cannot publish"', async () => {
    const svc = build(CLASSIFIED, [tt('Gold', GOLD), tt('Platinum', PLATINUM)]);
    const v = await svc.forCinema(MEMBER, 'cin-1', NOW);
    expect(v.summary).not.toMatch(/publish/i);
  });
});
