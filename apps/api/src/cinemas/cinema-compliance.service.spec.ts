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
    new OrgAccessService(prisma as never),
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
