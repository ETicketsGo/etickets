import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EventSellabilityService } from '../events/event-sellability.service';
import { EventsService } from '../events/events.service';
import { ShowsService } from '../shows/shows.service';
import { VenuesService } from '../venues/venues.service';

/**
 * integration-real-postgres - an auditorium sells numbered seats, and is not a cinema.
 *
 * -- WHAT THIS PROVES ---------------------------------------------------------------------
 * The whole chain, with NO cinema row anywhere in it:
 *
 *     VENUE -> SPACE -> LAYOUT -> SESSION -> per-seat inventory
 *
 * Until this migration that was impossible. `Screen.cinemaId` was NOT NULL, so a bookable
 * area could only exist by hanging off a cinema, and an arena, an auditorium or a concert
 * hall had to be created as one to sell a reserved seat. The seated-events suite next door
 * still says so in its own fixture comment - "a cinema row is what owns a room today" - and
 * creates a cinema purely to get a screen. That comment describes the defect this closes.
 *
 * Checked against a real database because what matters is what was WRITTEN: that `cinemaId`
 * is genuinely null, that a layout attached, that the space is OFFERED to the event wizard,
 * and that a session on it produced real seats. A stub returns whatever it is handed.
 *
 * Skips rather than fabricating a pass when no database is reachable.
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

const ORGANIZER = { id: 'itest-space', email: 'sp@t.test', fullName: 'S', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const noAudit = { record: async () => undefined } as never;
const noAudience = { notifyAdmins: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

describe('integration-real-postgres: a space in a venue, with no cinema', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let venues: VenuesService;
  let events: EventsService;
  let shows: ShowsService;

  const suffix = `space-${Date.now()}`;
  let orgId = '';
  let venueId = '';
  let spaceId = '';
  let eventId = '';

  /**
   * An auditorium in two blocks at two prices, with a gangway down the middle of the stalls.
   *
   * Irregular on purpose: the shape a real hall has, not the rectangle a cinema has.
   */
  const LAYOUT = {
    name: 'Auditorium',
    sections: [
      {
        name: 'Stalls',
        categoryName: 'Stalls',
        basePriceMinor: 50_000,
        rowLabels: ['A', 'B'],
        seatsPerRow: 8,
        // A gangway, not a seat. Nobody sits in it and nobody may buy it.
        seatKinds: [
          { rowLabel: 'A', seats: [4, 5], kind: 'GAP' },
          { rowLabel: 'B', seats: [4, 5], kind: 'GAP' },
        ],
      },
      {
        name: 'Balcony',
        categoryName: 'Balcony',
        basePriceMinor: 25_000,
        rowLabels: ['C'],
        seatsPerRow: 6,
      },
    ],
  };

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

    shows = new ShowsService(db as never, allowAll, noAudit, cfg);
    venues = new VenuesService(db as never, allowAll);
    events = new EventsService(
      db as never,
      allowAll,
      noAudit,
      noAudience,
      cfg,
      shows,
      new EventSellabilityService(db as never),
    );

    const org = await db!.organization.create({
      data: { name: `Space ${suffix}`, slug: `space-${suffix}` },
    });
    orgId = org.id;

    const venue = await venues.create(ORGANIZER, orgId, {
      name: `Sai Nigamagamam ${suffix}`,
      city: 'Hyderabad',
      country: 'India',
      region: 'Telangana',
    } as never);
    venueId = venue.id;

    // THE CALL THAT COULD NOT BE MADE BEFORE.
    const space = await venues.addSpace(ORGANIZER, venueId, {
      name: 'Auditorium',
      screenType: '2D',
      capacity: 500,
    } as never);
    spaceId = space.id;

    await shows.generateSeatMap(ORGANIZER, spaceId, LAYOUT as never);

    const event = await events.create(ORGANIZER, orgId, {
      title: `Recital ${suffix}`,
      category: 'Music',
      venueId,
      feeMode: 'CUSTOMER_PAYS',
      isFree: false,
    } as never);
    eventId = event.id;
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.showSeat.deleteMany({ where: { seat: { seatMap: { screenId: spaceId } } } });
    await db.ticketInventory.deleteMany({ where: { ticketType: { eventSession: { eventId } } } });
    await db.ticketType.deleteMany({ where: { eventSession: { eventId } } });
    await db.eventSession.deleteMany({ where: { eventId } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.seat.deleteMany({ where: { seatMap: { screenId: spaceId } } });
    await db.seatRow.deleteMany({ where: { section: { seatMap: { screenId: spaceId } } } });
    await db.seatSection.deleteMany({ where: { seatMap: { screenId: spaceId } } });
    await db.seatCategory.deleteMany({ where: { seatMap: { screenId: spaceId } } });
    await db.seatMap.deleteMany({ where: { screenId: spaceId } });
    await db.screen.deleteMany({ where: { venueId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
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

  maybe('the space exists with a venue and genuinely no cinema', async () => {
    const row = await db!.screen.findUnique({ where: { id: spaceId } });
    expect(row.venueId).toBe(venueId);
    // Not "a cinema that happens to be empty" - no cinema at all.
    expect(row.cinemaId).toBeNull();
    const cinemas = await db!.cinema.count({ where: { organizationId: orgId } });
    expect(cinemas).toBe(0);
  });

  maybe('the venue can list its own spaces', async () => {
    /*
      The read the organizer console needs for VENUE -> SPACE. It could not be written before:
      "the spaces in this venue" meant "the screens of the cinemas in this venue".
    */
    const list = await venues.spaces(ORGANIZER, venueId);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Auditorium');
    expect(list[0].cinemaName).toBeNull();
    expect(list[0].layout?.layoutKind).toBeDefined();
  });

  maybe('a layout attached to it, and the gangway is not a seat', async () => {
    const map = await db!.seatMap.findFirst({ where: { screenId: spaceId } });
    expect(map).toBeTruthy();
    // 2 rows x 8 less 4 gangway places, plus a 6-seat balcony.
    const sellable = await db!.seat.count({
      where: { seatMap: { screenId: spaceId }, kind: { not: 'GAP' } },
    });
    expect(sellable).toBe(18);
  });

  maybe('the event wizard offers it for reserved seating', async () => {
    /*
      `listSeatingRooms` scoped by `cinema: { organizationId }` alone. After this migration
      that would have hidden every space that is not a cinema screen - which is to say, this
      one. Asserting it here is what stops that scoping coming back.
    */
    const offered = await events.listSeatingRooms(ORGANIZER, orgId);
    const mine = offered.find((r: { id: string }) => r.id === spaceId);
    if (!mine) throw new Error('the venue-owned space was not offered for seating');
    // The VENUE is the place. Before the fix this returned the cinema's name, and here there
    // is no cinema to borrow one from.
    expect(mine.venueName).toBe(`Sai Nigamagamam ${suffix}`);
    // And the venue by id: the wizard offers reserved seating only in the picked venue's
    // spaces, and two venues can share a name.
    expect(mine.venueId).toBe(venueId);
    expect(mine.sellableSeats).toBe(18);
  });

  maybe(
    'a session in it sells numbered seats',
    async () => {
      const session = await events.addSession(ORGANIZER, eventId, {
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        endsAt: new Date(Date.now() + 30 * 86_400_000 + 2 * 3_600_000),
        screenId: spaceId,
      } as never);

      // Ticket types derived from the layout's categories, priced from them.
      const types = await db!.ticketType.findMany({
        where: { eventSessionId: session.id },
        orderBy: { name: 'asc' },
      });
      expect(types.map((t: { name: string }) => t.name)).toEqual(['Balcony', 'Stalls']);

      // And real per-seat inventory, which is what makes a seat selectable and lockable.
      const showSeats = await db!.showSeat.count({ where: { eventSessionId: session.id } });
      expect(showSeats).toBe(18);
    },
    120_000,
  );
});
