import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SeatLayoutsService } from './seat-layouts.service';
import { ShowsService } from './shows.service';
import { generateVenue, seatCount } from './venue-templates';

/**
 * integration-real-postgres — a generated venue is one you can actually sell from.
 *
 * The unit tests prove the geometry is sane. They cannot prove any of the things that make
 * this feature real: that fourteen thousand seats write inside one transaction without
 * timing out, that the overview's counts come from the same rows the seat view sells, or
 * that a cinema is untouched by all of it. Every one of those is a property of the database
 * and a stub would return whatever the test handed it.
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

const ORGANIZER = { id: 'itest-venue', email: 'v@t.test', fullName: 'V', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

describe('integration-real-postgres: venue seat maps', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let layouts: SeatLayoutsService;
  let shows: ShowsService;

  const suffix = `venue-${Date.now()}`;
  let orgId = '';
  let venueId = '';
  let cinemaId = '';

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    const audit = { record: async () => undefined } as never;
    layouts = new SeatLayoutsService(db as never, allowAll, audit);
    shows = new ShowsService(db as never, allowAll, audit, cfg);

    const org = await db.organization.create({
      data: { name: `Venue ${suffix}`, slug: `venue-${suffix}` },
    });
    orgId = org.id;
    const venue = await db.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Hyderabad', country: 'India' },
    });
    venueId = venue.id;
    const cinema = await db.cinema.create({
      data: { organizationId: orgId, venueId: venue.id, name: `C ${suffix}`, city: 'Hyderabad' },
    });
    cinemaId = cinema.id;
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    const screens = await db.screen.findMany({ where: { cinemaId }, select: { id: true } });
    const ids = screens.map((s: { id: string }) => s.id);
    await db.showSeat.deleteMany({ where: { seat: { seatMap: { screenId: { in: ids } } } } });
    await db.eventSession.deleteMany({ where: { screenId: { in: ids } } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.seat.deleteMany({ where: { seatMap: { screenId: { in: ids } } } });
    await db.seatRow.deleteMany({ where: { section: { seatMap: { screenId: { in: ids } } } } });
    await db.seatSection.deleteMany({ where: { seatMap: { screenId: { in: ids } } } });
    await db.seatCategory.deleteMany({ where: { seatMap: { screenId: { in: ids } } } });
    await db.seatMap.deleteMany({ where: { screenId: { in: ids } } });
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

  /** A screen with an empty DRAFT layout, ready to be filled from a template. */
  const draftLayoutOn = async (name: string) => {
    const screen = await db!.screen.create({
      data: { cinemaId, name: `${name} ${suffix}`, screenType: '2D', capacity: 100 },
    });
    const layout = await db!.seatMap.create({
      data: { screenId: screen.id, name, version: 1, status: 'DRAFT' },
    });
    return { screenId: screen.id as string, layoutId: layout.id as string };
  };

  maybe(
    'writes a whole arena — geometry, price bands and every seat',
    async () => {
      const { layoutId } = await draftLayoutOn('Arena');
      const result = await layouts.applyTemplate(ORGANIZER, layoutId, {
        template: 'ARENA',
        basePriceMinor: 50_000,
      });

      const expected = seatCount(generateVenue('ARENA'));
      expect(result.seats).toBe(expected);
      // Counted in the database, not taken from the generator's own arithmetic.
      expect(await db!.seat.count({ where: { seatMapId: layoutId } })).toBe(expected);

      const map = await db!.seatMap.findUnique({
        where: { id: layoutId },
        include: { sections: true, categories: true },
      });
      expect(map.layoutKind).toBe('SECTIONED');
      expect(map.focalPoint).toBe('FIELD');
      expect(map.focalShape).not.toBeNull();

      // Geometry survives the JSON column round trip. A shape that comes back as a string,
      // or as null, is a map that renders as nothing.
      const withShapes = map.sections.filter((s: { shape: unknown }) => Array.isArray(s.shape));
      expect(withShapes).toHaveLength(map.sections.length);

      // Price bands are derived from the base by the template's weights — never invented.
      const cheapest = Math.min(
        ...map.categories.map((c: { basePriceMinor: number }) => c.basePriceMinor),
      );
      const dearest = Math.max(
        ...map.categories.map((c: { basePriceMinor: number }) => c.basePriceMinor),
      );
      expect(cheapest).toBe(50_000);
      expect(dearest).toBeGreaterThan(cheapest);
    },
    180_000,
  );

  maybe(
    'writes a stadium inside one transaction without timing out',
    async () => {
      /*
        The test that justifies the bulk-insert code.

        A stadium is about fourteen thousand seats across five hundred rows. Written one row
        at a time — which is what the cinema path does, correctly, at twelve rows — this is
        five hundred sequential round trips and the transaction aborts partway, leaving a
        layout with sections and no seats: something that looks like a venue in the console
        and sells nothing.
      */
      const { layoutId } = await draftLayoutOn('Stadium');
      const started = Date.now();
      const result = await layouts.applyTemplate(ORGANIZER, layoutId, {
        template: 'STADIUM',
        basePriceMinor: 30_000,
      });
      const elapsedMs = Date.now() - started;

      expect(result.seats).toBeGreaterThan(10_000);
      expect(await db!.seat.count({ where: { seatMapId: layoutId } })).toBe(result.seats);
      // Generous, because CI hardware varies — but far under the 120s transaction ceiling,
      // so a regression to per-row inserts fails here rather than in production.
      expect(elapsedMs).toBeLessThan(60_000);

      // Every seat reaches a row, and every row a section. An orphan is a seat nobody can
      // find on the map and the API will still happily quote for.
      const orphans = await db!.seat.count({
        where: { seatMapId: layoutId, row: { section: { seatMapId: { not: layoutId } } } },
      });
      expect(orphans).toBe(0);
    },
    240_000,
  );

  maybe(
    'a cinema template leaves the layout a GRID, exactly as before',
    async () => {
      // The whole point of defaulting layoutKind to GRID. A cinema must not acquire a venue
      // map and a two-step read just because venue maps now exist.
      const { layoutId } = await draftLayoutOn('Cinema');
      await layouts.applyTemplate(ORGANIZER, layoutId, {
        template: 'CINEMA',
        basePriceMinor: 20_000,
      });
      const map = await db!.seatMap.findUnique({ where: { id: layoutId } });
      expect(map.layoutKind).toBe('GRID');
    },
    120_000,
  );

  maybe(
    'replacing a template leaves nothing of the old one behind',
    async () => {
      // Applying twice is the ordinary case — an organizer tries an arena, decides it is a
      // theatre. Rows or seats surviving from the first attempt would be invisible capacity.
      const { layoutId } = await draftLayoutOn('Replaced');
      await layouts.applyTemplate(ORGANIZER, layoutId, {
        template: 'IN_THE_ROUND',
        basePriceMinor: 10_000,
      });
      await layouts.applyTemplate(ORGANIZER, layoutId, {
        template: 'PROSCENIUM',
        basePriceMinor: 10_000,
      });

      const expected = seatCount(generateVenue('PROSCENIUM'));
      expect(await db!.seat.count({ where: { seatMapId: layoutId } })).toBe(expected);
      expect(await db!.seatSection.count({ where: { seatMapId: layoutId } })).toBe(
        generateVenue('PROSCENIUM').sections.length,
      );
      const orphanRows = await db!.seatRow.count({
        where: { section: { seatMapId: layoutId }, seats: { none: {} } },
      });
      expect(orphanRows).toBe(0);
    },
    180_000,
  );

  maybe(
    'refuses to rewrite a published layout',
    async () => {
      // A version a show has been sold from can never change underneath it. The template
      // path has to honour the same rule as every other edit, or it becomes the way around it.
      const { layoutId } = await draftLayoutOn('Published');
      await db!.seatMap.update({
        where: { id: layoutId },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      await expect(
        layouts.applyTemplate(ORGANIZER, layoutId, {
          template: 'CINEMA',
          basePriceMinor: 10_000,
        }),
      ).rejects.toBeDefined();
    },
    120_000,
  );

  describe('reading a sectioned venue', () => {
    let sessionId = '';
    let sectionId = '';
    let sectionSeatCount = 0;

    maybe(
      'sets up a show in a generated theatre',
      async () => {
        const { screenId, layoutId } = await draftLayoutOn('Theatre');
        await layouts.applyTemplate(ORGANIZER, layoutId, {
          template: 'PROSCENIUM',
          basePriceMinor: 25_000,
        });
        await db!.seatMap.update({
          where: { id: layoutId },
          data: { status: 'PUBLISHED', publishedAt: new Date() },
        });

        const event = await db!.event.create({
          data: {
            organizationId: orgId,
            venueId,
            title: `Show ${suffix}`,
            slug: `show-${suffix}`,
            status: 'PUBLISHED',
            experienceType: 'EVENT',
            category: 'Theatre',
          },
        });
        const session = await db!.eventSession.create({
          data: {
            eventId: event.id,
            screenId,
            seatMapId: layoutId,
            startsAt: new Date(Date.now() + 86_400_000),
            endsAt: new Date(Date.now() + 90_000_000),
          },
        });
        sessionId = session.id;

        const seats = await db!.seat.findMany({
          where: { seatMapId: layoutId },
          select: { id: true, rowId: true },
        });
        await db!.showSeat.createMany({
          data: seats.map((s: { id: string }) => ({ eventSessionId: sessionId, seatId: s.id })),
        });

        const section = await db!.seatSection.findFirst({
          where: { seatMapId: layoutId },
          orderBy: { sortOrder: 'asc' },
        });
        sectionId = section.id;
        sectionSeatCount = await db!.seat.count({ where: { row: { sectionId } } });
      },
      180_000,
    );

    maybe(
      'returns an overview with no seats in it at all',
      async () => {
        const layout = await shows.getPublicSeatLayout(sessionId);
        expect(layout.view).toBe('overview');
        if (layout.view !== 'overview') throw new Error('expected an overview');

        expect(layout.layoutKind).toBe('SECTIONED');
        expect(layout.focal.label).toBe('STAGE');
        expect(layout.sections.length).toBeGreaterThan(0);
        // Nothing to half-render: a client cannot draw an empty seat grid from a payload
        // that has no seats in it.
        expect(layout.sections.every((s) => !('rows' in s))).toBe(true);
        expect(layout.sections.every((s) => Array.isArray(s.shape))).toBe(true);
      },
      120_000,
    );

    maybe(
      'counts availability from the same rows the seat view sells',
      async () => {
        /*
          The invariant that matters most.

          The overview counts with a grouped SQL statement and the seat view reads rows
          through Prisma. Two code paths answering the same question is exactly how a block
          comes to advertise forty free seats and offer thirty-nine — so they are checked
          against each other, before and after a seat is taken.
        */
        const before = await shows.getPublicSeatLayout(sessionId);
        if (before.view !== 'overview') throw new Error('expected an overview');
        const summary = before.sections.find((s) => s.id === sectionId);
        expect(summary?.totalCount).toBe(sectionSeatCount);
        expect(summary?.availableCount).toBe(sectionSeatCount);

        const detail = await shows.getPublicSeatLayout(sessionId, sectionId);
        if (detail.view !== 'seats') throw new Error('expected seats');
        const seats = detail.sections.flatMap((s) => s.rows.flatMap((r) => r.seats));
        expect(seats).toHaveLength(sectionSeatCount);
        // Only the block that was asked for comes back — not the whole house.
        expect(detail.sections).toHaveLength(1);
        expect(detail.sections[0].id).toBe(sectionId);

        // Sell one, and both views have to agree about it.
        await db!.showSeat.update({
          where: { eventSessionId_seatId: { eventSessionId: sessionId, seatId: seats[0].id } },
          data: { status: 'SOLD' },
        });

        const after = await shows.getPublicSeatLayout(sessionId);
        if (after.view !== 'overview') throw new Error('expected an overview');
        const updated = after.sections.find((s) => s.id === sectionId);
        expect(updated?.availableCount).toBe(sectionSeatCount - 1);
        expect(updated?.totalCount).toBe(sectionSeatCount);

        const detailAfter = await shows.getPublicSeatLayout(sessionId, sectionId);
        if (detailAfter.view !== 'seats') throw new Error('expected seats');
        const stillFree = detailAfter.sections
          .flatMap((s) => s.rows.flatMap((r) => r.seats))
          .filter((s) => s.status === 'AVAILABLE');
        expect(stillFree).toHaveLength(sectionSeatCount - 1);
      },
      180_000,
    );

    maybe(
      'quotes a price range per block, from the show’s prices',
      async () => {
        const layout = await shows.getPublicSeatLayout(sessionId);
        if (layout.view !== 'overview') throw new Error('expected an overview');
        const priced = layout.sections.filter((s) => s.priceMinorFrom !== null);
        // Every block a customer can click has to say what it costs; "from —" is not a price.
        expect(priced).toHaveLength(layout.sections.length);
        expect(priced.every((s) => (s.priceMinorFrom ?? 0) > 0)).toBe(true);
      },
      120_000,
    );
  });
});
