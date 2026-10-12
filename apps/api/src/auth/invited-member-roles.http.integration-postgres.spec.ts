import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../app.module';
import { QrService } from '../tickets/qr.service';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { effectiveRoles, JwtStrategy } from './jwt.strategy';

/**
 * integration-real-postgres, whole app over HTTP: an invited teammate gets the role their
 * seat names, in THEIR organization only.
 *
 * What was wrong: inviting someone created a user with global roles [CUSTOMER], and accepting
 * only flipped the membership row to ACTIVE. The JWT strategy put the GLOBAL roles on the
 * request and RolesGuard checks those, so an invited CHECKIN_STAFF was refused at /checkins
 * and an invited manager at every manager route. Seeded accounts have the global role set by
 * hand, so nothing caught it.
 *
 * Everything here goes through the real stack (guards, strategy, Postgres) because the defect
 * lived in the join between them. Skips (never fabricates a pass) without a database.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../../.env', '../../../../../.env']) {
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

const PASSWORD = 'Vermilion-Lantern-4821!';

describe('integration-real-postgres: invited member roles over HTTP', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let qr: QrService;
  let available = false;

  const suffix = `inv-roles-${Date.now()}`;
  const orgIds: string[] = [];
  const tickets: Record<'A' | 'B', { id: string; sessionId: string; nonce: string }> = {
    A: { id: '', sessionId: '', nonce: '' },
    B: { id: '', sessionId: '', nonce: '' },
  };
  const orgs: Record<'A' | 'B', string> = { A: '', B: '' };
  let ownerToken = '';
  let customerToken = '';

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
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  const login = async (email: string) => {
    const r = await http('POST', '/auth/login', undefined, { email, password: PASSWORD });
    expect(r.status).toBeLessThan(300);
    return (r.json.data ?? r.json).accessToken as string;
  };

  /** Invite over HTTP as the owner, accept over HTTP, sign in. */
  async function inviteAndAccept(email: string, role: string, accept = true) {
    const inv = await http('POST', `/organizations/${orgs.A}/members`, ownerToken, { email, role });
    expect(JSON.stringify(inv)).toMatch(/^{"status":2/);
    const data = inv.json.data ?? inv.json;
    if (!accept) return { memberId: data.id as string, token: '' };
    const inviteToken = String(data.inviteUrl).split('/').pop()!;
    const acc = await http('POST', `/public/invitations/${inviteToken}/accept`, undefined, {
      password: PASSWORD,
      fullName: 'Invitee Person',
    });
    expect(acc.status).toBeLessThan(300);
    return { memberId: data.id as string, token: await login(email) };
  }

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
    process.env.DATABASE_URL = url;
    process.env.APP_ENV = process.env.APP_ENV ?? 'LOCAL';
    process.env.ORGANIZER_WEB_URL = 'https://organizer.example.test';
    process.env.THROTTLE_LIMIT = '5000';
    process.env.AUTH_THROTTLE_LIMIT = '5000';

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    qr = app.get(QrService);

    const hash = await bcrypt.hash(PASSWORD, 10);
    const owner = await db!.user.create({
      data: {
        email: `owner-${suffix}@test.invalid`,
        fullName: 'Owner',
        passwordHash: hash,
        roles: ['ORGANIZER_OWNER'],
      },
    });
    await db!.user.create({
      data: {
        email: `cust-${suffix}@test.invalid`,
        fullName: 'Customer',
        passwordHash: hash,
        roles: ['CUSTOMER'],
      },
    });

    for (const k of ['A', 'B'] as const) {
      const org = await db!.organization.create({
        data: {
          name: `Org ${k} ${suffix}`,
          slug: `org-${k.toLowerCase()}-${suffix}`,
          status: 'APPROVED',
        },
      });
      orgs[k] = org.id;
      orgIds.push(org.id);
      const venue = await db!.venue.create({
        data: { organizationId: org.id, name: `Venue ${k}`, city: 'Hyderabad' },
      });
      const event = await db!.event.create({
        data: {
          organizationId: org.id,
          venueId: venue.id,
          title: `Show ${k} ${suffix}`,
          slug: `show-${k.toLowerCase()}-${suffix}`,
          category: 'MUSIC',
        },
      });
      const session = await db!.eventSession.create({
        data: {
          eventId: event.id,
          startsAt: new Date(Date.now() - 10 * 60_000),
          endsAt: new Date(Date.now() + 2 * 3_600_000),
        },
      });
      const tt = await db!.ticketType.create({
        data: { eventSessionId: session.id, name: 'GA', priceMinor: 0, quantityTotal: 50 },
      });
      const booking = await db!.booking.create({
        data: {
          organizationId: org.id,
          eventId: event.id,
          eventSessionId: session.id,
          status: 'CONFIRMED',
          buyerName: 'Buyer',
          buyerEmail: 'buyer@test.invalid',
          currency: 'INR',
          subtotalMinor: 0,
          totalMinor: 0,
          holdExpiresAt: new Date(Date.now() + 3_600_000),
          reference: `INV-${k}-${suffix}`,
        },
      });
      const t = await db!.ticket.create({
        data: {
          bookingId: booking.id,
          ticketTypeId: tt.id,
          eventSessionId: session.id,
          organizationId: org.id,
          serial: `TKT-${k}-${suffix}`,
          nonce: `n-${k}-${suffix}`,
          status: 'ACTIVE',
          holderName: 'Holder',
        },
      });
      tickets[k] = { id: t.id, sessionId: session.id, nonce: t.nonce };
    }
    await db!.organizationMember.create({
      data: { organizationId: orgs.A, userId: owner.id, role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
    });
    ownerToken = await login(`owner-${suffix}@test.invalid`);
    customerToken = await login(`cust-${suffix}@test.invalid`);
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      const users = await db.user.findMany({
        where: { email: { contains: suffix } },
        select: { id: true },
      });
      const ids = users.map((u: { id: string }) => u.id);
      // The registration test creates an organization by name; match it even if that test
      // failed before it could record the id.
      const extra = await db.organization.findMany({
        where: { name: { contains: suffix } },
        select: { id: true },
      });
      for (const o of extra as { id: string }[]) if (!orgIds.includes(o.id)) orgIds.push(o.id);
      await db.checkIn.deleteMany({ where: { ticket: { organizationId: { in: orgIds } } } });
      await db.booking.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.accountInvitation.deleteMany({ where: { userId: { in: ids } } });
      await db.auditLog.deleteMany({
        where: { OR: [{ organizationId: { in: orgIds } }, { actorUserId: { in: ids } }] },
      });
      await db.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.event.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.venue.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    }
    if (app) await app.close();
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

  const scan = (token: string, who: 'A' | 'B') =>
    http('POST', '/checkins', token, {
      token: qr.sign({
        ticketId: tickets[who].id,
        eventSessionId: tickets[who].sessionId,
        nonce: tickets[who].nonce,
        version: 1,
      }),
    });
  const sessionsOf = (token: string, org: 'A' | 'B') =>
    http('GET', `/checkins/sessions?organizationId=${orgs[org]}`, token);
  const reverse = (token: string, who: 'A' | 'B') =>
    http('POST', '/checkins/reverse', token, { ticketId: tickets[who].id });

  it('unions only the three seat roles, and never invents others', () => {
    expect(effectiveRoles(['CUSTOMER'] as never, ['CHECKIN_STAFF'] as never)).toEqual([
      'CUSTOMER',
      'CHECKIN_STAFF',
    ]);
    expect(effectiveRoles(['CUSTOMER'] as never, ['ADMIN', 'SUPER_ADMIN'] as never)).toEqual([
      'CUSTOMER',
    ]);
  });

  maybe(
    'a newly invited and accepted CHECKIN_STAFF lists sessions and scans their ticket',
    async () => {
      const { token } = await inviteAndAccept(`gate-${suffix}@test.invalid`, 'CHECKIN_STAFF');
      expect((await sessionsOf(token, 'A')).status).toBe(200);
      const ok = await scan(token, 'A');
      expect(ok.status).toBeLessThan(300);
      expect(JSON.stringify(ok.json)).toContain('SUCCESS');
    },
  );

  maybe('...but is refused another organization, by session list and by ticket', async () => {
    const { token } = await inviteAndAccept(`gate2-${suffix}@test.invalid`, 'CHECKIN_STAFF');
    expect((await sessionsOf(token, 'B')).status).toBe(403);
    expect((await scan(token, 'B')).status).toBe(403);
    expect(await db!.checkIn.count({ where: { ticketId: tickets.B.id } })).toBe(0);
  });

  maybe('check-in staff do not gain manager powers', async () => {
    const { token } = await inviteAndAccept(`gate3-${suffix}@test.invalid`, 'CHECKIN_STAFF');
    expect((await reverse(token, 'A')).status).toBe(403);
  });

  maybe('an INVITED (not accepted) member is refused', async () => {
    const email = `pending-${suffix}@test.invalid`;
    await inviteAndAccept(email, 'CHECKIN_STAFF', false);
    // They cannot sign in until they accept, so give the account a known password directly.
    // The membership row stays INVITED, which is the thing under test.
    const u = await db!.user.findUniqueOrThrow({ where: { email } });
    await db!.user.update({
      where: { id: u.id },
      data: { passwordHash: await bcrypt.hash(PASSWORD, 10) },
    });
    const token = await login(email);
    expect((await sessionsOf(token, 'A')).status).toBe(403);
  });

  maybe('a removed member is refused on the very next request', async () => {
    const { token, memberId } = await inviteAndAccept(
      `gone-${suffix}@test.invalid`,
      'CHECKIN_STAFF',
    );
    expect((await sessionsOf(token, 'A')).status).toBe(200);
    await db!.organizationMember.update({ where: { id: memberId }, data: { status: 'REMOVED' } });
    // Same access token, no new sign-in.
    expect((await sessionsOf(token, 'A')).status).toBe(403);
  });

  maybe('a role change takes effect on the next request, in both directions', async () => {
    const { token, memberId } = await inviteAndAccept(
      `shift-${suffix}@test.invalid`,
      'ORGANIZER_MANAGER',
    );
    await db!.organizationMember.update({
      where: { id: memberId },
      data: { role: 'CHECKIN_STAFF' },
    });
    expect((await reverse(token, 'A')).status).toBe(403);
    await db!.organizationMember.update({
      where: { id: memberId },
      data: { role: 'ORGANIZER_MANAGER' },
    });
    expect((await reverse(token, 'A')).status).not.toBe(403);
  });

  maybe('an invited MANAGER does a manager action, only in their own organization', async () => {
    const { token } = await inviteAndAccept(`mgr-${suffix}@test.invalid`, 'ORGANIZER_MANAGER');
    // Reverse is @Roles(MANAGER, OWNER, ...): a check-in staff member is refused there.
    // A reversal needs an admitted ticket; scanning an already-admitted one is harmless.
    await scan(token, 'A');
    expect((await reverse(token, 'A')).status).toBeLessThan(300);
    // The role opens the door; membership still closes it for another organization.
    expect((await reverse(token, 'B')).status).toBe(403);
  });

  maybe('customers gain nothing, and no seat role is written onto a user row', async () => {
    expect((await sessionsOf(customerToken, 'A')).status).toBe(403);
    expect((await scan(customerToken, 'A')).status).toBe(403);
    const cust = await db!.user.findFirstOrThrow({
      where: { email: { contains: `cust-${suffix}` } },
    });
    expect(cust.roles).toEqual(['CUSTOMER']);
    const gate = await db!.user.findFirstOrThrow({
      where: { email: { contains: `gate-${suffix}` } },
    });
    expect(gate.roles).toEqual(['CUSTOMER']);
  });

  maybe('registering an organization never persists a team-seat role globally', async () => {
    const email = `reg-${suffix}@test.invalid`;
    const { token } = await inviteAndAccept(email, 'CHECKIN_STAFF');
    const created = await http('POST', '/organizations', token, {
      name: `Own Org ${suffix}`,
      legalName: 'Own Org Pvt Ltd',
      legalEntityType: 'COMPANY',
      registeredCountry: 'IN',
    });
    expect(created.status).toBeLessThan(300);
    const row = await db!.user.findUniqueOrThrow({ where: { email } });
    // Their own organization makes them its owner, and nothing else leaks from org A's seat.
    expect([...row.roles].sort()).toEqual(['CUSTOMER', 'ORGANIZER_OWNER']);
    const own = (created.json.data ?? created.json).id as string;
    if (own) orgIds.push(own);
  });

  // Last on purpose: constructing a JwtStrategy re-registers passport's global 'jwt' strategy
  // with this test's fake secret, which would 401 every HTTP call that follows.
  /*
    The route-level tests above cannot see INVITED or REMOVED seats being excluded from the
    union: the handler's own membership check refuses those anyway (defence in depth). So the
    door itself is asserted here, on what the strategy puts on the request.
  */
  maybe('only ACTIVE seats add roles to the request user', async () => {
    const strategy = new JwtStrategy({ getOrThrow: () => 'unused-secret' } as never, db as never);
    const mk = async (tag: string, status: 'ACTIVE' | 'INVITED' | 'REMOVED', role: string) => {
      const u = await db!.user.create({
        data: {
          email: `${tag}-${suffix}@test.invalid`,
          fullName: tag,
          passwordHash: 'x',
          roles: ['CUSTOMER'],
        },
      });
      await db!.organizationMember.create({
        data: { organizationId: orgs.A, userId: u.id, role, status },
      });
      return strategy.validate({ sub: u.id, email: u.email, name: tag, roles: [] });
    };
    expect((await mk('s-active', 'ACTIVE', 'CHECKIN_STAFF')).roles).toEqual([
      'CUSTOMER',
      'CHECKIN_STAFF',
    ]);
    expect((await mk('s-invited', 'INVITED', 'CHECKIN_STAFF')).roles).toEqual(['CUSTOMER']);
    expect((await mk('s-removed', 'REMOVED', 'ORGANIZER_MANAGER')).roles).toEqual(['CUSTOMER']);
  });
});
