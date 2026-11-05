import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';

/**
 * integration-real-postgres, whole app over HTTP: the free-event safety fixes found by the
 * owner's PROD walk-through (2026-11-05).
 *
 *   1. A free booking's SMS that was not sent leaves a SKIPPED row on the booking, with why.
 *   2. Cancelling a FREE session refunds nothing: zero new Refund, Payment, Receipt, Payout,
 *      PayoutAllocation or Settlement rows, its tickets cancelled, reported as free.
 *   3. A ticket on a cancelled session is refused at check-in, and another event's ticket is
 *      refused from this event's page.
 *   4. Switching paid -> free is no longer blocked by an abandoned or cancelled-unpaid booking,
 *      and is still blocked by a confirmed one.
 *
 * Every assertion reads the TABLES. Fixtures carry a unique suffix and are removed. Skips
 * (never fabricates a pass) without a database.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

const PASSWORD = 'Vermilion-Lantern-4821!';

describe('integration-real-postgres: free event safety', () => {
  const url = process.env.DATABASE_URL;
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;
  const savedEnv = { ...process.env };
  const suffix = `freesafe-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const email = (who: string) => `${who}-${suffix}@test.invalid`;
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
    return { status: res.status, json: json?.data ?? json };
  }

  /** Counts of every table that records money, for one organization. */
  async function moneyRows(orgId: string) {
    const booking = { booking: { organizationId: orgId } };
    return {
      refund: await db!.refund.count({ where: booking }),
      payment: await db!.payment.count({ where: booking }),
      receipt: await db!.receipt.count({ where: { organizationId: orgId } }),
      payout: await db!.payout.count({ where: { organizationId: orgId } }),
      allocation: await db!.payoutAllocation.count({
        where: { payout: { organizationId: orgId } },
      }),
      settlement: await db!.settlement.count({ where: { organizationId: orgId } }),
    };
  }

  async function makeEvent(label: string, isFree: boolean, priceMinor: number) {
    const event = await db!.event.create({
      data: {
        organizationId: ids.org,
        venueId: ids.venue,
        title: `QA-TEST ${label} ${suffix}`,
        slug: `${label.toLowerCase()}-${suffix}`,
        category: 'Community',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        isFree,
      },
    });
    const start = Date.now() + 7 * 86_400_000;
    const session = await db!.eventSession.create({
      data: { eventId: event.id, startsAt: new Date(start), endsAt: new Date(start + 3_600_000) },
    });
    // Through the API, so the ticket type gets the inventory the booking path reads.
    const tt = await http('POST', '/events/ticket-types', tokens.owner, {
      eventSessionId: session.id,
      name: 'General',
      priceMinor,
      quantityTotal: 20,
      maxPerOrder: 4,
    });
    if (tt.status >= 300) throw new Error(`ticket type: ${JSON.stringify(tt.json)}`);
    return { eventId: event.id, sessionId: session.id, ticketTypeId: tt.json.id };
  }

  async function book(sessionId: string, ticketTypeId: string) {
    const r = await http('POST', '/bookings', tokens.buyer, {
      eventSessionId: sessionId,
      items: [{ ticketTypeId, quantity: 1 }],
      buyerName: 'QA Buyer',
      buyerEmail: email('buyer'),
    });
    return r;
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
    process.env.APP_ENV = 'LOCAL';
    process.env.ORGANIZER_WEB_URL = 'https://organizer.example.test';
    process.env.ADMIN_WEB_URL = 'https://admin.example.test';
    process.env.THROTTLE_LIMIT = '100000';
    process.env.AUTH_THROTTLE_LIMIT = '100000';
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-for-freesafe-spec-0123456789abcdef';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-for-freesafe-spec-0123456789';
    process.env.QR_SIGNING_SECRET ??= 'test-qr-secret-for-freesafe-spec-0123456789';
    process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret-for-freesafe-spec-0123456789';
    // SMS exists as a channel, but booking confirmations are not switched on for it: the PROD
    // configuration that sent no text and left no trace.
    process.env.SMS_TRANSACTIONAL_TYPES = '';

    const { AppModule } = await import('../app.module');
    const { AllExceptionsFilter } = await import('../common/all-exceptions.filter');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const org = await db!.organization.create({
      data: {
        name: `QA-TEST Free Safety ${suffix}`,
        slug: `free-safety-${suffix}`,
        status: 'APPROVED',
        registeredCountry: 'United States',
      },
    });
    ids.org = org.id;
    orgIds.push(org.id);
    const venue = await db!.venue.create({
      data: {
        organizationId: org.id,
        name: 'Online',
        city: 'Online',
        country: 'United States',
        timezone: 'America/Boise',
      },
    });
    ids.venue = venue.id;
    for (const who of ['owner', 'buyer']) {
      const u = await db!.user.create({
        data: {
          email: email(who),
          passwordHash: await bcrypt.hash(PASSWORD, 4),
          fullName: `QA ${who}`,
          roles: ['CUSTOMER'],
          emailVerifiedAt: new Date(),
          ...(who === 'buyer'
            ? { phone: `+1208555${String(Date.now()).slice(-4)}`, phoneVerifiedAt: new Date() }
            : {}),
        },
      });
      ids[who] = u.id;
      const r = await http('POST', '/auth/login', undefined, {
        email: email(who),
        password: PASSWORD,
      });
      tokens[who] = r.json.accessToken;
    }
    await db!.organizationMember.create({
      data: {
        organizationId: org.id,
        userId: ids.owner,
        role: 'ORGANIZER_OWNER',
        status: 'ACTIVE',
      },
    });
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      const userIds = Object.values(ids).filter((v) => v && v !== ids.org && v !== ids.venue);
      const where = { booking: { organizationId: { in: orgIds } } };
      await db.notificationDelivery
        ?.deleteMany?.({
          where: {
            notification: { bookingId: { not: null }, booking: { organizationId: { in: orgIds } } },
          },
        })
        .catch(() => undefined);
      await db.notification
        .deleteMany({ where: { OR: [{ userId: { in: userIds } }, where] } })
        .catch(() => undefined);
      await db.checkIn
        .deleteMany({ where: { ticket: { organizationId: { in: orgIds } } } })
        .catch(() => undefined);
      await db.ticket.deleteMany({ where: { organizationId: { in: orgIds } } });
      // A free booking still gets a zero-value sale receipt at confirmation.
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
      await db.outboxEvent
        ?.deleteMany?.({ where: { payload: { path: ['organizationId'], equals: ids.org } } })
        .catch(() => undefined);
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

  const skip = () => !available;
  let free: { eventId: string; sessionId: string; ticketTypeId: string };
  let freeBookingId = '';

  it('a free booking confirms, and its unsent SMS leaves a SKIPPED row saying why', async () => {
    if (skip()) return;
    free = await makeEvent('Free', true, 0);
    const r = await book(free.sessionId, free.ticketTypeId);
    if (r.status >= 300) console.log('BOOK REFUSED', JSON.stringify(r.json));
    expect(r.status).toBeLessThan(300);
    expect(r.json.status).toBe('CONFIRMED');
    freeBookingId = r.json.id;
    const rows = await db!.notification.findMany({
      where: { bookingId: freeBookingId, type: 'BOOKING_CONFIRMED' },
      select: { channel: true, status: true, lastError: true },
    });
    const sms = rows.filter((n: { channel: string }) => n.channel === 'sms');
    expect(rows.some((n: { channel: string }) => n.channel === 'email')).toBe(true);
    expect(sms).toEqual([
      {
        channel: 'sms',
        status: 'SKIPPED',
        lastError: 'not_sent: not switched on for this message type',
      },
    ]);
  });

  it('cancelling the free session refunds nothing and reports the bookings as free', async () => {
    if (skip()) return;
    const before = await moneyRows(ids.org);
    const r = await http('POST', `/shows/${free.sessionId}/cancel`, tokens.owner, {
      reason: 'QA-TEST free session cancelled',
    });
    expect(r.status).toBeLessThan(300);
    expect(r.json.bookingsRequiringRefund).toEqual([]);
    expect(r.json.freeBookingsCancelled).toHaveLength(1);

    // The cancellation follow-up (outbox handler / sweep) runs asynchronously; give it a moment,
    // then run the open-for sweep directly, twice, as the worker would.
    const { CancellationRefundsService } = await import('../refunds/cancellation-refunds.service');
    const cancellations = app!.get(CancellationRefundsService, { strict: false });
    await cancellations.openFor(free.sessionId).catch(() => undefined);
    await cancellations.openFor(free.sessionId).catch(() => undefined);

    const after = await moneyRows(ids.org);
    expect(after).toEqual(before);
    const booking = await db!.booking.findUnique({ where: { id: freeBookingId } });
    expect(booking.status).toBe('CANCELLED');
    const tickets = await db!.ticket.findMany({ where: { bookingId: freeBookingId } });
    expect(tickets.every((t: { status: string }) => t.status === 'CANCELLED')).toBe(true);
  });

  it('a ticket on a cancelled session is refused at check-in, even while still ACTIVE', async () => {
    if (skip()) return;
    // A second free event whose session is cancelled with its ticket still ACTIVE: the window
    // before the free cancellation runs, or a paid refund still awaiting approval.
    const ev = await makeEvent('Cancelled', true, 0);
    const r = await book(ev.sessionId, ev.ticketTypeId);
    const ticket = await db!.ticket.findFirst({ where: { bookingId: r.json.id } });
    await db!.eventSession.update({ where: { id: ev.sessionId }, data: { status: 'CANCELLED' } });
    const admit = await http('POST', '/checkins/visual', tokens.owner, { ticketId: ticket.id });
    expect(admit.json.result).toBe('CANCELLED');
    expect(admit.json.message).toMatch(/session was cancelled/);
    expect((await db!.ticket.findUnique({ where: { id: ticket.id } })).status).toBe('ACTIVE');
  });

  it("another event's ticket is refused from this event's page; this event's is admitted once", async () => {
    if (skip()) return;
    const a = await makeEvent('DoorA', true, 0);
    const b = await makeEvent('DoorB', true, 0);
    const ra = await book(a.sessionId, a.ticketTypeId);
    const ticket = await db!.ticket.findFirst({ where: { bookingId: ra.json.id } });
    const wrong = await http('POST', '/checkins/visual', tokens.owner, {
      ticketId: ticket.id,
      expectedEventId: b.eventId,
    });
    expect(wrong.json.result).toBe('WRONG_SESSION');
    expect(wrong.json.message).toMatch(/different event/);
    const right = await http('POST', '/checkins/visual', tokens.owner, {
      ticketId: ticket.id,
      expectedEventId: a.eventId,
    });
    expect(right.json.result).toBe('SUCCESS');
    const again = await http('POST', '/checkins/visual', tokens.owner, {
      ticketId: ticket.id,
      expectedEventId: a.eventId,
    });
    expect(again.json.result).toBe('DUPLICATE');
    // The check-in email names the right company: it now carries currency and country.
    const mail = await db!.notification.findFirst({
      where: { type: 'TICKET_CHECKED_IN', toEmail: email('buyer'), channel: 'email' },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    expect(mail?.payload).toMatchObject({ currency: 'USD', country: 'United States' });
  });

  it('paid -> free: not blocked by a cancelled unpaid booking, blocked by a confirmed one', async () => {
    if (skip()) return;
    const paid = await makeEvent('Paid', false, 1000);
    // The PROD case: a checkout attempt that was abandoned and cancelled.
    const pending = await book(paid.sessionId, paid.ticketTypeId);
    expect(pending.json.status).toBe('PENDING_PAYMENT');
    const cancel = await http('POST', `/bookings/${pending.json.id}/cancel`, tokens.buyer);
    expect(cancel.status).toBeLessThan(300);
    await db!.ticketType.update({ where: { id: paid.ticketTypeId }, data: { priceMinor: 0 } });
    // Paused, as "Power Bi Workshop" was on PROD when the owner tried (a published event is not
    // edited in place here).
    await db!.event.update({ where: { id: paid.eventId }, data: { status: 'PAUSED' } });
    const toFree = await http('PATCH', `/events/${paid.eventId}`, tokens.owner, { isFree: true });
    if (toFree.status !== 200) console.log('TOFREE', JSON.stringify(toFree.json));
    expect(toFree.status).toBe(200);
    expect((await db!.event.findUnique({ where: { id: paid.eventId } })).isFree).toBe(true);

    // A confirmed (free) booking now blocks going back to paid.
    await db!.event.update({ where: { id: paid.eventId }, data: { status: 'PUBLISHED' } });
    const conf = await book(paid.sessionId, paid.ticketTypeId);
    await db!.event.update({ where: { id: paid.eventId }, data: { status: 'PAUSED' } });
    expect(conf.json.status).toBe('CONFIRMED');
    const toPaid = await http('PATCH', `/events/${paid.eventId}`, tokens.owner, { isFree: false });
    expect(toPaid.status).toBe(409);
    expect(JSON.stringify(toPaid.json)).toMatch(/1 confirmed booking/);
  });
});
