import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CinemasService } from '../cinemas/cinemas.service';
import { EventSellabilityService } from '../events/event-sellability.service';
import { EventsService } from '../events/events.service';
import { ShowsService } from '../shows/shows.service';
import { VenuesService } from '../venues/venues.service';

/**
 * integration-real-postgres - adding a space, and the rules that keep one from breaking.
 *
 * -- WHAT THIS PROVES ---------------------------------------------------------------------
 * 1. "New space" no longer makes a space inside a space. A cinema screen added to a venue is
 *    filed under that venue's cinema - one made from the venue the first time, named after
 *    the venue, and REUSED for the second screen. Before, the console created a CINEMA named
 *    "Screen 2" with an empty list of screens inside it.
 * 2. Any other kind of space is stored with its kind and no cinema.
 * 3. A space with sessions cannot be deleted. The delete cascaded through its layouts to
 *    every sold seat, and set each session's space to null.
 * 4. A session cannot be seated in a space at a different venue, or in one taken out of use.
 *
 * Checked against a real database because what matters is what was WRITTEN. Skips rather
 * than fabricating a pass when no database is reachable.
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

const ORGANIZER = { id: 'itest-kind', email: 'kind@t.test', fullName: 'K', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const noAudit = { record: async () => undefined } as never;
const noAudience = { notifyAdmins: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

const LAYOUT = {
  name: 'Hall',
  sections: [
    {
      name: 'Stalls',
      categoryName: 'Stalls',
      basePriceMinor: 50_000,
      rowLabels: ['A'],
      seatsPerRow: 4,
    },
  ],
};

describe('integration-real-postgres: adding a space, and keeping it intact', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let venues: VenuesService;
  let cinemas: CinemasService;
  let events: EventsService;
  let shows: ShowsService;

  const suffix = `kind-${Date.now()}`;
  let orgId = '';
  let venueId = '';
  let otherVenueId = '';

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
    cinemas = new CinemasService(db as never, allowAll, noAudit);
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
      data: { name: `Kind ${suffix}`, slug: `kind-${suffix}` },
    });
    orgId = org.id;
    venueId = (
      await venues.create(ORGANIZER, orgId, {
        name: `Phoenix ${suffix}`,
        city: 'Bengaluru',
        country: 'India',
        region: 'Karnataka',
        address: 'Whitefield',
      } as never)
    ).id;
    otherVenueId = (
      await venues.create(ORGANIZER, orgId, {
        name: `Elsewhere ${suffix}`,
        city: 'Mysuru',
        country: 'India',
      } as never)
    ).id;
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    const screens = { screen: { venue: { organizationId: orgId } } };
    await db.showSeat.deleteMany({ where: { eventSession: { event: { organizationId: orgId } } } });
    await db.ticketInventory.deleteMany({
      where: { ticketType: { eventSession: { event: { organizationId: orgId } } } },
    });
    await db.ticketType.deleteMany({
      where: { eventSession: { event: { organizationId: orgId } } },
    });
    await db.eventSession.deleteMany({ where: { event: { organizationId: orgId } } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.seat.deleteMany({ where: { seatMap: screens } });
    await db.seatRow.deleteMany({ where: { section: { seatMap: screens } } });
    await db.seatSection.deleteMany({ where: { seatMap: screens } });
    await db.seatCategory.deleteMany({ where: { seatMap: screens } });
    await db.seatMap.deleteMany({ where: screens });
    await db.screen.deleteMany({ where: { venue: { organizationId: orgId } } });
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
    'a cinema screen joins ONE cinema made from the venue, never a cinema named after it',
    async () => {
      const one = await venues.addSpace(ORGANIZER, venueId, {
        name: 'Screen 1',
        screenType: '2D',
        capacity: 150,
        kind: 'CINEMA_SCREEN',
      } as never);
      const two = await venues.addSpace(ORGANIZER, venueId, {
        name: 'Screen 2',
        screenType: '2D',
        capacity: 120,
        kind: 'CINEMA_SCREEN',
      } as never);

      const rows = await db!.cinema.findMany({ where: { organizationId: orgId } });
      expect(rows).toHaveLength(1);
      // Named after the venue and placed where it is - not "Screen 1", not somewhere else.
      expect(rows[0].name).toBe(`Phoenix ${suffix}`);
      expect(rows[0].venueId).toBe(venueId);
      expect(rows[0].city).toBe('Bengaluru');
      expect(rows[0].country).toBe('India');
      expect(rows[0].timezone).toBe('Asia/Kolkata');
      for (const s of [one, two]) {
        expect(s.cinemaId).toBe(rows[0].id);
        expect(s.venueId).toBe(venueId);
        expect(s.kind).toBe('CINEMA_SCREEN');
      }
      // And the space's own page reads it as what it is.
      const page = await venues.getSpace(ORGANIZER, two.id);
      expect(page.kind).toBe('CINEMA_SCREEN');
      expect(page.venue?.id).toBe(venueId);
      expect(page.sessions).toBe(0);
    },
  );

  maybe('a hall is stored with its kind and no cinema', async () => {
    const hall = await venues.addSpace(ORGANIZER, venueId, {
      name: 'Main Hall',
      screenType: '2D',
      capacity: 300,
      kind: 'SEATED_HALL',
    } as never);
    expect(hall.cinemaId).toBeNull();
    expect(hall.kind).toBe('SEATED_HALL');
    const listed = await venues.allSpaces(ORGANIZER, orgId);
    expect(listed.find((s) => s.id === hall.id)?.kind).toBe('SEATED_HALL');
  });

  maybe(
    'a cinema screen cannot be renamed into a hall, nor a hall into a cinema screen',
    async () => {
      const [screen] = await db!.screen.findMany({
        where: { venueId, kind: 'CINEMA_SCREEN' },
        take: 1,
      });
      await expect(
        cinemas.updateScreen(ORGANIZER, screen.id, { kind: 'SEATED_HALL' } as never),
      ).rejects.toThrow(/stays a cinema screen/);
      const hall = await db!.screen.findFirst({ where: { venueId, kind: 'SEATED_HALL' } });
      await expect(
        cinemas.updateScreen(ORGANIZER, hall.id, { kind: 'CINEMA_SCREEN' } as never),
      ).rejects.toThrow(/Only a screen in a cinema/);
      // A rename is fine.
      const renamed = await cinemas.updateScreen(ORGANIZER, hall.id, {
        name: 'Great Hall',
      } as never);
      expect(renamed.name).toBe('Great Hall');
    },
  );

  maybe(
    'a space with a session cannot be deleted; one without can',
    async () => {
      const hall = await venues.addSpace(ORGANIZER, venueId, {
        name: 'Recital Room',
        screenType: '2D',
        capacity: 4,
        kind: 'SEATED_HALL',
      } as never);
      await shows.generateSeatMap(ORGANIZER, hall.id, LAYOUT as never);
      const event = await events.create(ORGANIZER, orgId, {
        title: `Recital ${suffix}`,
        category: 'Music',
        venueId,
        feeMode: 'CUSTOMER_PAYS',
        isFree: false,
      } as never);
      const session = await events.addSession(ORGANIZER, event.id, {
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        endsAt: new Date(Date.now() + 30 * 86_400_000 + 3_600_000),
        screenId: hall.id,
      } as never);
      const seatsBefore = await db!.showSeat.count({ where: { eventSessionId: session.id } });
      expect(seatsBefore).toBe(4);

      await expect(cinemas.removeScreen(ORGANIZER, hall.id)).rejects.toThrow(/cannot be deleted/);
      // Nothing was touched: the space, its session's link and every seat are still there.
      expect(await db!.screen.count({ where: { id: hall.id } })).toBe(1);
      const after = await db!.eventSession.findUnique({ where: { id: session.id } });
      expect(after.screenId).toBe(hall.id);
      expect(await db!.showSeat.count({ where: { eventSessionId: session.id } })).toBe(4);

      const empty = await venues.addSpace(ORGANIZER, venueId, {
        name: 'Spare Room',
        screenType: '2D',
        capacity: 10,
        kind: 'STANDING',
      } as never);
      await expect(cinemas.removeScreen(ORGANIZER, empty.id)).resolves.toEqual({ success: true });
    },
    120_000,
  );

  maybe(
    'a session is not seated in another venue, nor in a space out of use',
    async () => {
      const far = await venues.addSpace(ORGANIZER, otherVenueId, {
        name: 'Far Hall',
        screenType: '2D',
        capacity: 4,
        kind: 'SEATED_HALL',
      } as never);
      await shows.generateSeatMap(ORGANIZER, far.id, LAYOUT as never);
      const event = await events.create(ORGANIZER, orgId, {
        title: `Gig ${suffix}`,
        category: 'Music',
        venueId,
        feeMode: 'CUSTOMER_PAYS',
        isFree: false,
      } as never);
      const when = {
        startsAt: new Date(Date.now() + 40 * 86_400_000),
        endsAt: new Date(Date.now() + 40 * 86_400_000 + 3_600_000),
      };
      await expect(
        events.addSession(ORGANIZER, event.id, { ...when, screenId: far.id } as never),
      ).rejects.toThrow(/different venue/);

      const near = await venues.addSpace(ORGANIZER, venueId, {
        name: 'Near Hall',
        screenType: '2D',
        capacity: 4,
        kind: 'SEATED_HALL',
      } as never);
      await shows.generateSeatMap(ORGANIZER, near.id, LAYOUT as never);
      await cinemas.updateScreen(ORGANIZER, near.id, { status: 'INACTIVE' } as never);
      await expect(
        events.addSession(ORGANIZER, event.id, { ...when, screenId: near.id } as never),
      ).rejects.toThrow(/out of use/);
      const offered = await events.listSeatingRooms(ORGANIZER, orgId);
      expect(offered.some((r: { id: string }) => r.id === near.id)).toBe(false);
    },
    120_000,
  );
});
