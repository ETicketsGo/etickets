import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EventSellabilityService } from './event-sellability.service';
import { EventsService } from './events.service';
import { ShowsService } from '../shows/shows.service';
import { VenuesService } from '../venues/venues.service';

/**
 * integration-real-postgres - a standing space's capacity is a real cap, and a venue that has
 * sold keeps its clock.
 *
 * Found walking QA (R-round L2): "Walk L2 Lawn - holds 100" and a general-admission event at
 * its venue with 500 tickets on sale, accepted, because nothing tied a session to a standing
 * space. And a venue's time zone could be changed under sessions that had sold, re-labelling
 * every ticket's start time.
 *
 * Real Postgres because the cap is checked under a row lock and the two concurrent adds are the
 * case a stub cannot show. Skips (never fabricates a pass) when no database is reachable.
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

const ORGANIZER = { id: 'itest-standing', email: 's@t.test', fullName: 'S', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const noAudit = { record: async () => undefined } as never;
const noAudience = { notifyAdmins: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

describe('integration-real-postgres: standing capacity and the venue clock', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let events: EventsService;
  let venues: VenuesService;

  const suffix = `standing-${Date.now()}`;
  let orgId = '';
  let venueId = '';
  let lawnId = '';
  let eventId = '';
  let userId = '';

  const at = (days: number, hours = 0) =>
    new Date(Date.now() + days * 86_400_000 + hours * 3_600_000);
  const session = async () =>
    events.addSession(ORGANIZER, eventId, {
      startsAt: at(30),
      endsAt: at(30, 3),
      standingSpaceId: lawnId,
    } as never);
  const ticket = (sessionId: string, name: string, quantityTotal: number) =>
    events.addTicketType(ORGANIZER, {
      eventSessionId: sessionId,
      name,
      priceMinor: 50_000,
      quantityTotal,
      maxPerOrder: 6,
    } as never);

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }
    const shows = new ShowsService(db as never, allowAll, noAudit, cfg);
    events = new EventsService(
      db as never,
      allowAll,
      noAudit,
      noAudience,
      cfg,
      shows,
      new EventSellabilityService(db as never),
    );
    venues = new VenuesService(db as never, allowAll);

    const org = await db!.organization.create({
      data: { name: `Standing ${suffix}`, slug: `standing-${suffix}` },
    });
    orgId = org.id;
    const venue = await db!.venue.create({
      data: {
        organizationId: orgId,
        name: `Park ${suffix}`,
        city: 'Meridian',
        country: 'United States',
        region: 'Idaho',
        timezone: 'America/New_York',
      },
    });
    venueId = venue.id;
    const lawn = await venues.addSpace(ORGANIZER, venueId, {
      name: `Lawn ${suffix}`,
      screenType: '2D',
      capacity: 100,
      kind: 'STANDING',
    } as never);
    lawnId = lawn.id;
    const event = await events.create(ORGANIZER, orgId, {
      title: `Lawn Gig ${suffix}`,
      category: 'Music',
      venueId,
      feeMode: 'CUSTOMER_PAYS',
      isFree: false,
    } as never);
    eventId = event.id;
    const user = await db!.user.create({
      data: { email: `${suffix}@t.test`, fullName: 'Buyer', passwordHash: 'x' },
    });
    userId = user.id;
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    try {
      await db.booking.deleteMany({ where: { eventId } });
      await db.ticketInventory.deleteMany({
        where: { ticketType: { eventSession: { eventId } } },
      });
      await db.ticketType.deleteMany({ where: { eventSession: { eventId } } });
      await db.eventSession.deleteMany({ where: { eventId } });
      await db.event.deleteMany({ where: { organizationId: orgId } });
      await db.screen.deleteMany({ where: { venueId } });
      await db.cinema.deleteMany({ where: { organizationId: orgId } });
      await db.venue.deleteMany({ where: { organizationId: orgId } });
      await db.organization.deleteMany({ where: { id: orgId } });
      await db.user.deleteMany({ where: { id: userId } });
    } finally {
      await db.$disconnect();
    }
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

  maybe('a session can be held in a standing space, and stays general admission', async () => {
    const s = await session();
    const row = await db!.eventSession.findUnique({ where: { id: s.id } });
    expect(row.standingSpaceId).toBe(lawnId);
    // Never seated: the booking path reads `screenId` and must still see general admission.
    expect(row.screenId).toBeNull();
    expect(row.seatMapId).toBeNull();
  });

  maybe('500 tickets for a lawn that holds 100 are refused, with what it holds', async () => {
    const s = await session();
    await expect(ticket(s.id, 'General', 500)).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.stringContaining('holds 100 people'),
        details: expect.objectContaining({ reason: 'STANDING_CAPACITY_EXCEEDED' }),
      }),
    });
    expect(await db!.ticketType.count({ where: { eventSessionId: s.id } })).toBe(0);
  });

  maybe('ticket types add up against the cap, and editing one up past it is refused', async () => {
    const s = await session();
    await ticket(s.id, 'General', 70);
    const vip = await ticket(s.id, 'VIP', 30);
    await expect(ticket(s.id, 'Late', 1)).rejects.toMatchObject({
      response: expect.objectContaining({ message: expect.stringContaining('add no more') }),
    });
    await expect(
      events.updateTicketType(ORGANIZER, vip.id, { quantityTotal: 31 } as never),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        details: expect.objectContaining({ reason: 'STANDING_CAPACITY_EXCEEDED' }),
      }),
    });
    // Taking one off sale frees its share.
    await events.updateTicketType(ORGANIZER, vip.id, { status: 'INACTIVE' } as never);
    await ticket(s.id, 'Late', 30);
  });

  maybe('two ticket types added at the same moment cannot together pass the cap', async () => {
    const s = await session();
    const results = await Promise.allSettled([ticket(s.id, 'A', 60), ticket(s.id, 'B', 60)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await db!.ticketType.findMany({ where: { eventSessionId: s.id } });
    expect(rows.reduce((n: number, r: { quantityTotal: number }) => n + r.quantityTotal, 0)).toBe(
      60,
    );
  });

  maybe('a session already over the cap is flagged, not changed, and may come down', async () => {
    // 500 on sale before the session was put in the lawn: linking it says by how much.
    const s = await events.addSession(ORGANIZER, eventId, {
      startsAt: at(31),
      endsAt: at(31, 3),
    } as never);
    const general = await ticket(s.id, 'General', 500);
    const linked = await events.setStandingSpace(ORGANIZER, s.id, lawnId);
    expect(linked.overCapacityBy).toBe(400);
    expect((await db!.ticketType.findUnique({ where: { id: general.id } })).quantityTotal).toBe(
      500,
    );
    const space = await venues.getSpace(ORGANIZER, lawnId);
    expect(space.standingSessions.find((x) => x.sessionId === s.id)?.overCapacityBy).toBe(400);
    // Lowering is allowed even while still over; raising is not.
    await events.updateTicketType(ORGANIZER, general.id, { quantityTotal: 300 } as never);
    await expect(
      events.updateTicketType(ORGANIZER, general.id, { quantityTotal: 301 } as never),
    ).rejects.toBeDefined();
  });

  maybe('a seated space cannot be named as a standing one', async () => {
    const hall = await venues.addSpace(ORGANIZER, venueId, {
      name: `Hall ${suffix}`,
      screenType: '2D',
      capacity: 50,
      kind: 'SEATED_HALL',
    } as never);
    await expect(
      events.addSession(ORGANIZER, eventId, {
        startsAt: at(32),
        endsAt: at(32, 2),
        standingSpaceId: hall.id,
      } as never),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        details: expect.objectContaining({ reason: 'SPACE_NOT_STANDING' }),
      }),
    });
  });

  maybe(
    'an unsold venue moves to its right clock and its sessions keep their local time',
    async () => {
      // Every session so far is unsold. 19:00 typed on the wrong (Eastern) clock...
      const typed = new Date('2027-03-20T23:00:00Z'); // 19:00 in New York (EDT)
      const s = await events.addSession(ORGANIZER, eventId, {
        startsAt: typed,
        endsAt: new Date(typed.getTime() + 3 * 3_600_000),
      } as never);
      const result = await venues.update(ORGANIZER, venueId, {
        timezone: 'America/Boise',
      } as never);
      expect(result.timezone).toBe('America/Boise');
      expect(result.sessionsKeptLocalTime).toBeGreaterThan(0);
      const after = await db!.eventSession.findUnique({ where: { id: s.id } });
      // ...is still 19:00, now in Boise (MDT, UTC-6).
      expect(after.startsAt.toISOString()).toBe('2027-03-21T01:00:00.000Z');
    },
  );

  maybe('a venue with a sold session keeps its clock, and says why', async () => {
    const s = await events.addSession(ORGANIZER, eventId, {
      startsAt: at(40),
      endsAt: at(40, 3),
    } as never);
    await db!.booking.create({
      data: {
        organizationId: orgId,
        userId,
        eventId,
        eventSessionId: s.id,
        buyerName: 'Buyer',
        buyerEmail: `${suffix}@t.test`,
        holdExpiresAt: at(0, 1),
        status: 'CONFIRMED',
        subtotalMinor: 50_000,
        totalMinor: 50_000,
        currency: 'USD',
      },
    });
    const before = await db!.eventSession.findUnique({ where: { id: s.id } });
    await expect(
      venues.update(ORGANIZER, venueId, { timezone: 'America/Chicago' } as never),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.stringContaining("You cannot change this venue's time zone"),
        details: expect.objectContaining({ reason: 'TIMEZONE_LOCKED_BY_SALES', soldSessions: 1 }),
      }),
    });
    const venue = await db!.venue.findUnique({ where: { id: venueId } });
    expect(venue.timezone).toBe('America/Boise');
    const after = await db!.eventSession.findUnique({ where: { id: s.id } });
    expect(after.startsAt.toISOString()).toBe(before.startsAt.toISOString());
    // A rename is still fine: only the clock is locked.
    await venues.update(ORGANIZER, venueId, { name: `Park renamed ${suffix}` } as never);
  });
});
