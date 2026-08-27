import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EventsService } from './events.service';
import { ShowsService } from '../shows/shows.service';

/**
 * integration-real-postgres — a concert can have a seat map.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────
 * Reserved seating existed only for cinemas. A seat map hung off a SCREEN, a screen belonged
 * to a CINEMA, and the booking path decided seat-based versus general admission purely on
 * whether the experience was a MOVIE. So a 400-seat theatre selling assigned seats for a
 * concert could only sell numbered quantities of a ticket type, and the organizer looking for
 * a seat map while creating an event was right that there wasn't one.
 *
 * The conflation was the bug. Whether a ticket names a seat is a property of the ROOM, not of
 * the kind of event — the same concert is reserved seating in a theatre and general admission
 * in a standing arena. A session now has a room or it does not, and that is the whole
 * difference.
 *
 * Proven against a real database because what is being checked is what was WRITTEN: which
 * ticket types exist, how many seats each carries, and whether ShowSeat rows were created.
 * A stub returns whatever the test hands it.
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

const ORGANIZER = { id: 'itest-seated', email: 's@t.test', fullName: 'S', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const noAudit = { record: async () => undefined } as never;
const noAudience = { notifyAdmins: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

describe('integration-real-postgres: a seated event', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let events: EventsService;
  let shows: ShowsService;

  const suffix = `seated-${Date.now()}`;
  let orgId = '';
  let venueId = '';
  let cinemaId = '';
  let screenId = '';
  let eventId = '';

  /** Two rows of six with an aisle down seat 3, in two price categories. */
  const LAYOUT = {
    name: 'Auditorium',
    sections: [
      {
        name: 'Stalls',
        categoryName: 'Stalls',
        basePriceMinor: 30_000,
        rowLabels: ['A'],
        seatsPerRow: 6,
        seatKinds: [{ rowLabel: 'A', seats: [3], kind: 'GAP' }],
      },
      {
        name: 'Balcony',
        categoryName: 'Balcony',
        basePriceMinor: 15_000,
        rowLabels: ['B'],
        seatsPerRow: 6,
      },
    ],
  };

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

    shows = new ShowsService(db as never, allowAll, noAudit, cfg);
    events = new EventsService(db as never, allowAll, noAudit, noAudience, cfg, shows);

    const org = await db!.organization.create({
      data: { name: `Seated ${suffix}`, slug: `seated-${suffix}` },
    });
    orgId = org.id;
    const venue = await db!.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Montréal', country: 'Canada' },
    });
    venueId = venue.id;
    /*
      A cinema row is what owns a room today. The name is historical — what it means here is
      "the place the rooms belong to" — and reusing it is deliberate: inventing a parallel
      Venue→Room chain would give the product two seat-map models to keep in step.
    */
    const cinema = await db!.cinema.create({
      data: { organizationId: orgId, venueId, name: `Hall ${suffix}`, city: 'Montréal' },
    });
    cinemaId = cinema.id;
    const screen = await db!.screen.create({
      data: { cinemaId, name: `Main ${suffix}`, screenType: '2D', capacity: 12 },
    });
    screenId = screen.id;

    await shows.generateSeatMap(ORGANIZER, screenId, LAYOUT as never);

    const event = await events.create(ORGANIZER, orgId, {
      title: `Concert ${suffix}`,
      category: 'Music',
      venueId,
      feeMode: 'CUSTOMER_PAYS',
      isFree: false,
    } as never);
    eventId = event.id;
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.showSeat.deleteMany({ where: { seat: { seatMap: { screenId } } } });
    await db.ticketInventory.deleteMany({
      where: { ticketType: { eventSession: { eventId } } },
    });
    await db.ticketType.deleteMany({ where: { eventSession: { eventId } } });
    await db.eventSession.deleteMany({ where: { eventId } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.seat.deleteMany({ where: { seatMap: { screenId } } });
    await db.seatRow.deleteMany({ where: { section: { seatMap: { screenId } } } });
    await db.seatSection.deleteMany({ where: { seatMap: { screenId } } });
    await db.seatCategory.deleteMany({ where: { seatMap: { screenId } } });
    await db.seatMap.deleteMany({ where: { screenId } });
    await db.screen.deleteMany({ where: { cinemaId } });
    await db.cinema.deleteMany({ where: { organizationId: orgId } });
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

  maybe(
    'a session in a room gets a ticket type per seat category, priced from the category',
    async () => {
      const session = await events.addSession(ORGANIZER, eventId, {
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        endsAt: new Date(Date.now() + 30 * 86_400_000 + 3 * 3_600_000),
        screenId,
      } as never);

      const types = await db!.ticketType.findMany({
        where: { eventSessionId: session.id },
        orderBy: { name: 'asc' },
      });
      expect(types.map((t: { name: string }) => t.name)).toEqual(['Balcony', 'Stalls']);
      // Prices come from the seat category, not from anything typed on the event.
      const byName = new Map(types.map((t: { name: string; priceMinor: number }) => [t.name, t]));
      expect((byName.get('Stalls') as { priceMinor: number }).priceMinor).toBe(30_000);
      expect((byName.get('Balcony') as { priceMinor: number }).priceMinor).toBe(15_000);
      // Every category is bound to its seats, which is what makes seat pricing possible.
      expect(types.every((t: { seatCategoryId: string | null }) => t.seatCategoryId)).toBe(true);
    },
    120_000,
  );

  maybe(
    'the aisle is not sold, and the quantities say so',
    async () => {
      /*
      The defect this platform has already shipped once: a GAP written as inventory is an
      aisle position somebody can buy a ticket for. Stalls is drawn as six with one gap, so
      it sells five — and the ticket type has to agree, because that number is what the
      operations board reports as capacity.
    */
      const session = await events.addSession(ORGANIZER, eventId, {
        startsAt: new Date(Date.now() + 31 * 86_400_000),
        endsAt: new Date(Date.now() + 31 * 86_400_000 + 3 * 3_600_000),
        screenId,
      } as never);

      const stalls = await db!.ticketType.findFirst({
        where: { eventSessionId: session.id, name: 'Stalls' },
      });
      expect(stalls.quantityTotal).toBe(5);

      const balcony = await db!.ticketType.findFirst({
        where: { eventSessionId: session.id, name: 'Balcony' },
      });
      expect(balcony.quantityTotal).toBe(6);

      const showSeats = await db!.showSeat.count({ where: { eventSessionId: session.id } });
      expect(showSeats).toBe(11);
    },
    120_000,
  );

  maybe(
    'a session with no room stays general admission',
    async () => {
      // The whole change is additive. An event without a room behaves exactly as before, and
      // creating one must not conjure ticket types the organizer did not ask for.
      const session = await events.addSession(ORGANIZER, eventId, {
        startsAt: new Date(Date.now() + 32 * 86_400_000),
        endsAt: new Date(Date.now() + 32 * 86_400_000 + 3 * 3_600_000),
      } as never);

      expect(session.screenId).toBeNull();
      expect(await db!.ticketType.count({ where: { eventSessionId: session.id } })).toBe(0);
      expect(await db!.showSeat.count({ where: { eventSessionId: session.id } })).toBe(0);
    },
    120_000,
  );

  maybe(
    'a room belonging to somebody else is refused',
    async () => {
      /*
      Otherwise an organizer could seat their event in a competitor's auditorium and sell its
      seats. The check is on the room's owning organization, not on the venue, because that
      is where the seats actually live.
    */
      const otherOrg = await db!.organization.create({
        data: { name: `Other ${suffix}`, slug: `other-${suffix}` },
      });
      const otherCinema = await db!.cinema.create({
        data: { organizationId: otherOrg.id, name: `Their hall ${suffix}`, city: 'Toronto' },
      });
      const otherScreen = await db!.screen.create({
        data: { cinemaId: otherCinema.id, name: 'Theirs', screenType: '2D', capacity: 10 },
      });

      await expect(
        events.addSession(ORGANIZER, eventId, {
          startsAt: new Date(Date.now() + 33 * 86_400_000),
          endsAt: new Date(Date.now() + 33 * 86_400_000 + 3 * 3_600_000),
          screenId: otherScreen.id,
        } as never),
      ).rejects.toThrow(/Room not found for this organization/i);

      await db!.screen.deleteMany({ where: { cinemaId: otherCinema.id } });
      await db!.cinema.deleteMany({ where: { organizationId: otherOrg.id } });
      await db!.organization.deleteMany({ where: { id: otherOrg.id } });
    },
    120_000,
  );

  maybe(
    'the room picker offers only rooms a session could actually use',
    async () => {
      /*
      The list behind the organizer's "Seating" dropdown. It has to agree exactly with what
      addSession accepts, or the product teaches organizers that picking a room is a coin
      toss — they choose one, the next request refuses it, and nothing on screen says which
      of the two rules they tripped.

      Both halves are checked here: a room with no published map must NOT appear, and the
      seat count must be the number that can be SOLD. A room drawn with an aisle seats fewer
      than it has positions, and that count is what an organizer picks a room on.
    */
      const bare = await db!.screen.create({
        data: { cinemaId, name: `Unmapped ${suffix}`, screenType: '2D', capacity: 50 },
      });

      const rooms = await events.listSeatingRooms(ORGANIZER, orgId);

      expect(rooms.map((r) => r.id)).toContain(screenId);
      expect(rooms.map((r) => r.id)).not.toContain(bare.id);

      const room = rooms.find((r) => r.id === screenId)!;
      // Twelve positions drawn, one of them an aisle. Eleven can be sold.
      expect(room.sellableSeats).toBe(11);
      expect(room.venueName).toBe(`Hall ${suffix}`);

      await db!.screen.deleteMany({ where: { id: bare.id } });
    },
    120_000,
  );

  maybe(
    'another organization’s rooms are not offered',
    async () => {
      // The dropdown is the first place a cross-tenant leak would show, and it would show as a
      // competitor's auditorium sitting in the list with its seat count.
      const otherOrg = await db!.organization.create({
        data: { name: `Rival ${suffix}`, slug: `rival-${suffix}` },
      });
      const otherCinema = await db!.cinema.create({
        data: { organizationId: otherOrg.id, name: `Rival hall ${suffix}`, city: 'Toronto' },
      });
      const otherScreen = await db!.screen.create({
        data: { cinemaId: otherCinema.id, name: 'Rival room', screenType: '2D', capacity: 10 },
      });
      await shows.generateSeatMap(ORGANIZER, otherScreen.id, LAYOUT as never);

      const rooms = await events.listSeatingRooms(ORGANIZER, orgId);
      expect(rooms.map((r) => r.id)).not.toContain(otherScreen.id);

      await db!.showSeat.deleteMany({ where: { seat: { seatMap: { screenId: otherScreen.id } } } });
      await db!.seat.deleteMany({ where: { seatMap: { screenId: otherScreen.id } } });
      await db!.seatRow.deleteMany({
        where: { section: { seatMap: { screenId: otherScreen.id } } },
      });
      await db!.seatSection.deleteMany({ where: { seatMap: { screenId: otherScreen.id } } });
      await db!.seatCategory.deleteMany({ where: { seatMap: { screenId: otherScreen.id } } });
      await db!.seatMap.deleteMany({ where: { screenId: otherScreen.id } });
      await db!.screen.deleteMany({ where: { cinemaId: otherCinema.id } });
      await db!.cinema.deleteMany({ where: { organizationId: otherOrg.id } });
      await db!.organization.deleteMany({ where: { id: otherOrg.id } });
    },
    120_000,
  );

  maybe(
    'a room with no published layout is refused, with the reason',
    async () => {
      /*
      A session in a room with no seat map is one where nobody can choose a seat — and the
      failure would otherwise surface at the moment of sale, to a customer, rather than to
      the organizer who can fix it.
    */
      const bare = await db!.screen.create({
        data: { cinemaId, name: `Bare ${suffix}`, screenType: '2D', capacity: 10 },
      });

      await expect(
        events.addSession(ORGANIZER, eventId, {
          startsAt: new Date(Date.now() + 34 * 86_400_000),
          endsAt: new Date(Date.now() + 34 * 86_400_000 + 3 * 3_600_000),
          screenId: bare.id,
        } as never),
      ).rejects.toThrow(/no published seat map/i);

      await db!.screen.deleteMany({ where: { id: bare.id } });
    },
    120_000,
  );
});
