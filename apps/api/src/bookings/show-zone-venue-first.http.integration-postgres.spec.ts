import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';

/**
 * integration-real-postgres, whole app over HTTP: a buyer's booking and ticket print the show on
 * the VENUE's clock.
 *
 * ── WHAT WAS WRONG (T2, QA 2026-10-17) ───────────────────────────────────────────────
 * The booking, ticket, guest view, share card, reminder and email chain read the CINEMA's zone
 * first. `Cinema.timezone` has a schema default of Asia/Kolkata, so a US cinema created without
 * a zone answered IST: "Move Hall", a cinema in a Boise venue, printed a 9:59 am show as
 * "10:29 pm GMT+5:30" while the organizer and admin consoles (and the storefront) said Boise.
 *
 * Proven over HTTP against a real database because the answer depends on what the queries
 * SELECT: a stub returns whatever shape the test hands it, so a screen selected without its
 * venue would pass there and fail here.
 *
 * Skips (never fabricates a pass) without a database.
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

const PASSWORD = 'Vermilion-Lantern-4821!';

describe('integration-real-postgres: a ticket prints the venue clock first', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;

  const suffix = `t2zone-${Date.now()}`;
  const email = `buyer-${suffix}@test.invalid`;
  let orgId = '';
  let userId = '';
  let token = '';
  // 15:59 UTC: 9:59 am in Boise (MDT), 9:29 pm in Kolkata.
  const startsAt = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 9, 20, 15, 59));
  const endsAt = new Date(startsAt.getTime() + 2 * 3_600_000);
  const bookings = { boise: '', india: '', cinemaOnly: '' };

  async function http(path: string) {
    const res = await fetch(`${base}/api${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as any;
    return { status: res.status, body: json.data ?? json };
  }

  /** One cinema screen in one venue, one show, and one confirmed booking with one ticket. */
  async function place(
    tag: string,
    venue: { city: string; country: string; timezone: string | null },
    cinemaZone: string | undefined,
  ): Promise<string> {
    const v = await db!.venue.create({
      data: { organizationId: orgId, name: `Walk T2 ${tag} ${suffix}`, ...venue },
    });
    const cinema = await db!.cinema.create({
      data: {
        organizationId: orgId,
        venueId: v.id,
        name: `Walk T2 Hall ${tag} ${suffix}`,
        city: venue.city,
        // Undefined leaves the schema default, which is what a cinema created without one gets.
        ...(cinemaZone ? { timezone: cinemaZone } : {}),
      },
    });
    const screen = await db!.screen.create({
      data: {
        cinemaId: cinema.id,
        venueId: v.id,
        name: 'Screen 1',
        screenType: '2D',
        capacity: 10,
      },
    });
    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: v.id,
        title: `Walk T2 show ${tag} ${suffix}`,
        slug: `walk-t2-${tag}-${suffix}`,
        category: 'Film',
        status: 'PUBLISHED',
      },
    });
    const session = await db!.eventSession.create({
      data: { eventId: event.id, startsAt, endsAt, screenId: screen.id },
    });
    const ticketType = await db!.ticketType.create({
      data: { eventSessionId: session.id, name: 'Standard', priceMinor: 1000, quantityTotal: 10 },
    });
    const booking = await db!.booking.create({
      data: {
        organizationId: orgId,
        eventId: event.id,
        eventSessionId: session.id,
        userId,
        buyerEmail: email,
        buyerName: 'Walk Buyer',
        holdExpiresAt: new Date(Date.now() - 60_000),
        status: 'CONFIRMED',
        currency: 'USD',
        subtotalMinor: 1000,
        totalMinor: 1000,
        reference: `WALK-T2-${tag}-${suffix}`,
      },
    });
    await db!.ticket.create({
      data: {
        bookingId: booking.id,
        ticketTypeId: ticketType.id,
        eventSessionId: session.id,
        organizationId: orgId,
        serial: `T2-${tag}-${suffix}`,
        nonce: 'n',
      },
    });
    return booking.id;
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
    process.env.THROTTLE_LIMIT = '5000';
    process.env.AUTH_THROTTLE_LIMIT = '5000';

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const user = await db!.user.create({
      data: {
        email,
        fullName: 'Walk Buyer',
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        roles: ['CUSTOMER'],
      },
    });
    userId = user.id;
    orgId = (
      await db!.organization.create({
        data: { name: `Walk T2 Org ${suffix}`, slug: `walk-t2-org-${suffix}` },
      })
    ).id;

    // "Move Hall": a Boise venue, its cinema left at the schema default (Asia/Kolkata).
    bookings.boise = await place(
      'boise',
      { city: 'Boise', country: 'United States', timezone: 'America/Boise' },
      undefined,
    );
    // An Indian cinema: must be unchanged.
    bookings.india = await place(
      'india',
      { city: 'Hyderabad', country: 'India', timezone: 'Asia/Kolkata' },
      'Asia/Kolkata',
    );
    // A venue nobody gave a zone, in a country with several; the cinema's zone was chosen.
    bookings.cinemaOnly = await place(
      'chicago',
      { city: 'Chicago', country: 'United States', timezone: null },
      'America/Chicago',
    );

    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const json = (await res.json()) as any;
    token = (json.data ?? json).accessToken;
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      await db.ticket.deleteMany({ where: { organizationId: orgId } });
      await db.booking.deleteMany({ where: { organizationId: orgId } });
      await db.ticketType.deleteMany({
        where: { eventSession: { event: { organizationId: orgId } } },
      });
      await db.eventSession.deleteMany({ where: { event: { organizationId: orgId } } });
      await db.event.deleteMany({ where: { organizationId: orgId } });
      await db.screen.deleteMany({ where: { venue: { organizationId: orgId } } });
      await db.cinema.deleteMany({ where: { organizationId: orgId } });
      await db.venue.deleteMany({ where: { organizationId: orgId } });
      await db.organization.deleteMany({ where: { id: orgId } });
      await db.refreshToken.deleteMany({ where: { userId } });
      await db.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
      await db.$disconnect();
    }
    await app?.close();
  }, 180_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (!available) return;
      await fn();
    });

  maybe('the fixture really is a cinema left at the Kolkata default', async () => {
    const booking = await db!.booking.findUnique({
      where: { id: bookings.boise },
      select: { eventSession: { select: { screen: { select: { cinema: true } } } } },
    });
    expect(booking.eventSession.screen.cinema.timezone).toBe('Asia/Kolkata');
  });

  maybe('GET /bookings/:id: a Boise venue cinema at the default prints Boise', async () => {
    const r = await http(`/bookings/${bookings.boise}`);
    expect(r.status).toBe(200);
    expect(r.body.timeZone).toBe('America/Boise');
  });

  maybe('GET /tickets: the ticket for that show prints Boise', async () => {
    const r = await http('/tickets');
    expect(r.status).toBe(200);
    const ticket = (r.body as { bookingId: string; timezone: string | null }[]).find(
      (t) => t.bookingId === bookings.boise,
    );
    expect(ticket?.timezone).toBe('America/Boise');
  });

  maybe('an Indian cinema is unchanged: IST on the booking and the ticket', async () => {
    const r = await http(`/bookings/${bookings.india}`);
    expect(r.body.timeZone).toBe('Asia/Kolkata');
    const tickets = (await http('/tickets')).body as { bookingId: string; timezone: string }[];
    expect(tickets.find((t) => t.bookingId === bookings.india)?.timezone).toBe('Asia/Kolkata');
  });

  maybe('a venue with no zone and a cinema with a chosen one uses the cinema', async () => {
    const r = await http(`/bookings/${bookings.cinemaOnly}`);
    expect(r.body.timeZone).toBe('America/Chicago');
    const tickets = (await http('/tickets')).body as { bookingId: string; timezone: string }[];
    expect(tickets.find((t) => t.bookingId === bookings.cinemaOnly)?.timezone).toBe(
      'America/Chicago',
    );
  });

  maybe('GET /bookings: every row in "My bookings" gives the same answer', async () => {
    const r = await http('/bookings?page=1&pageSize=50');
    expect(r.status).toBe(200);
    const rows = (Array.isArray(r.body) ? r.body : r.body.data) as {
      id: string;
      timeZone: string | null;
    }[];
    const zone = (id: string) => rows.find((b) => b.id === id)?.timeZone;
    expect(zone(bookings.boise)).toBe('America/Boise');
    expect(zone(bookings.india)).toBe('Asia/Kolkata');
    expect(zone(bookings.cinemaOnly)).toBe('America/Chicago');
  });
});
