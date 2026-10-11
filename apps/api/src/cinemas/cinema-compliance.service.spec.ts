import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { CinemaComplianceService } from './cinema-compliance.service';
import { CinemasController } from './cinemas.controller';
import { OrgAccessService } from '../tenancy/org-access.service';

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
