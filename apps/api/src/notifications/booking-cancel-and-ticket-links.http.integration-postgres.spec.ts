import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { ShowCancellationFanoutService } from './producers/show-cancellation-fanout.service';
import { CancellationRefundsService } from '../refunds/cancellation-refunds.service';

/**
 * integration-real-postgres, whole app over HTTP: what a buyer is told when a booking ends, and
 * how an account holder's confirmation gets them to their tickets.
 *
 * The defects (owner, 2026-10-20):
 *   - BOOKING_CANCELLED had a template in both languages and no producer. A buyer who cancelled
 *     their free booking heard nothing.
 *   - The account holder's BOOKING_CONFIRMED carried a reference and nothing to press. Only a
 *     guest got a link.
 *
 * And the duplicate this must not create: a booking ended by a cancelled show is told once, by
 * SHOW_CANCELLED, never also by BOOKING_CANCELLED.
 *
 * Only rows are read. No worker runs here, so nothing is delivered, and every row this creates
 * is removed afterwards. Skips (never fabricates a pass) without a database.
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

const PASSWORD = 'Saffron-Harbour-6152!';
const SITE = 'https://shop.walk.eticketsgo.com';

describe('integration-real-postgres: booking cancelled notices and ticket links', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;

  const suffix = `r2-${Date.now()}`;
  let orgId = '';
  let ownerToken = '';
  let buyerToken = '';
  let buyerId = '';
  const savedEnv = { ...process.env };

  async function http(
    method: string,
    path: string,
    token?: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
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

  const login = async (email: string) => {
    const r = await http('POST', '/auth/login', undefined, { email, password: PASSWORD });
    expect(r.status).toBeLessThan(300);
    return r.json.accessToken as string;
  };

  /** A published GA event with one future date and one ticket type. Free when price is 0. */
  async function gaEvent(label: string, priceMinor: number) {
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `Hall ${label}`, city: 'Bengaluru', country: 'India' },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Walk ${label} ${suffix}`,
        slug: `walk-${label.toLowerCase()}-${suffix}`,
        category: 'MUSIC',
        status: 'PUBLISHED',
        isFree: priceMinor === 0,
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
        priceMinor,
        currency: 'INR',
        quantityTotal: 100,
        inventory: { create: { quantityTotal: 100 } },
      },
    });
    return { eventId: event.id, sessionId: session.id, ticketTypeId: tt.id, title: event.title };
  }

  async function book(
    show: { sessionId: string; ticketTypeId: string },
    who: { token?: string; anon?: string; email: string },
    quantity = 1,
  ) {
    const r = await http(
      'POST',
      who.token ? '/bookings' : '/bookings/guest',
      who.token,
      {
        eventSessionId: show.sessionId,
        items: [{ ticketTypeId: show.ticketTypeId, quantity }],
        buyerName: 'Walk Buyer',
        buyerEmail: who.email,
      },
      who.anon ? { 'x-anon-session': who.anon } : {},
    );
    expect(r.status).toBe(201);
    return r.json as { id: string; status: string };
  }

  /** The notification rows about a booking, of one type. */
  const rows = (bookingId: string, type: string) =>
    db!.notification.findMany({ where: { bookingId, type }, orderBy: { channel: 'asc' } });

  /** One intent, however many channels it went to: the email row stands for it. */
  const emails = async (bookingId: string, type: string) =>
    (await rows(bookingId, type)).filter((n: { channel: string }) => n.channel === 'email');

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
    process.env.APP_ENV = 'LOCAL';
    process.env.CUSTOMER_WEB_URL = SITE;
    process.env.THROTTLE_LIMIT = '5000';
    process.env.AUTH_THROTTLE_LIMIT = '5000';

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const hash = await bcrypt.hash(PASSWORD, 10);
    const owner = await db!.user.create({
      data: {
        email: `owner-${suffix}@test.invalid`,
        passwordHash: hash,
        fullName: 'Walk Owner',
        roles: ['ORGANIZER_OWNER'],
      },
    });
    const buyer = await db!.user.create({
      data: {
        email: `buyer-${suffix}@test.invalid`,
        passwordHash: hash,
        fullName: 'Walk Buyer',
        roles: ['CUSTOMER'],
      },
    });
    buyerId = buyer.id;
    const org = await db!.organization.create({
      data: {
        name: `Walk R2 ${suffix}`,
        slug: `walk-r2-${suffix}`,
        status: 'APPROVED',
        contactEmail: `box-office-${suffix}@test.invalid`,
      },
    });
    orgId = org.id;
    await db!.organizationMember.create({
      data: { organizationId: orgId, userId: owner.id, role: 'ORGANIZER_OWNER', status: 'ACTIVE' },
    });
    ownerToken = await login(owner.email);
    buyerToken = await login(buyer.email);
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      const users = await db.user.findMany({
        where: { email: { contains: suffix } },
        select: { id: true },
      });
      const ids = users.map((u: { id: string }) => u.id);
      const where = { booking: { organizationId: orgId } };
      await db.notification
        .deleteMany({ where: { OR: [{ userId: { in: ids } }, where] } })
        .catch(() => undefined);
      await db.guestBookingAccess.deleteMany({ where }).catch(() => undefined);
      await db.receipt.deleteMany({ where }).catch(() => undefined);
      await db.refund.deleteMany({ where: { organizationId: orgId } });
      await db.ticket.deleteMany({ where });
      await db.bookingItem.deleteMany({ where });
      await db.paymentAttempt.deleteMany({ where: { payment: where } }).catch(() => undefined);
      await db.payment.deleteMany({ where });
      await db.booking.deleteMany({ where: { organizationId: orgId } });
      await db.auditLog.deleteMany({
        where: { OR: [{ organizationId: orgId }, { actorUserId: { in: ids } }] },
      });
      await db.organizationMember.deleteMany({ where: { organizationId: orgId } });
      const events = { event: { organizationId: orgId } };
      await db.ticketInventory.deleteMany({ where: { ticketType: { eventSession: events } } });
      await db.ticketType.deleteMany({ where: { eventSession: events } });
      await db.eventSession.deleteMany({ where: events });
      await db.event.deleteMany({ where: { organizationId: orgId } });
      await db.venue.deleteMany({ where: { organizationId: orgId } });
      await db.organization.deleteMany({ where: { id: orgId } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
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

  maybe(
    "an account holder's confirmation links to the booking's tickets page on the customer site",
    async () => {
      const show = await gaEvent('Paid', 50_000);
      const booking = await book(show, {
        token: buyerToken,
        email: `buyer-${suffix}@test.invalid`,
      });
      expect(booking.status).toBe('PENDING_PAYMENT');
      const paid = await http('POST', `/payments/${booking.id}/mock-pay`, undefined, {
        outcome: 'succeeded',
      });
      expect(paid.status).toBeLessThan(300);

      const [confirmation] = await emails(booking.id, 'BOOKING_CONFIRMED');
      expect(confirmation.userId).toBe(buyerId);
      expect(confirmation.payload).toMatchObject({
        bookingId: booking.id,
        link: `${SITE}/account/bookings/${booking.id}/tickets`,
        linkTo: 'ACCOUNT_TICKETS',
      });
      // It is a page, not a credential: no guest token was minted for an account booking.
      expect(await db!.guestBookingAccess.count({ where: { bookingId: booking.id } })).toBe(0);
    },
  );

  maybe("a guest's confirmation still carries the access link and nothing new", async () => {
    const show = await gaEvent('GuestFree', 0);
    const booking = await book(show, {
      anon: `anon-${suffix}-guest-token-0123456789abcdef`,
      email: `guest-${suffix}@test.invalid`,
    });
    expect(booking.status).toBe('CONFIRMED');

    const [confirmation] = await emails(booking.id, 'BOOKING_CONFIRMED');
    expect(confirmation.userId).toBeNull();
    expect(confirmation.toEmail).toBe(`guest-${suffix}@test.invalid`);
    const payload = confirmation.payload as Record<string, unknown>;
    expect(String(payload.link)).toMatch(new RegExp(`^${SITE}/booking/access/[A-Za-z0-9_-]+$`));
    expect(payload).not.toHaveProperty('linkTo');
  });

  maybe(
    'a buyer who cancels their free booking is sent exactly one BOOKING_CANCELLED',
    async () => {
      const show = await gaEvent('Free', 0);
      const booking = await book(
        show,
        { token: buyerToken, email: `buyer-${suffix}@test.invalid` },
        2,
      );
      expect(booking.status).toBe('CONFIRMED');
      const reference = (await db!.booking.findUniqueOrThrow({ where: { id: booking.id } }))
        .reference;

      const r = await http('POST', '/refunds', buyerToken, {
        bookingId: booking.id,
        reason: 'I cannot make it',
      });
      expect(r.status).toBeLessThan(300);
      expect(r.json).toMatchObject({ outcome: 'CANCELLED', bookingStatus: 'CANCELLED' });

      const told = await emails(booking.id, 'BOOKING_CANCELLED');
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ userId: buyerId, status: 'PENDING' });
      expect(told[0].payload).toMatchObject({
        bookingId: booking.id,
        reference,
        eventTitle: show.title,
        refundStatus: 'NOTHING_TO_REFUND',
      });
      // Not a show cancellation, and not a refund nobody will ever pay.
      expect(await rows(booking.id, 'SHOW_CANCELLED')).toHaveLength(0);
      expect(await rows(booking.id, 'REFUND_REQUESTED')).toHaveLength(0);

      // Asking again is refused and tells nobody a second time.
      const again = await http('POST', '/refunds', buyerToken, {
        bookingId: booking.id,
        reason: 'I cannot make it',
      });
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(await emails(booking.id, 'BOOKING_CANCELLED')).toHaveLength(1);
    },
  );

  maybe('giving back one ticket of two keeps the booking and sends no cancellation', async () => {
    const show = await gaEvent('Partial', 0);
    const booking = await book(
      show,
      { token: buyerToken, email: `buyer-${suffix}@test.invalid` },
      2,
    );
    const [first] = await db!.ticket.findMany({ where: { bookingId: booking.id } });
    const r = await http('POST', '/refunds', buyerToken, {
      bookingId: booking.id,
      reason: 'One of us cannot come',
      ticketIds: [first.id],
    });
    expect(r.status).toBeLessThan(300);
    expect(r.json.bookingStatus).toBe('CONFIRMED');
    expect(await rows(booking.id, 'BOOKING_CANCELLED')).toHaveLength(0);
  });

  maybe('cancelling an unpaid hold tells nobody: no money, no tickets, no reference', async () => {
    const show = await gaEvent('Hold', 50_000);
    const booking = await book(show, { token: buyerToken, email: `buyer-${suffix}@test.invalid` });
    const r = await http('POST', `/bookings/${booking.id}/cancel`, buyerToken);
    expect(r.status).toBeLessThan(300);
    expect(r.json.status).toBe('CANCELLED');
    expect(await db!.notification.count({ where: { bookingId: booking.id } })).toBe(0);
  });

  maybe(
    'a free booking on a cancelled event is told once, by SHOW_CANCELLED, never BOOKING_CANCELLED',
    async () => {
      const show = await gaEvent('Called off', 0);
      const booking = await book(show, {
        token: buyerToken,
        email: `buyer-${suffix}@test.invalid`,
      });
      expect(booking.status).toBe('CONFIRMED');

      const r = await http('POST', `/events/${show.eventId}/cancel`, ownerToken, {
        reason: 'The band cannot travel.',
      });
      expect(r.status).toBe(201);
      expect((await db!.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
        'CANCELLED',
      );

      // The fan-out runs afterwards here (in-process delivery is off, as on QA) and must add
      // nothing: the booking has been told already.
      await app!.get(ShowCancellationFanoutService).fanOut(show.sessionId);

      const shown = await emails(booking.id, 'SHOW_CANCELLED');
      expect(shown).toHaveLength(1);
      expect(shown[0].payload).toMatchObject({
        bookingId: booking.id,
        eventTitle: show.title,
        refundStatus: 'NOTHING_TO_REFUND',
      });
      expect(await rows(booking.id, 'BOOKING_CANCELLED')).toHaveLength(0);
      expect(await rows(booking.id, 'REFUND_REQUESTED')).toHaveLength(0);
    },
  );

  maybe(
    'when the fan-out tells a free booking first, the cancellation that follows adds nothing',
    async () => {
      const show = await gaEvent('Fanout first', 0);
      const booking = await book(show, {
        token: buyerToken,
        email: `buyer-${suffix}@test.invalid`,
      });

      // One date cancelled: nothing opens refunds synchronously on this route.
      const r = await http('POST', `/shows/${show.sessionId}/cancel`, ownerToken, {
        reason: 'The hall is flooded.',
      });
      expect(r.status).toBeLessThan(300);
      await app!.get(ShowCancellationFanoutService).fanOut(show.sessionId);
      const first = await emails(booking.id, 'SHOW_CANCELLED');
      expect(first).toHaveLength(1);
      // A free booking is not promised a refund.
      expect(first[0].payload).toMatchObject({ refundStatus: 'NOTHING_TO_REFUND' });

      // Then the cancellation "refunds" run and end the free booking.
      await app!.get(CancellationRefundsService).openFor(show.sessionId);
      expect((await db!.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
        'CANCELLED',
      );
      expect(await emails(booking.id, 'SHOW_CANCELLED')).toHaveLength(1);
      expect(await rows(booking.id, 'BOOKING_CANCELLED')).toHaveLength(0);
    },
  );
});
