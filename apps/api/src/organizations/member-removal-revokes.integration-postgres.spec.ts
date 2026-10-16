import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OrganizationsService } from './organizations.service';
import { OrgAccessService } from '../tenancy/org-access.service';

/**
 * integration-real-postgres - taking somebody off the team takes back what they set up.
 *
 * Removal used to set the membership to REMOVED and nothing else. Their console access ended,
 * but a check-in device they registered kept admitting people (offline, it never asks the
 * server), an offline activation they approved kept a session in offline mode, and their
 * browser kept refreshing its session. This proves, against real rows:
 *  - their devices in THIS organization are revoked, and devices elsewhere, or devices they only
 *    approved for somebody still on the team, are not;
 *  - offline activations they approved here are revoked with a reason;
 *  - their sessions end when this was their last team, and are kept when they still work for
 *    another organization (whose door must not be interrupted by this one's decision).
 *
 * Every row is created here and deleted after. Skips (never fabricates a pass) without a DB.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
    try {
      const m = readFileSync(resolve(__dirname, p), 'utf8').match(/^DATABASE_URL=(.*)$/m);
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

const noAudit = { record: async () => undefined } as never;
const noAudience = { notifyAdmins: async () => undefined } as never;
const cfg = { get: () => 'QA' } as never;

describe('integration-real-postgres: removing a team member', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let orgs: OrganizationsService;
  const suffix = `rmrev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const orgIds: string[] = [];
  let owner: { id: string; email: string; fullName: string; roles: string[] };

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }
    const access = new OrgAccessService(db as never, noAudit);
    orgs = new OrganizationsService(db as never, access, noAudit, noAudience, cfg);
    const o = await db.user.create({
      data: { email: `owner-${suffix}@test.invalid`, fullName: 'Owner', passwordHash: 'x' },
    });
    owner = { id: o.id, email: o.email, fullName: 'Owner', roles: ['CUSTOMER'] };
  }, 60_000);

  afterAll(async () => {
    if (db && available) {
      await db.offlineActivation.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.checkInDevice.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.refreshToken.deleteMany({ where: { user: { email: { contains: suffix } } } });
      await db.user.deleteMany({ where: { email: { contains: suffix } } });
    }
    await db?.$disconnect().catch(() => undefined);
  });

  async function org(name: string) {
    const row = await db!.organization.create({
      data: {
        name: `${name} ${suffix}`,
        slug: `${name.toLowerCase()}-${suffix}`,
        status: 'APPROVED',
      },
    });
    orgIds.push(row.id);
    await db!.organizationMember.create({
      data: { organizationId: row.id, userId: owner.id, role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
    });
    return row.id;
  }

  async function doorWorker(n: string, orgId: string, alsoIn?: string) {
    const u = await db!.user.create({
      data: { email: `door-${n}-${suffix}@test.invalid`, fullName: `Door ${n}`, passwordHash: 'x' },
    });
    const member = await db!.organizationMember.create({
      data: { organizationId: orgId, userId: u.id, role: 'ORGANIZER_MANAGER', status: 'ACTIVE' },
    });
    if (alsoIn) {
      await db!.organizationMember.create({
        data: { organizationId: alsoIn, userId: u.id, role: 'CHECKIN_STAFF', status: 'ACTIVE' },
      });
    }
    const future = new Date(Date.now() + 86_400_000);
    await db!.refreshToken.createMany({
      data: [
        { userId: u.id, tokenHash: `${suffix}-${n}-a`, expiresAt: future },
        { userId: u.id, tokenHash: `${suffix}-${n}-b`, expiresAt: future },
      ],
    });
    return { userId: u.id, memberId: member.id };
  }

  const device = (orgId: string, data: Record<string, unknown>) =>
    db!.checkInDevice.create({ data: { organizationId: orgId, name: 'Gate phone', ...data } });

  it('revokes their devices and activations here, and signs them out when it was their last team', async () => {
    if (!available) return;
    const a = await org('Alpha');
    const elsewhere = await org('Beta');
    const door = await doorWorker('1', a);

    const registered = await device(a, { createdByUserId: door.userId, status: 'ACTIVE' });
    const handed = await device(a, { assignedStaffUserId: door.userId, status: 'PENDING' });
    // Approved by them for somebody still on the team: that person's phone keeps working.
    const approvedForOther = await device(a, {
      createdByUserId: owner.id,
      approvedByUserId: door.userId,
      status: 'ACTIVE',
    });
    const otherOrg = await device(elsewhere, { createdByUserId: door.userId, status: 'ACTIVE' });
    const act = await db!.offlineActivation.create({
      data: {
        organizationId: a,
        eventId: 'ev',
        eventSessionId: 'ses',
        deviceIds: [registered.id],
        reason: 'Gate 2 has no signal',
        evidenceSnapshot: {},
        approvedByUserId: door.userId,
      },
    });
    const ownersAct = await db!.offlineActivation.create({
      data: {
        organizationId: a,
        eventId: 'ev',
        eventSessionId: 'ses',
        deviceIds: [approvedForOther.id],
        reason: 'Gate 1',
        evidenceSnapshot: {},
        approvedByUserId: owner.id,
      },
    });

    const res = await orgs.removeMember(owner as never, a, door.memberId);
    expect(res.status).toBe('REMOVED');
    expect(res).toMatchObject({
      revoked: { devices: 2, activations: 1, sessions: 2, signedOut: true },
    });

    const status = async (id: string) =>
      (await db!.checkInDevice.findUnique({ where: { id } })).status;
    expect(await status(registered.id)).toBe('REVOKED');
    expect(await status(handed.id)).toBe('REVOKED');
    expect(await status(approvedForOther.id)).toBe('ACTIVE');
    expect(await status(otherOrg.id)).toBe('ACTIVE');

    const revoked = await db!.offlineActivation.findUnique({ where: { id: act.id } });
    expect(revoked).toMatchObject({ state: 'REVOKED', revokedByUserId: owner.id });
    expect(revoked.revokeReason).toMatch(/removed from the team/);
    expect((await db!.offlineActivation.findUnique({ where: { id: ownersAct.id } })).state).toBe(
      'ACTIVE',
    );

    const live = await db!.refreshToken.count({ where: { userId: door.userId, revokedAt: null } });
    expect(live).toBe(0);

    // Removing again changes nothing and fails nothing.
    const twice = await orgs.removeMember(owner as never, a, door.memberId);
    expect(twice.status).toBe('REMOVED');
  }, 60_000);

  it('keeps the sessions of somebody who still works the door for another organizer', async () => {
    if (!available) return;
    const a = await org('Gamma');
    const b = await org('Delta');
    const door = await doorWorker('2', a, b);
    const mine = await device(a, { createdByUserId: door.userId, status: 'ACTIVE' });
    const theirs = await device(b, { createdByUserId: door.userId, status: 'ACTIVE' });

    const res = await orgs.removeMember(owner as never, a, door.memberId);
    expect(res).toMatchObject({ revoked: { devices: 1, sessions: 0, signedOut: false } });
    expect((await db!.checkInDevice.findUnique({ where: { id: mine.id } })).status).toBe('REVOKED');
    expect((await db!.checkInDevice.findUnique({ where: { id: theirs.id } })).status).toBe(
      'ACTIVE',
    );
    expect(await db!.refreshToken.count({ where: { userId: door.userId, revokedAt: null } })).toBe(
      2,
    );
  }, 60_000);
});
