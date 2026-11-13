import { Role } from '@eticketsgo/shared-types';
import { OrgAccessService } from './org-access.service';
import { AppException, ErrorCodes } from '../common/errors';
import type { RequestUser } from '../common/decorators';

/**
 * Two organizers in one database, for tenant-isolation specs. Not a spec itself.
 *
 * ── WHY THE PRISMA DOUBLE IS STRICT ────────────────────────────────────────────────
 * There is no row-level security: a service keeps one organizer out of another's data only by
 * asking `OrgAccessService` (or by putting `organizationId` in its own where clause) BEFORE it
 * reads anything. So the double answers only the lookups a spec declares - the resource the
 * route names and the memberships - and every other model call throws {@link UnmockedPrismaCall}
 * and is logged. That gives each test two cheap, strong assertions:
 *
 *   - organizer B is refused with TENANT_FORBIDDEN / NOT_FOUND and `prisma.calls` shows no read
 *     of the protected data happened first;
 *   - organizer A, through the SAME call, gets past the tenant check (reaches data, which here
 *     means hitting an unmocked call or resolving). Without this positive control a refusal could
 *     be a broken mock rather than the tenant check.
 *
 * The OrgAccessService is the real one: the membership table below is what it reads.
 */

export const ORG_A = 'org-a';
export const ORG_B = 'org-b';

const person = (id: string, roles: Role[]): RequestUser => ({
  id,
  email: `${id}@tenant.test`,
  fullName: id,
  roles,
});

/** Owner of organization A. */
export const OWNER_A = person('user-owner-a', [Role.ORGANIZER_OWNER]);
/** Owner of organization B: a fully privileged organizer, just not A's. */
export const OWNER_B = person('user-owner-b', [Role.ORGANIZER_OWNER]);
/** Check-in staff of organization B. */
export const DOOR_B = person('user-door-b', [Role.CHECKIN_STAFF]);
/** A buyer who belongs to no organization. */
export const BUYER = person('user-buyer', [Role.CUSTOMER]);

/** userId -> (organizationId -> membership role). Everyone ACTIVE, every organization ACTIVE. */
const MEMBERSHIPS: Record<string, Record<string, Role>> = {
  [OWNER_A.id]: { [ORG_A]: Role.ORGANIZER_OWNER },
  [OWNER_B.id]: { [ORG_B]: Role.ORGANIZER_OWNER },
  [DOOR_B.id]: { [ORG_B]: Role.CHECKIN_STAFF },
};

/** Thrown by the strict Prisma double for any call a spec did not declare. */
export class UnmockedPrismaCall extends Error {
  constructor(readonly call: string) {
    super(`Unmocked Prisma call: ${call}`);
  }
}

/**
 * A rejection already marked handled: services build several queries and hand them to
 * `$transaction([...])` or `Promise.all`, so one unmocked call must not leave the others as
 * unhandled rejections that crash the worker.
 */
function unmocked(call: string): Promise<never> {
  const p = Promise.reject(new UnmockedPrismaCall(call));
  p.catch(() => undefined);
  return p;
}

type Mocks = Record<string, Record<string, (...args: never[]) => unknown>>;

export interface TenantWorld {
  /** Pass as the service's PrismaService. */
  prisma: Record<string, unknown> & { calls: string[] };
  /** The real tenant check, reading {@link MEMBERSHIPS}. */
  access: OrgAccessService;
  audit: { record: jest.Mock };
}

/**
 * A strict Prisma double plus the real `OrgAccessService` over the A/B membership table.
 *
 * `mocks` maps `model -> method -> implementation`; `$transaction` and `$queryRaw` may be given
 * as models with a `call` method.
 */
export function tenantWorld(mocks: Mocks = {}): TenantWorld {
  const calls: string[] = [];
  const membership = {
    findUnique: async (args: {
      where: { organizationId_userId: { organizationId: string; userId: string } };
    }) => {
      const { organizationId, userId } = args.where.organizationId_userId;
      const role = MEMBERSHIPS[userId]?.[organizationId];
      return role
        ? {
            organizationId,
            userId,
            role,
            status: 'ACTIVE',
            organization: { status: 'ACTIVE', name: organizationId },
          }
        : null;
    },
    findMany: async (args: { where: { userId: string } }) =>
      Object.keys(MEMBERSHIPS[args.where.userId] ?? {}).map((organizationId) => ({
        organizationId,
      })),
  };
  const declared: Mocks = {
    organizationMember: membership as never,
    adminGrant: { findMany: async () => [] },
    ...mocks,
  };

  const model = (name: string) =>
    new Proxy(
      {},
      {
        get(_t, method: string | symbol) {
          if (typeof method !== 'string' || method === 'then') return undefined;
          const key = `${name}.${method}`;
          return (...args: never[]) => {
            calls.push(key);
            const impl = declared[name]?.[method];
            if (!impl) return unmocked(key);
            return impl(...args);
          };
        },
      },
    );

  const raw =
    (name: '$queryRaw' | '$transaction' | '$executeRaw') =>
    (...args: never[]) => {
      calls.push(name);
      const impl = declared[name]?.call;
      if (!impl) return unmocked(name);
      return impl(...args);
    };

  const prisma = new Proxy({ calls } as Record<string, unknown> & { calls: string[] }, {
    get(target, prop: string | symbol) {
      if (prop === 'calls') return target.calls;
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop === '$queryRaw' || prop === '$transaction' || prop === '$executeRaw') {
        return raw(prop);
      }
      return model(prop);
    },
  });

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const access = new OrgAccessService(prisma as never, audit as never);
  return { prisma, access, audit };
}

/** The calls made, minus the tenant check's own membership and grant lookups. */
export function dataCalls(world: TenantWorld): string[] {
  return world.prisma.calls.filter(
    (c) => !c.startsWith('organizationMember.') && !c.startsWith('adminGrant.'),
  );
}

/** Asserts a refusal with the given error code (TENANT_FORBIDDEN unless stated). */
export async function expectRefused(
  promise: Promise<unknown>,
  code: string = ErrorCodes.TENANT_FORBIDDEN,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((e: AppException) => expect(e.code).toBe(code));
}

/**
 * Asserts the call got PAST the tenant check: it resolved, or it went on to read data the spec
 * did not mock. Any AppException (a refusal) fails it.
 */
export async function expectReachesData(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof UnmockedPrismaCall) return;
    throw e;
  }
}
