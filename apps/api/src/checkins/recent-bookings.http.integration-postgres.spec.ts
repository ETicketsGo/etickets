import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';

/**
 * integration-real-postgres, over HTTP: Bookings & attendees lists recent bookings by default
 * (PROD, 2026-11-05). A confirmed free booking had been emailed and checked in, and the page
 * showed "Search to see bookings" as if there were none.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;
const PASSWORD = 'Vermilion-Lantern-4821!';

describe('integration-real-postgres: recent bookings list', () => {
  const url = process.env.DATABASE_URL;
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;
  const savedEnv = { ...process.env };
  const suffix = `recent-${Date.now()}-${randomBytes(3).toString('hex')}`;
  // Lower case: sign-in normalises the address it is given.
  const email = (who: string) => `${who.toLowerCase()}-${suffix}@test.invalid`;
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const orgIds: string[] = [];

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
    return {
      status: res.status,
      json:
        json?.data && !Array.isArray(json.data) && json.nextCursor === undefined ? json.data : json,
    };
  }

  async function freeEvent(orgId: string, ownerToken: string, label: string) {
    const venue = await db!.venue.create({
      data: {
        organizationId: orgId,
        name: 'Online',
        city: 'Online',
        country: 'United States',
        timezone: 'America/Boise',
      },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `QA-TEST ${label} ${suffix}`,
        slug: `${label.toLowerCase()}-${suffix}`,
        category: 'Community',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        isFree: true,
      },
    });
    const start = Date.now() + 6 * 86_400_000;
    const session = await db!.eventSession.create({
      data: { eventId: event.id, startsAt: new Date(start), endsAt: new Date(start + 3_600_000) },
    });
    const tt = await http('POST', '/events/ticket-types', ownerToken, {
      eventSessionId: session.id,
      name: 'General',
      priceMinor: 0,
      quantityTotal: 50,
      maxPerOrder: 4,
    });
    return { sessionId: session.id, ticketTypeId: tt.json.id as string, eventId: event.id };
  }

  const book = (ev: { sessionId: string; ticketTypeId: string }) =>
    http('POST', '/bookings', tokens.buyer, {
      eventSessionId: ev.sessionId,
      items: [{ ticketTypeId: ev.ticketTypeId, quantity: 1 }],
      buyerName: `QA Buyer ${suffix}`,
      buyerEmail: email('buyer'),
    });

  beforeAll(async () => {
    if (!url) return;
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      return;
    }
    Object.assign(process.env, {
      APP_ENV: 'LOCAL',
      ORGANIZER_WEB_URL: 'https://organizer.example.test',
      ADMIN_WEB_URL: 'https://admin.example.test',
      THROTTLE_LIMIT: '100000',
      AUTH_THROTTLE_LIMIT: '100000',
    });
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-for-recent-spec-0123456789abcdef';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-for-recent-spec-0123456789';
    process.env.QR_SIGNING_SECRET ??= 'test-qr-secret-for-recent-spec-0123456789';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret-for-recent-spec-0123456789';
    const { AppModule } = await import('../app.module');
    const { AllExceptionsFilter } = await import('../common/all-exceptions.filter');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    for (const label of ['Mine', 'Other']) {
      const o = await db!.organization.create({
        data: {
          name: `QA-TEST ${label} ${suffix}`,
          slug: `${label.toLowerCase()}-org-${suffix}`,
          status: 'APPROVED',
        },
      });
      orgIds.push(o.id);
      ids[`org${label}`] = o.id;
    }
    for (const who of ['owner', 'otherOwner', 'buyer']) {
      const u = await db!.user.create({
        data: {
          email: email(who),
          passwordHash: await bcrypt.hash(PASSWORD, 4),
          fullName: who,
          roles: ['CUSTOMER'],
          emailVerifiedAt: new Date(),
        },
      });
      ids[who] = u.id;
      tokens[who] = (
        await http('POST', '/auth/login', undefined, { email: email(who), password: PASSWORD })
      ).json.accessToken;
    }
    await db!.organizationMember.create({
      data: {
        organizationId: ids.orgMine,
        userId: ids.owner,
        role: 'ORGANIZER_OWNER',
        status: 'ACTIVE',
      },
    });
    await db!.organizationMember.create({
      data: {
        organizationId: ids.orgOther,
        userId: ids.otherOwner,
        role: 'ORGANIZER_OWNER',
        status: 'ACTIVE',
      },
    });
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      const userIds = ['owner', 'otherOwner', 'buyer'].map((k) => ids[k]).filter(Boolean);
      const where = { booking: { organizationId: { in: orgIds } } };
      await db.notification
        .deleteMany({ where: { OR: [{ userId: { in: userIds } }, where] } })
        .catch(() => undefined);
      await db.checkIn
        .deleteMany({ where: { ticket: { organizationId: { in: orgIds } } } })
        .catch(() => undefined);
      await db.ticket.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.receipt
        .deleteMany({ where: { organizationId: { in: orgIds } } })
        .catch(() => undefined);
      await db.receiptCounter
        .deleteMany({ where: { OR: orgIds.map((o) => ({ scope: { startsWith: o } })) } })
        .catch(() => undefined);
      await db.bookingItem.deleteMany({ where });
      await db.payment.deleteMany({ where }).catch(() => undefined);
      await db.booking.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.auditLog.deleteMany({
        where: { OR: [{ organizationId: { in: orgIds } }, { actorUserId: { in: userIds } }] },
      });
      await db.ticketType.deleteMany({
        where: { eventSession: { event: { organizationId: { in: orgIds } } } },
      });
      await db.eventSession.deleteMany({ where: { event: { organizationId: { in: orgIds } } } });
      await db.event.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.venue.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
      await db.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
      await db.$disconnect();
    }
    if (app) await app.close();
    process.env = savedEnv;
  });

  it('lists a free booking with no search, its check-in count, and no contact details', async () => {
    if (!available) return;
    const mine = await freeEvent(ids.orgMine, tokens.owner, 'MineEvent');
    const other = await freeEvent(ids.orgOther, tokens.otherOwner, 'OtherEvent');
    const b1 = await book(mine);
    expect(b1.json.status).toBe('CONFIRMED');
    await book(other);
    const ticket = await db!.ticket.findFirst({ where: { bookingId: b1.json.id } });
    await http('POST', '/checkins/visual', tokens.owner, { ticketId: ticket.id });

    const r = await http(
      'GET',
      `/checkins/bookings/recent?organizationId=${ids.orgMine}`,
      tokens.owner,
    );
    expect(r.status).toBe(200);
    const rows = r.json.data;
    expect(rows.map((x: { id: string }) => x.id)).toEqual([b1.json.id]);
    expect(rows[0]).toMatchObject({
      totalMinor: 0,
      ticketCount: 1,
      checkedInCount: 1,
      status: 'CONFIRMED',
    });
    expect(JSON.stringify(rows)).not.toContain(email('buyer'));
    expect(rows[0]).not.toHaveProperty('buyerEmail');
  });

  it('pages newest first with a cursor, no row twice, and leaves out abandoned holds by default', async () => {
    if (!available) return;
    const ev = await freeEvent(ids.orgMine, tokens.owner, 'Paging');
    for (let i = 0; i < 4; i++) await book(ev);
    // An abandoned hold on this organization: listed only when asked for.
    const first = await db!.booking.findFirst({ where: { organizationId: ids.orgMine } });
    await db!.booking.update({ where: { id: first.id }, data: { status: 'EXPIRED' } });

    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      const r = await http(
        'GET',
        `/checkins/bookings/recent?organizationId=${ids.orgMine}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        tokens.owner,
      );
      seen.push(...r.json.data.map((x: { id: string }) => x.id));
      if (!r.json.nextCursor) break;
      cursor = r.json.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(first.id);
    expect(seen).toHaveLength(4);
    const expired = await http(
      'GET',
      `/checkins/bookings/recent?organizationId=${ids.orgMine}&status=EXPIRED`,
      tokens.owner,
    );
    expect(expired.json.data.map((x: { id: string }) => x.id)).toEqual([first.id]);
  });

  it("refuses another organization's owner and caps the page size", async () => {
    if (!available) return;
    const foreign = await http(
      'GET',
      `/checkins/bookings/recent?organizationId=${ids.orgMine}`,
      tokens.otherOwner,
    );
    expect(foreign.status).toBe(403);
    const huge = await http(
      'GET',
      `/checkins/bookings/recent?organizationId=${ids.orgMine}&limit=500`,
      tokens.owner,
    );
    expect(huge.status).toBe(400);
  });
});
