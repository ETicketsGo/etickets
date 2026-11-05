import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { EmailChannel } from '../notifications/channels/email.channel';
import type { RenderedNotification } from '../notifications/channels/notification-channel.interface';
import { OrgAccessService } from '../tenancy/org-access.service';

/**
 * integration-real-postgres, whole app over HTTP: two owner decisions about who may get into an
 * organization (2026-10-26).
 *
 * ── 1. TEAM INVITATIONS ────────────────────────────────────────────────────────────
 * The audit (docs/auth/IDENTITY-JOURNEYS.md, open question 1) found that an invitation for an
 * EXISTING account was accepted with no sign-in at all, and that the inviting owner was handed
 * the raw invite URL. So an owner could make any existing account an ACTIVE member of their
 * organization without that person. Now:
 *   - the inviter never receives the link; it goes to the invitee's address only;
 *   - accepting needs a session of the INVITED account, with its email proved;
 *   - a session of anybody else (the inviter included) is refused, and so is no session;
 *   - an invitation that created the account is claimed with a code sent to that address;
 *   - expired, reused and cancelled links are refused; every accept and refusal is audited.
 *
 * ── 2. SUSPENDED ORGANIZATIONS ─────────────────────────────────────────────────────
 * Members of a suspended organization could sign in by password or phone and keep working in
 * the console; only the handoff refused them. Now every organizer API for that organization
 * answers 403 ORGANIZATION_SUSPENDED, however the session was made, while the same person can
 * still buy tickets and still work in any other organization they belong to.
 *
 * Every assertion that matters reads the TABLE afterwards. Fixtures carry a unique suffix and
 * are removed. Skips (never fabricates a pass) without a database.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

const PASSWORD = 'Vermilion-Lantern-4821!';
const NEW_PASSWORD = 'Copper-Harbour-Kestrel-93';
const PHONE_CODE = '424242';

describe('integration-real-postgres: team invitations and suspended organizations', () => {
  const url = process.env.DATABASE_URL;
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;
  const sent: RenderedNotification[] = [];
  const savedEnv = { ...process.env };

  const suffix = `invsec-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const phone = `+1415${String(Date.now()).slice(-7)}`;
  // Lower case: sign-in normalises the address it is given.
  const email = (who: string) => `${who.toLowerCase()}-${suffix}@test.invalid`;
  const ids: Record<string, string> = {};
  const orgIds: string[] = [];
  const leaked = new Map<string, string>();

  async function http(method: string, path: string, token?: string, body?: unknown) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    const data = json?.data ?? json;
    // The OLD behaviour handed the inviter the link. Remembered so the tests that prove the old
    // hole can still reach a token before the fix (see inviteTokenFor).
    const to = data?.user?.email ?? data?.email;
    if (typeof data?.inviteUrl === 'string' && to) leaked.set(to, data.inviteUrl);
    return { status: res.status, json: data, raw: text };
  }
  // The error envelope is `{ code, message, details }` (AllExceptionsFilter).
  const errorCode = (r: { json: { code?: string } | undefined }) => r.json?.code;

  const login = async (address: string, password = PASSWORD) => {
    const r = await http('POST', '/auth/login', undefined, { email: address, password });
    expect(r.status).toBeLessThan(300);
    return { access: r.json.accessToken as string, refresh: r.json.refreshToken as string };
  };

  const phoneSignIn = async () => {
    await db!.phoneOtp.updateMany({
      where: { phone, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await db!.phoneOtp.create({
      data: {
        phone,
        codeHash: await bcrypt.hash(PHONE_CODE, 4),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    const r = await http('POST', '/auth/phone/verify', undefined, { phone, code: PHONE_CODE });
    expect(r.status).toBe(201);
    return { access: r.json.accessToken as string, refresh: r.json.refreshToken as string };
  };

  /** The newest email delivered to an address, of a type. */
  const lastMail = (to: string, type?: string) =>
    [...sent].reverse().find((m) => m.toEmail === to && (!type || m.type === type));

  /**
   * The invitation token, as the INVITEE receives it: from the email sent to them. Before this
   * change no email was sent and the token only existed in the inviter's response, so the
   * fallback is how the tests that prove the old hole can still reach the token.
   */
  const inviteTokenFor = (to: string, _response?: unknown) => {
    const mail = lastMail(to, 'TEAM_INVITATION');
    const text = mail ? `${mail.body} ${JSON.stringify(mail.payload ?? {})}` : '';
    const found = text.match(/\/invite\/([A-Za-z0-9_-]{20,})/)?.[1];
    if (found) return found;
    const url = leaked.get(to);
    if (url) return url.split('/').pop()!;
    throw new Error(`no invitation reached ${to}`);
  };

  const emailCodeFor = (to: string) => {
    const mail = lastMail(to, 'EMAIL_VERIFICATION_CODE');
    const code = (mail?.payload as { code?: string } | undefined)?.code;
    if (!code) throw new Error(`no email code reached ${to}`);
    return code;
  };

  const memberRow = (orgId: string, userId: string) =>
    db!.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId } },
    });

  const auditActions = async (orgId: string, action: string) =>
    db!.auditLog.findMany({
      where: { organizationId: orgId, action },
      orderBy: { createdAt: 'asc' },
      select: { action: true, actorUserId: true, metadata: true },
    });

  async function makeUser(
    who: string,
    roles: string[] = ['CUSTOMER'],
    extra: Record<string, unknown> = {},
  ) {
    const row = await db!.user.create({
      data: {
        email: email(who),
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        fullName: who,
        roles,
        ...extra,
      },
    });
    ids[who] = row.id;
    return row;
  }

  async function makeOrg(label: string, status: string) {
    const org = await db!.organization.create({
      data: { name: `${label} ${suffix}`, slug: `${label.toLowerCase()}-${suffix}`, status },
    });
    orgIds.push(org.id);
    return org.id;
  }

  async function seat(orgId: string, userId: string, role = 'ORGANIZER_OWNER') {
    await db!.organizationMember.create({
      data: { organizationId: orgId, userId, role, status: 'ACTIVE' },
    });
  }

  let teamOrg = '';
  let otherOrg = '';
  let suspendedOrg = '';

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED -- no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED -- DB unavailable');
      return;
    }
    process.env.APP_ENV = 'LOCAL';
    process.env.ORGANIZER_WEB_URL = 'https://organizer.example.test';
    process.env.ADMIN_WEB_URL = 'https://admin.example.test';
    process.env.THROTTLE_LIMIT = '100000';
    process.env.AUTH_THROTTLE_LIMIT = '100000';
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-for-invsec-spec-0123456789abcdef';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-for-invsec-spec-0123456789';
    process.env.QR_SIGNING_SECRET ??= 'test-qr-secret-for-invsec-spec-0123456789';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret-for-invsec-spec-0123456789';

    /*
      Mail is captured, not sent: what matters is WHO it went to and what it carried. A real
      provider's answer, so the code paths that refuse to pretend a `log` mail was delivered
      treat these as delivered.
    */
    jest.spyOn(EmailChannel.prototype, 'deliver').mockImplementation(async (msg) => {
      sent.push(msg);
      return { provider: 'ses', providerMessageId: `test-${sent.length}` };
    });

    const { AppModule } = await import('../app.module');
    const { AllExceptionsFilter } = await import('../common/all-exceptions.filter');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    teamOrg = await makeOrg('Team', 'APPROVED');
    otherOrg = await makeOrg('Other', 'APPROVED');
    // APPROVED for now: the refresh-token case signs in before the suspension.
    suspendedOrg = await makeOrg('Suspended', 'APPROVED');

    const owner = await makeUser('owner', ['CUSTOMER', 'ORGANIZER_OWNER']);
    await seat(teamOrg, owner.id);
    await makeUser('manager', ['CUSTOMER']);
    await seat(teamOrg, ids.manager, 'ORGANIZER_MANAGER');
    await makeUser('stranger');
    // Existing accounts the owner will invite. Neither has proved its email yet (every account
    // made before emailVerifiedAt existed is in this state).
    await makeUser('invitee');
    await makeUser('invitee2');
    await makeUser('verified', ['CUSTOMER'], { emailVerifiedAt: new Date() });

    // Suspension fixtures: an owner by password, a member by phone, one who also works elsewhere.
    await makeUser('suspOwner', ['CUSTOMER', 'ORGANIZER_OWNER']);
    await seat(suspendedOrg, ids.suspOwner);
    const phoneMember = await db!.user.create({
      data: {
        email: email('phone'),
        phone,
        phoneVerifiedAt: new Date(),
        passwordHash: `phone-only$${await bcrypt.hash(phone, 4)}`,
        fullName: 'Phone Member',
        roles: ['CUSTOMER'],
      },
    });
    ids.phone = phoneMember.id;
    await seat(suspendedOrg, phoneMember.id, 'ORGANIZER_MANAGER');
    await makeUser('multi', ['CUSTOMER', 'ORGANIZER_OWNER']);
    await seat(suspendedOrg, ids.multi);
    await seat(otherOrg, ids.multi);
  }, 180_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (db && available) {
      const users = await db.user.findMany({
        where: { email: { contains: suffix } },
        select: { id: true },
      });
      const userIds = [...new Set([...users.map((u: { id: string }) => u.id), ids.phone])];
      const where = { booking: { organizationId: { in: orgIds } } };
      await db.notification
        .deleteMany({ where: { OR: [{ userId: { in: userIds } }, where] } })
        .catch(() => undefined);
      await db.guestBookingAccess.deleteMany({ where }).catch(() => undefined);
      await db.receipt.deleteMany({ where }).catch(() => undefined);
      await db.ticket.deleteMany({ where });
      await db.bookingItem.deleteMany({ where });
      await db.paymentAttempt.deleteMany({ where: { payment: where } }).catch(() => undefined);
      await db.payment.deleteMany({ where });
      await db.booking.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.auditLog.deleteMany({
        where: { OR: [{ organizationId: { in: orgIds } }, { actorUserId: { in: userIds } }] },
      });
      await db.accountInvitation.deleteMany({ where: { userId: { in: userIds } } });
      await db.emailVerificationCode.deleteMany({ where: { userId: { in: userIds } } });
      await db.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      const events = { event: { organizationId: { in: orgIds } } };
      await db.ticketInventory.deleteMany({ where: { ticketType: { eventSession: events } } });
      await db.ticketType.deleteMany({ where: { eventSession: events } });
      await db.eventSession.deleteMany({ where: events });
      await db.event.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.venue.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.phoneOtp.deleteMany({ where: { phone } });
      await db.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await db.$disconnect();
    }
    if (app) await app.close();
    process.env = savedEnv;
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  // ─────────────────────────────── 1. Team invitations ───────────────────────────────

  const invite = async (ownerAccess: string, to: string, role = 'ORGANIZER_MANAGER') => {
    const r = await http('POST', `/organizations/${teamOrg}/members`, ownerAccess, {
      email: to,
      role,
    });
    expect(r.status).toBe(201);
    return r;
  };

  maybe('the inviter is never handed the link; it goes to the invitee only', async () => {
    const owner = await login(email('owner'));
    const r = await invite(owner.access, email('invitee'));
    const token = inviteTokenFor(email('invitee'), r.json);

    expect(r.raw).not.toContain(token);
    expect(r.raw).not.toContain('/invite/');
    expect(r.json.inviteUrl).toBeUndefined();
    expect(r.json.invitationEmail).toBe('SENT');
    // The mail went to the invitee's address, and to nobody else.
    const mails = sent.filter(
      (m) => (m.type as string) === 'TEAM_INVITATION' && m.body.includes(token),
    );
    expect(mails.map((m) => m.toEmail)).toEqual([email('invitee')]);
    // Stored hashed: the table never holds the token itself.
    const rows = await db!.accountInvitation.findMany({ where: { userId: ids.invitee } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(token);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // Resend answers the same way: a status, never a link.
    const member = await memberRow(teamOrg, ids.invitee);
    const again = await http(
      'POST',
      `/organizations/${teamOrg}/members/${member!.id}/resend-invite`,
      owner.access,
    );
    expect(again.status).toBe(201);
    expect(again.raw).not.toContain('/invite/');
    expect(again.json.inviteUrl).toBeUndefined();
  });

  maybe('accepting with no session is refused, and the member stays INVITED', async () => {
    const token = inviteTokenFor(email('invitee'));
    const r = await http('POST', `/public/invitations/${token}/accept`, undefined, {});
    expect(r.status).toBe(401);
    expect((await memberRow(teamOrg, ids.invitee))!.status).toBe('INVITED');
  });

  maybe("the inviting owner's own session cannot accept on the invitee's behalf", async () => {
    const owner = await login(email('owner'));
    const token = inviteTokenFor(email('invitee'));
    const r = await http('POST', `/public/invitations/${token}/accept`, owner.access, {});
    expect(r.status).toBe(403);
    expect(errorCode(r)).toBe('INVITATION_WRONG_ACCOUNT');
    expect((await memberRow(teamOrg, ids.invitee))!.status).toBe('INVITED');
    const refused = await auditActions(teamOrg, 'MEMBER_INVITE_REFUSED');
    expect(
      refused.some(
        (a: any) => a.actorUserId === ids.owner && a.metadata?.reason === 'wrong_account',
      ),
    ).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  maybe("another member's or a stranger's session cannot accept either", async () => {
    const token = inviteTokenFor(email('invitee'));
    for (const who of ['manager', 'stranger']) {
      const s = await login(email(who));
      const r = await http('POST', `/public/invitations/${token}/accept`, s.access, {});
      expect(r.status).toBe(403);
      expect(errorCode(r)).toBe('INVITATION_WRONG_ACCOUNT');
    }
    expect((await memberRow(teamOrg, ids.invitee))!.status).toBe('INVITED');
  });

  maybe('the invited account must prove its email first, then joins - and only then', async () => {
    const token = inviteTokenFor(email('invitee'));
    const me = await login(email('invitee'));

    const first = await http('POST', `/public/invitations/${token}/accept`, me.access, {});
    expect(first.status).toBe(403);
    expect(errorCode(first)).toBe('EMAIL_NOT_VERIFIED');
    expect((await memberRow(teamOrg, ids.invitee))!.status).toBe('INVITED');

    // The email-code flow, for the account's OWN address.
    const ask = await http('POST', '/auth/email/confirm/request-code', me.access, {});
    expect(ask.status).toBe(201);
    expect(lastMail(email('invitee'), 'EMAIL_VERIFICATION_CODE')).toBeDefined();
    const wrong = await http('POST', '/auth/email/confirm/verify', me.access, { code: '000000' });
    expect(wrong.status).toBe(400);
    const ok = await http('POST', '/auth/email/confirm/verify', me.access, {
      code: emailCodeFor(email('invitee')),
    });
    expect(ok.status).toBe(201);
    const user = await db!.user.findUnique({ where: { id: ids.invitee } });
    expect(user.emailVerifiedAt).not.toBeNull();

    const accepted = await http('POST', `/public/invitations/${token}/accept`, me.access, {});
    expect(accepted.status).toBe(201);
    expect(accepted.json.organizationId).toBe(teamOrg);
    const member = await memberRow(teamOrg, ids.invitee);
    expect(member!.status).toBe('ACTIVE');
    expect(member!.role).toBe('ORGANIZER_MANAGER');
    const inv = await db!.accountInvitation.findUnique({ where: { userId: ids.invitee } });
    expect(inv.acceptedAt).not.toBeNull();
    const audit = await auditActions(teamOrg, 'MEMBER_INVITE_ACCEPTED');
    expect(audit.some((a: any) => a.actorUserId === ids.invitee)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any

    // Single use: the same link, the same rightful session, refused.
    const again = await http('POST', `/public/invitations/${token}/accept`, me.access, {});
    expect(again.status).toBe(404);
  });

  maybe('an account whose email is already proved joins in one step', async () => {
    const owner = await login(email('owner'));
    await invite(owner.access, email('verified'), 'CHECKIN_STAFF');
    const token = inviteTokenFor(email('verified'));
    const me = await login(email('verified'));
    const r = await http('POST', `/public/invitations/${token}/accept`, me.access, {});
    expect(r.status).toBe(201);
    expect((await memberRow(teamOrg, ids.verified))!.status).toBe('ACTIVE');
  });

  maybe('an expired link is refused, even for the right session', async () => {
    const owner = await login(email('owner'));
    await invite(owner.access, email('invitee2'));
    const token = inviteTokenFor(email('invitee2'));
    await db!.user.update({ where: { id: ids.invitee2 }, data: { emailVerifiedAt: new Date() } });
    await db!.accountInvitation.update({
      where: { userId: ids.invitee2 },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const me = await login(email('invitee2'));
    const r = await http('POST', `/public/invitations/${token}/accept`, me.access, {});
    expect(r.status).toBe(409);
    expect((await memberRow(teamOrg, ids.invitee2))!.status).toBe('INVITED');
  });

  maybe('a resend revokes the old link, and a cancelled invitation is refused', async () => {
    const owner = await login(email('owner'));
    const member = await memberRow(teamOrg, ids.invitee2);
    const old = inviteTokenFor(email('invitee2'));
    const resent = await http(
      'POST',
      `/organizations/${teamOrg}/members/${member!.id}/resend-invite`,
      owner.access,
    );
    expect(resent.status).toBe(201);
    const fresh = inviteTokenFor(email('invitee2'), resent.json);
    expect(fresh).not.toBe(old);
    const me = await login(email('invitee2'));
    const stale = await http('POST', `/public/invitations/${old}/accept`, me.access, {});
    expect(stale.status).toBe(404);

    // Cancel: the owner removes the pending member. The fresh link dies with it.
    const removed = await http(
      'DELETE',
      `/organizations/${teamOrg}/members/${member!.id}`,
      owner.access,
    );
    expect(removed.status).toBe(200);
    /*
      Removal ends the sessions of somebody on no other team (existing rule), so sign in again.
      Token times are whole seconds, so the removal is moved a few seconds back first; otherwise
      a sign-in in the same second still counts as "before the removal".
    */
    await db!.organizationMember.update({
      where: { id: member!.id },
      data: { updatedAt: new Date(Date.now() - 5000) },
    });
    const again = await login(email('invitee2'));
    const r = await http('POST', `/public/invitations/${fresh}/accept`, again.access, {});
    expect([404, 409]).toContain(r.status);
    expect((await memberRow(teamOrg, ids.invitee2))!.status).toBe('REMOVED');
  });

  maybe(
    'somebody with no account claims it with a code sent to the address, then signs in and joins',
    async () => {
      const owner = await login(email('owner'));
      const address = email('newcomer');
      const r = await invite(owner.access, address, 'CHECKIN_STAFF');
      expect(r.json.needsPassword).toBe(true);
      const token = inviteTokenFor(address, r.json);
      const created = await db!.user.findUnique({ where: { email: address } });
      ids.newcomer = created.id;

      // The old hole for a new address: set a password with the link alone. Refused now.
      const blind = await http('POST', `/public/invitations/${token}/accept`, undefined, {
        fullName: 'Newcomer',
        password: NEW_PASSWORD,
      });
      expect(blind.status).toBe(401);
      expect((await memberRow(teamOrg, created.id))!.status).toBe('INVITED');

      // A wrong code sets nothing.
      const ask = await http('POST', `/public/invitations/${token}/account/request-code`);
      expect(ask.status).toBe(201);
      const bad = await http('POST', `/public/invitations/${token}/account`, undefined, {
        code: '000000',
        fullName: 'Newcomer',
        password: NEW_PASSWORD,
      });
      expect(bad.status).toBe(400);
      expect(
        (await db!.user.findUnique({ where: { id: created.id } })).passwordHash.startsWith(
          'invite-pending$',
        ),
      ).toBe(true);

      const claimed = await http('POST', `/public/invitations/${token}/account`, undefined, {
        code: emailCodeFor(address),
        fullName: 'Newcomer',
        password: NEW_PASSWORD,
      });
      expect(claimed.status).toBe(201);
      const user = await db!.user.findUnique({ where: { id: created.id } });
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.fullName).toBe('Newcomer');
      // Claiming the account is not joining the team.
      expect((await memberRow(teamOrg, created.id))!.status).toBe('INVITED');

      const me = await login(address, NEW_PASSWORD);
      const joined = await http('POST', `/public/invitations/${token}/accept`, me.access, {});
      expect(joined.status).toBe(201);
      expect((await memberRow(teamOrg, created.id))!.status).toBe('ACTIVE');
    },
  );

  // ─────────────────────────────── 2. Suspended organizations ────────────────────────

  let preSuspension = { access: '', refresh: '' };
  let eventId = '';

  maybe('before suspension the owner works normally (the baseline)', async () => {
    const venue = await db!.venue.create({
      data: {
        organizationId: suspendedOrg,
        name: `Hall ${suffix}`,
        city: 'Pune',
        country: 'India',
      },
    });
    const event = await db!.event.create({
      data: {
        organizationId: suspendedOrg,
        venueId: venue.id,
        title: `Suspended show ${suffix}`,
        slug: `susp-show-${suffix}`,
        category: 'MUSIC',
        status: 'PUBLISHED',
      },
    });
    eventId = event.id;
    preSuspension = await login(email('suspOwner'));
    const r = await http('GET', `/organizations/${suspendedOrg}`, preSuspension.access);
    expect(r.status).toBe(200);

    await db!.organization.update({ where: { id: suspendedOrg }, data: { status: 'SUSPENDED' } });
  });

  const organizerReads = () => [
    `/organizations/${suspendedOrg}`,
    `/organizations/${suspendedOrg}/members`,
    `/events?organizationId=${suspendedOrg}`,
    `/events/${eventId}/orders`,
    `/payouts?organizationId=${suspendedOrg}`,
    `/analytics/organizer?organizationId=${suspendedOrg}`,
  ];

  const expectSuspendedEverywhere = async (access: string) => {
    for (const path of organizerReads()) {
      const r = await http('GET', path, access);
      expect({ path, status: r.status, code: errorCode(r) }).toEqual({
        path,
        status: 403,
        code: 'ORGANIZATION_SUSPENDED',
      });
    }
    // A write, too: inviting somebody into a suspended organization.
    const w = await http('POST', `/organizations/${suspendedOrg}/members`, access, {
      email: email('nobody'),
      role: 'CHECKIN_STAFF',
    });
    expect(w.status).toBe(403);
    expect(errorCode(w)).toBe('ORGANIZATION_SUSPENDED');
  };

  maybe('a password session gets 403 ORGANIZATION_SUSPENDED on organizer APIs', async () => {
    const s = await login(email('suspOwner'));
    await expectSuspendedEverywhere(s.access);
  });

  maybe('a phone session gets the same answer', async () => {
    const s = await phoneSignIn();
    await expectSuspendedEverywhere(s.access);
  });

  maybe('a refresh token from before the suspension gets the same answer', async () => {
    const r = await http('POST', '/auth/refresh', undefined, {
      refreshToken: preSuspension.refresh,
    });
    expect(r.status).toBeLessThan(300);
    await expectSuspendedEverywhere(r.json.accessToken);
    // And the access token minted before the suspension, too.
    await expectSuspendedEverywhere(preSuspension.access);
  });

  maybe(
    'the console handoff still refuses a member whose only organization is suspended',
    async () => {
      const s = await phoneSignIn();
      const r = await http('POST', '/auth/handoff', s.access, { audience: 'organizer' });
      expect(r.status).toBe(403);
    },
  );

  maybe(
    'the organization list names a suspended organization and nothing else about it',
    async () => {
      const s = await login(email('multi'));
      const r = await http('GET', '/organizations', s.access);
      expect(r.status).toBe(200);
      const susp = r.json.find((o: { id: string }) => o.id === suspendedOrg);
      expect(susp).toBeDefined();
      expect(susp.status).toBe('SUSPENDED');
      expect(susp._count).toBeUndefined();
      expect(susp.contactEmail).toBeUndefined();
      const other = r.json.find((o: { id: string }) => o.id === otherOrg);
      expect(other.status).toBe('APPROVED');
      expect(other._count).toBeDefined();
    },
  );

  maybe('a member of several organizations keeps the ones that are not suspended', async () => {
    const s = await login(email('multi'));
    const ok = await http('GET', `/organizations/${otherOrg}`, s.access);
    expect(ok.status).toBe(200);
    const evs = await http('GET', `/events?organizationId=${otherOrg}`, s.access);
    expect(evs.status).toBe(200);
    const handoff = await http('POST', '/auth/handoff', s.access, { audience: 'organizer' });
    expect(handoff.status).toBe(201);
    const blocked = await http('GET', `/organizations/${suspendedOrg}`, s.access);
    expect(blocked.status).toBe(403);
    expect(errorCode(blocked)).toBe('ORGANIZATION_SUSPENDED');
  });

  maybe('signing in still works, and the person can still buy tickets', async () => {
    const s = await login(email('suspOwner'));
    const me = await http('GET', '/auth/me', s.access);
    expect(me.status).toBe(200);
    expect((await http('GET', '/bookings', s.access)).status).toBe(200);

    // A free ticket for somebody else's event: purchasing is not an organizer API.
    const venue = await db!.venue.create({
      data: {
        organizationId: otherOrg,
        name: `Open hall ${suffix}`,
        city: 'Pune',
        country: 'India',
      },
    });
    const event = await db!.event.create({
      data: {
        organizationId: otherOrg,
        venueId: venue.id,
        title: `Open show ${suffix}`,
        slug: `open-show-${suffix}`,
        category: 'MUSIC',
        status: 'PUBLISHED',
        isFree: true,
      },
    });
    const startsAt = new Date(Date.now() + 5 * 86_400_000);
    const session = await db!.eventSession.create({
      data: { eventId: event.id, startsAt, endsAt: new Date(startsAt.getTime() + 7_200_000) },
    });
    const tt = await db!.ticketType.create({
      data: {
        eventSessionId: session.id,
        name: 'General',
        priceMinor: 0,
        currency: 'INR',
        quantityTotal: 50,
        inventory: { create: { quantityTotal: 50 } },
      },
    });
    const b = await http('POST', '/bookings', s.access, {
      eventSessionId: session.id,
      items: [{ ticketTypeId: tt.id, quantity: 1 }],
      buyerName: 'Suspended Owner',
      buyerEmail: email('suspOwner'),
    });
    expect(b.status).toBe(201);
  });

  maybe(
    'platform staff keep their capability-checked access, and a staff member cannot use a seat to bypass it',
    async () => {
      const access = app!.get(OrgAccessService);
      // Staff with ORGANIZER_READ and no seat: the admin console's read still works.
      const reader = await makeUser('staffReader', ['ADMIN']);
      await db!.adminGrant.create({ data: { userId: reader.id, permission: 'ORGANIZER_READ' } });
      const readerUser = { id: reader.id, email: reader.email, fullName: 'r', roles: ['ADMIN'] };
      await expect(
        access.assertMember(readerUser as never, suspendedOrg, undefined, {
          permission: 'ORGANIZER_READ' as never,
          operation: 'organization.read',
        }),
      ).resolves.toBeUndefined();

      // Staff holding a SEAT in the suspended organization but no capability: the seat does not
      // let them in.
      const seated = await makeUser('staffSeated', ['ADMIN']);
      await seat(suspendedOrg, seated.id);
      const seatedUser = { id: seated.id, email: seated.email, fullName: 's', roles: ['ADMIN'] };
      await expect(
        access.assertMember(seatedUser as never, suspendedOrg, undefined, {
          permission: 'ORGANIZER_READ' as never,
          operation: 'organization.read',
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(access.assertMember(seatedUser as never, suspendedOrg)).rejects.toMatchObject({
        status: 403,
      });

      // Reinstating is an admin route, untouched; afterwards the owner is back in.
      await db!.organization.update({ where: { id: suspendedOrg }, data: { status: 'APPROVED' } });
      const s = await login(email('suspOwner'));
      expect((await http('GET', `/organizations/${suspendedOrg}`, s.access)).status).toBe(200);
      await db!.adminGrant.deleteMany({ where: { userId: { in: [reader.id, seated.id] } } });
    },
  );
});
