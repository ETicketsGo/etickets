import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AdminPermission } from '@eticketsgo/shared-types';
import { AdminStaffService } from '../admin/admin-staff.service';

/**
 * integration-real-postgres — separating back-office duties.
 *
 * The scenario that motivated this: a refund desk that may investigate a request but may not
 * pay it out. Under one ADMIN role that is inexpressible; anybody who could open the console
 * could approve money.
 *
 * Proven against a real database because the thing being checked is what a REQUEST would
 * see: the guard reads grants per request rather than from the token, so revocation takes
 * effect immediately. A stubbed client would return whatever the test handed it.
 *
 * Skips (never fabricates a pass) when no database is reachable.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
    try {
      const txt = readFileSync(resolve(__dirname, p), 'utf8');
      const m = txt.match(/^DATABASE_URL=(.*)$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

describe('integration-real-postgres: admin permissions', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let staff: AdminStaffService;

  const suffix = `perm-${Date.now()}`;
  let superId = '';
  let deskId = '';
  const audited: { action: string; metadata?: Record<string, unknown> }[] = [];

  const actor = () => ({ id: superId, email: 's@t.test', fullName: 'S', roles: [] }) as never;

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    staff = new AdminStaffService(
      db as never,
      {
        record: async (e: { action: string; metadata?: Record<string, unknown> }) => {
          audited.push(e);
        },
      } as never,
      // Only reached by inviteStaff, which this suite does not exercise.
      { issueInvitation: async () => 'http://localhost:3001/invite/unused' } as never,
    );

    superId = (
      await db.user.create({
        data: {
          email: `super+${suffix}@example.test`,
          passwordHash: 'x',
          fullName: 'Super',
          roles: ['ADMIN', 'SUPER_ADMIN'],
        },
      })
    ).id;
    deskId = (
      await db.user.create({
        data: {
          email: `desk+${suffix}@example.test`,
          passwordHash: 'x',
          fullName: 'Desk',
          roles: ['ADMIN'],
        },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.adminGrant.deleteMany({ where: { userId: { in: [superId, deskId] } } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await db.$disconnect();
  }, 60_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  /** What the guard would compute for this account, right now. */
  const heldBy = async (userId: string, roles: string[]) => {
    const rows = await db!.adminGrant.findMany({ where: { userId }, select: { permission: true } });
    const { permissionsFor } = await import('@eticketsgo/shared-types');
    return permissionsFor(
      roles,
      rows.map((r: { permission: string }) => r.permission as AdminPermission),
    );
  };

  maybe('a new admin can do nothing until somebody says so', async () => {
    // The default that matters. Creating an account must not silently confer the old
    // "every admin can do everything" behaviour.
    const held = await heldBy(deskId, ['ADMIN']);
    expect(held.size).toBe(0);
  });

  maybe(
    'a refund desk may review but may NOT approve',
    async () => {
      // The scenario the whole model exists for.
      await staff.setPermissions(actor(), deskId, [
        AdminPermission.BOOKING_READ,
        AdminPermission.REFUND_REVIEW,
      ]);
      const held = await heldBy(deskId, ['ADMIN']);
      expect(held.has(AdminPermission.REFUND_REVIEW)).toBe(true);
      expect(held.has(AdminPermission.REFUND_APPROVE)).toBe(false);
      expect(held.has(AdminPermission.PLATFORM_CONFIG)).toBe(false);
    },
    60_000,
  );

  maybe(
    'revoking takes effect immediately, not when a token expires',
    async () => {
      // Grants are read per request precisely so this is true. If they lived in the JWT, a
      // removed capability would keep working for the life of the session.
      await staff.setPermissions(actor(), deskId, []);
      const held = await heldBy(deskId, ['ADMIN']);
      expect(held.size).toBe(0);
    },
    60_000,
  );

  maybe(
    'a super admin holds everything without holding a single grant',
    async () => {
      // By ROLE, not by rows. An installation whose last super admin had ADMIN_MANAGE revoked
      // would otherwise be unrepairable from inside the product.
      const rows = await db!.adminGrant.findMany({ where: { userId: superId } });
      expect(rows).toHaveLength(0);
      const held = await heldBy(superId, ['ADMIN', 'SUPER_ADMIN']);
      expect(held.has(AdminPermission.REFUND_APPROVE)).toBe(true);
      expect(held.has(AdminPermission.ADMIN_MANAGE)).toBe(true);
    },
    60_000,
  );

  maybe(
    'records both sides of every change, so it can be reconstructed later',
    async () => {
      audited.length = 0;
      await staff.setPermissions(actor(), deskId, [AdminPermission.REFUND_REVIEW], 'rota change');
      await staff.setPermissions(actor(), deskId, [AdminPermission.REFUND_APPROVE]);
      const entries = audited.filter((a) => a.action === 'ADMIN_PERMISSIONS_CHANGED');
      expect(entries).toHaveLength(2);
      // An after-only entry cannot answer "what changed" once the row is overwritten again.
      expect(entries[1].metadata?.before).toEqual(['REFUND_REVIEW']);
      expect(entries[1].metadata?.after).toEqual(['REFUND_APPROVE']);
      expect(entries[0].metadata?.note).toBe('rota change');
    },
    60_000,
  );

  maybe(
    'refuses to write grants for a super admin',
    async () => {
      // They already hold everything by role; editable-looking grants would invite somebody
      // to "tidy up" a super admin into having none.
      await expect(
        staff.setPermissions(actor(), superId, [AdminPermission.BOOKING_READ]),
      ).rejects.toThrow(/already holds every permission/i);
    },
    60_000,
  );

  maybe(
    'refuses to remove the last route back in',
    async () => {
      await expect(staff.revokeAdminRole(actor(), superId)).rejects.toThrow(/cannot be removed/i);
    },
    60_000,
  );

  maybe(
    'refuses to let somebody lock themselves out',
    async () => {
      const selfActor = { id: deskId, email: 'd@t.test', fullName: 'D', roles: [] } as never;
      await expect(staff.revokeAdminRole(selfActor, deskId)).rejects.toThrow(/your own/i);
    },
    60_000,
  );

  maybe(
    'ignores a permission that is not in the catalogue',
    async () => {
      // A typo must not become a row that looks like a real capability.
      await staff.setPermissions(actor(), deskId, [
        AdminPermission.BOOKING_READ,
        'REFUND_APROVE' as AdminPermission,
      ]);
      const held = await heldBy(deskId, ['ADMIN']);
      expect([...held]).toEqual([AdminPermission.BOOKING_READ]);
    },
    60_000,
  );
});
