import type { AddressInfo } from 'node:net';
import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AdminPermission } from '@eticketsgo/shared-types';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { RolesGuard } from '../auth/roles.guard';
import { AdminReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { AuditQueryService } from '../audit/audit-query.service';

/**
 * The audit log needs AUDIT_READ - over real HTTP, through the real guards.
 *
 * It used to sit on its controller's BOOKING_READ, the support desk's floor, so anybody who could
 * look up a booking could also read who granted which duty, who revealed a bank number and who
 * approved which refund. Only the caller (a header standing in for the JWT), the grant rows and
 * the services are stubbed; a 200 proves the handler ran, a 403 with no service call proves a
 * refused one did nothing. The dashboard on the same controller stays on BOOKING_READ.
 */
type Actor = { roles: string[]; grants: string[] };

const ACTORS: Record<string, Actor> = {
  bookingReader: { roles: ['ADMIN'], grants: [AdminPermission.BOOKING_READ] },
  auditReader: { roles: ['ADMIN'], grants: [AdminPermission.AUDIT_READ] },
  superAdmin: { roles: ['ADMIN', 'SUPER_ADMIN'], grants: [] },
  customer: { roles: ['CUSTOMER'], grants: [AdminPermission.AUDIT_READ] },
};

class HeaderUserGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const raw = req.headers['x-test-actor'] as string | undefined;
    if (raw) {
      const id = raw;
      req.user = { id, email: `${id}@t.test`, fullName: id, roles: ACTORS[id].roles };
    }
    return true;
  }
}

describe('reading the audit log needs AUDIT_READ', () => {
  let app: INestApplication;
  let base = '';
  const calls: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminReportsController],
      providers: [
        {
          provide: ReportsService,
          useValue: {
            adminDashboard: async () => {
              calls.push('dashboard');
              return { ok: true };
            },
          },
        },
        {
          provide: AuditQueryService,
          useValue: {
            list: async () => {
              calls.push('audit.list');
              return { data: [], meta: {} };
            },
            summary: async () => {
              calls.push('audit.summary');
              return { byOrganization: [], byAction: [] };
            },
          },
        },
      ],
    }).compile();
    const reflector = new Reflector();
    const prisma = {
      adminGrant: {
        findMany: async ({ where }: { where: { userId: string } }) =>
          (ACTORS[where.userId]?.grants ?? []).map((permission) => ({ permission })),
      },
    };
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalGuards(
      new HeaderUserGuard(),
      new RolesGuard(reflector),
      new AdminPermissionGuard(reflector, prisma as never),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  const get = async (actor: string, path: string) =>
    (await fetch(`${base}${path}`, { headers: { 'x-test-actor': actor } })).status;

  it.each(['/admin/audit', '/admin/audit/summary'])(
    '%s: BOOKING_READ alone is now refused, and nothing runs',
    async (path) => {
      calls.length = 0;
      expect(await get('bookingReader', path)).toBe(403);
      expect(calls).toEqual([]);
    },
  );

  it.each(['/admin/audit', '/admin/audit/summary'])('%s: AUDIT_READ opens it', async (path) => {
    calls.length = 0;
    expect(await get('auditReader', path)).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it.each(['/admin/audit', '/admin/audit/summary'])(
    '%s: a super admin holds it by role',
    async (path) => {
      expect(await get('superAdmin', path)).toBe(200);
    },
  );

  it('a grant row is not enough without a back-office role', async () => {
    expect(await get('customer', '/admin/audit')).toBe(403);
  });

  it('leaves the dashboard on BOOKING_READ (no collateral lock-out)', async () => {
    expect(await get('bookingReader', '/admin/dashboard')).toBe(200);
    expect(await get('auditReader', '/admin/dashboard')).toBe(403);
  });
});
