import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as bcrypt from 'bcryptjs';
import { OrganizationsService } from './organizations.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { AdminStaffService } from '../admin/admin-staff.service';
import { AdminPermission } from '@eticketsgo/shared-types';

/**
 * integration-real-postgres — an invited team member can actually get in.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────
 * Inviting somebody created an OrganizationMember at status INVITED and stopped. Nothing
 * in the codebase ever moved a member to ACTIVE, and `assertMember` refuses anything that
 * is not ACTIVE — so every person ever invited was silently locked out of the organization
 * they had just been added to. The "Invite member" button produced a team member who could
 * do nothing at all.
 *
 * When the invitee had no account it was worse. A User row was created with a random
 * password nobody could know; self-registration then failed with "email already
 * registered", and there is no password-reset flow. The invite permanently bricked the
 * address.
 *
 * Proven against a real database because the whole defect lived in what was WRITTEN — a
 * status that never changed, and a password hash nothing could match. A stubbed Prisma
 * returns whatever the test hands it and would have reported this working all along.
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

const noAudit = { record: async () => undefined } as never;
const noAudience = { notifyAdmins: async () => undefined } as never;
/** Stands in for the deployed organizer console, so link-host assertions mean something. */
const ORGANIZER_BASE = 'https://organizer.example.test';
const ADMIN_BASE = 'https://admin.example.test';
const cfg = {
  get: (k: string) =>
    k === 'ORGANIZER_WEB_URL' ? ORGANIZER_BASE : k === 'ADMIN_WEB_URL' ? ADMIN_BASE : 'QA',
} as never;

describe('integration-real-postgres: team invitations', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let orgs: OrganizationsService;
  let access: OrgAccessService;

  const suffix = `invite-${Date.now()}`;
  let orgId = '';
  let ownerId = '';
  let owner: { id: string; email: string; fullName: string; roles: string[] };

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }

    access = new OrgAccessService(db as never);
    orgs = new OrganizationsService(db as never, access, noAudit, noAudience, cfg);

    const org = await db!.organization.create({
      data: { name: `Team ${suffix}`, slug: `team-${suffix}`, status: 'APPROVED' },
    });
    orgId = org.id;
    const ownerRow = await db!.user.create({
      data: {
        email: `owner-${suffix}@test.invalid`,
        fullName: 'Owner',
        passwordHash: await bcrypt.hash('Password123!', 10),
        roles: ['ORGANIZER_OWNER'],
      },
    });
    ownerId = ownerRow.id;
    owner = { id: ownerId, email: ownerRow.email, fullName: 'Owner', roles: ['ORGANIZER_OWNER'] };
    await db!.organizationMember.create({
      data: { organizationId: orgId, userId: ownerId, role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
    });
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    /*
      Invitations by USER, not by membership: the back-office ones carry no membership, so
      scoping the cleanup to the organization would leave them behind and the user deletes
      below would fail on the foreign key.
    */
    await db.accountInvitation.deleteMany({ where: { user: { email: { contains: suffix } } } });
    await db.adminGrant.deleteMany({ where: { user: { email: { contains: suffix } } } });
    await db.organizationMember.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  /** The token is only ever returned inside the link; this is how a test gets at it. */
  const tokenFrom = (inviteUrl: string) => inviteUrl.split('/').pop()!;

  maybe(
    'somebody with no account can accept, and only then can they do anything',
    async () => {
      const email = `newbie-${suffix}@test.invalid`;
      const invited = await orgs.inviteMember(owner as never, orgId, {
        email,
        role: 'CHECKIN_STAFF',
      } as never);

      /*
        The HOST, not just the path. QA shipped `http://localhost:3001/invite/<token>` for its
        first hour — a real invitation, a valid token, and a link only a developer could open.
        The e2e missed it because it navigated by pathname, so the assertion lives here where
        the URL is built.
      */
      expect(invited.inviteUrl.startsWith(`${ORGANIZER_BASE}/invite/`)).toBe(true);
      expect(invited.needsPassword).toBe(true);
      expect(invited.status).toBe('INVITED');

      /*
        The heart of the bug. Before accepting, the member exists but has no access — and
        that is correct, because being named by somebody else is not consent. What was wrong
        was that this state had no exit.
      */
      const asInvitee = { id: invited.user.id, email, fullName: '', roles: ['CUSTOMER'] };
      await expect(access.assertMember(asInvitee as never, orgId)).rejects.toThrow(/not a member/i);

      // And the account cannot be signed into: the placeholder hash matches nothing.
      const before = await db!.user.findUnique({ where: { id: invited.user.id } });
      expect(await bcrypt.compare('Password123!', before.passwordHash)).toBe(false);

      await orgs.acceptInvitation(tokenFrom(invited.inviteUrl), {
        fullName: 'New Bie',
        password: 'Password123!',
      } as never);

      // Now all three things that were broken are true at once.
      const after = await db!.user.findUnique({ where: { id: invited.user.id } });
      expect(after.fullName).toBe('New Bie');
      expect(await bcrypt.compare('Password123!', after.passwordHash)).toBe(true);
      const member = await db!.organizationMember.findUnique({ where: { id: invited.id } });
      expect(member.status).toBe('ACTIVE');
      await expect(access.assertMember(asInvitee as never, orgId)).resolves.toBeUndefined();
    },
    120_000,
  );

  maybe(
    'somebody who already has an account keeps the password they know',
    async () => {
      /*
        The other half, and the one where getting it wrong is a security bug rather than an
        inconvenience: offering to SET a password here would let anybody holding a forwarded
        link take over an existing account.
      */
      const email = `existing-${suffix}@test.invalid`;
      const existing = await db!.user.create({
        data: {
          email,
          fullName: 'Already Here',
          passwordHash: await bcrypt.hash('TheirOwnPassword1!', 10),
          roles: ['CUSTOMER'],
        },
      });

      const invited = await orgs.inviteMember(owner as never, orgId, {
        email,
        role: 'ORGANIZER_MANAGER',
      } as never);
      expect(invited.needsPassword).toBe(false);

      const summary = await orgs.describeInvitation(tokenFrom(invited.inviteUrl));
      expect(summary.needsPassword).toBe(false);
      expect(summary.organizationName).toBe(`Team ${suffix}`);

      // Accepted with no password at all, and theirs is untouched.
      await orgs.acceptInvitation(tokenFrom(invited.inviteUrl), {} as never);

      const after = await db!.user.findUnique({ where: { id: existing.id } });
      expect(await bcrypt.compare('TheirOwnPassword1!', after.passwordHash)).toBe(true);
      expect(after.fullName).toBe('Already Here');
      const member = await db!.organizationMember.findUnique({ where: { id: invited.id } });
      expect(member.status).toBe('ACTIVE');
    },
    120_000,
  );

  maybe(
    'a link is spent once used, and a resend invalidates the one before it',
    async () => {
      /*
        An invitation is a credential. A copy forwarded to the wrong person must not still
        work after the right person has used it, and re-sending must not leave two live keys
        to the same door.
      */
      const email = `once-${suffix}@test.invalid`;
      const invited = await orgs.inviteMember(owner as never, orgId, {
        email,
        role: 'CHECKIN_STAFF',
      } as never);
      const first = tokenFrom(invited.inviteUrl);

      const resent = await orgs.resendInvitation(owner as never, orgId, invited.id);
      const second = tokenFrom(resent.inviteUrl);
      expect(second).not.toBe(first);

      // The superseded link is dead even though nobody used it.
      await expect(orgs.describeInvitation(first)).rejects.toThrow(/not valid/i);

      await orgs.acceptInvitation(second, {
        fullName: 'Once Only',
        password: 'Password123!',
      } as never);
      await expect(
        orgs.acceptInvitation(second, { password: 'Password123!' } as never),
      ).rejects.toThrow(/not valid/i);

      // And there is nothing left to re-send.
      await expect(orgs.resendInvitation(owner as never, orgId, invited.id)).rejects.toThrow(
        /already joined/i,
      );
    },
    120_000,
  );

  maybe(
    'an expired invitation says so, rather than failing like a bad link',
    async () => {
      // Different remedies: a bad link means check the URL, an expired one means ask again.
      const email = `stale-${suffix}@test.invalid`;
      const invited = await orgs.inviteMember(owner as never, orgId, {
        email,
        role: 'CHECKIN_STAFF',
      } as never);

      await db!.accountInvitation.update({
        where: { organizationMemberId: invited.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(orgs.describeInvitation(tokenFrom(invited.inviteUrl))).rejects.toThrow(
        /expired/i,
      );
    },
    120_000,
  );

  maybe(
    'a deployed environment refuses to mint a localhost link',
    async () => {
      /*
        The silent failure, made loud. An operator who forgets ORGANIZER_WEB_URL gets an
        error naming the variable, instead of colleagues who never receive a usable link and
        nobody finding out for days.
      */
      const unconfigured = new OrganizationsService(db as never, access, noAudit, noAudience, {
        get: (k: string) => (k === 'APP_ENV' ? 'QA' : undefined),
      } as never);
      await expect(
        unconfigured.inviteMember(owner as never, orgId, {
          email: `nolink-${suffix}@test.invalid`,
          role: 'CHECKIN_STAFF',
        } as never),
      ).rejects.toThrow(/ORGANIZER_WEB_URL/);

      /*
        And it refused BEFORE writing anything. Creating the member first and failing on the
        link would leave somebody listed on the team with no invitation and no way in — which
        is precisely the state this change exists to remove.
      */
      const orphan = await db!.organizationMember.findFirst({
        where: { organizationId: orgId, user: { email: `nolink-${suffix}@test.invalid` } },
      });
      expect(orphan).toBeNull();
    },
    120_000,
  );

  maybe(
    'back-office staff can be invited too, through the same mechanism',
    async () => {
      /*
        The staff screen used to refuse anybody without an account, and said why: minting
        credentials there would mean handing out a password the holder never chose. That was
        right, and an invitation is what makes it obsolete — so the fix is to REUSE this,
        not to relax the principle or to grow a second invitation system beside it.

        The duties are granted immediately, which is safe precisely because the account is
        inert until accepted: it holds capabilities it has no way to exercise.
      */
      const email = `backoffice-${suffix}@test.invalid`;
      const staff = new AdminStaffService(db as never, noAudit, orgs);

      const invited = await staff.inviteStaff(owner as never, email, [
        AdminPermission.EVENT_REVIEW,
      ]);
      /*
        The ADMIN console. Sent to the organizer app instead, a back-office colleague would
        set a password inside a product they have no account in and then be told to sign in
        somewhere they were never shown.
      */
      expect(invited.inviteUrl.startsWith(`${ADMIN_BASE}/invite/`)).toBe(true);

      const account = await db!.user.findUnique({
        where: { id: invited.id },
        include: { adminGrants: true },
      });
      expect(account.roles).toContain('ADMIN');
      expect(account.adminGrants.map((g: { permission: string }) => g.permission)).toEqual([
        AdminPermission.EVENT_REVIEW,
      ]);
      // Holds the duties, cannot sign in to use them.
      expect(await bcrypt.compare('Password123!', account.passwordHash)).toBe(false);

      // No organization membership involved — this invitation activates the account alone.
      const summary = await orgs.describeInvitation(tokenFrom(invited.inviteUrl));
      expect(summary.organizationName).toBe('the ETicketsGo back office');

      await orgs.acceptInvitation(tokenFrom(invited.inviteUrl), {
        fullName: 'Back Officer',
        password: 'Password123!',
      } as never);

      const after = await db!.user.findUnique({ where: { id: invited.id } });
      expect(await bcrypt.compare('Password123!', after.passwordHash)).toBe(true);
      expect(after.fullName).toBe('Back Officer');
    },
    120_000,
  );

  maybe(
    'inviting an address that already has an account is refused, not silently promoted',
    async () => {
      /*
        A typo that happens to match a real customer must not hand them the back office. The
        search this screen already offers is the right route for somebody who exists, because
        it shows you WHO you are about to grant access to.
      */
      const staff = new AdminStaffService(db as never, noAudit, orgs);
      await expect(
        staff.inviteStaff(owner as never, owner.email, [AdminPermission.EVENT_REVIEW]),
      ).rejects.toThrow(/already has an ETicketsGo account/i);
    },
    120_000,
  );

  maybe(
    'the raw token is never stored',
    async () => {
      /*
        Same standard as RefreshToken. Somebody who can read this table must not be able to
        walk into every organization that has an invitation outstanding.
      */
      const email = `hashed-${suffix}@test.invalid`;
      const invited = await orgs.inviteMember(owner as never, orgId, {
        email,
        role: 'CHECKIN_STAFF',
      } as never);
      const token = tokenFrom(invited.inviteUrl);

      const row = await db!.accountInvitation.findUnique({
        where: { organizationMemberId: invited.id },
      });
      expect(row.tokenHash).not.toContain(token);
      expect(row.tokenHash).toHaveLength(64); // sha256, hex
    },
    120_000,
  );
});
