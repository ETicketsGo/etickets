import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reconcileSeats } from '@eticketsgo/shared-types';
import { CinemasService } from '../cinemas/cinemas.service';
import { SeatLayoutsService } from './seat-layouts.service';
import { ShowsService } from './shows.service';
import { generateVenue, seatCount, type VenueTemplateKey } from './venue-templates';

/**
 * integration-real-postgres — a layout started from the gallery sells exactly what it shows.
 *
 * The gallery, the preview and the space list each state a number of seats. The only way to
 * know they agree with what a session puts on sale is to write the layout, schedule against
 * it and count the rows the database actually holds. Five promises, each checked here:
 *
 *   · an aisle never becomes a ShowSeat, and a blocked seat is never AVAILABLE;
 *   · a wheelchair space IS inventory, and reaches the buyer labelled as one;
 *   · the preview, the layout list, the space list and the session agree on one bookable count;
 *   · publishing a new layout version leaves a session that has sold seats on its own version;
 *   · cloning a sectioned venue keeps it a venue map (it used to come back as a bare grid).
 *
 * Fixtures are created under a unique suffix and removed afterwards: the database is shared.
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

const ORGANIZER = { id: 'itest-gallery', email: 'g@t.test', fullName: 'G', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

describe('integration-real-postgres: layouts from the gallery', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let layouts: SeatLayoutsService;
  let shows: ShowsService;
  let cinemas: CinemasService;

  const suffix = `gallery-${Date.now()}`;
  let orgId = '';
  let cinemaId = '';
  let movieId = '';

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
    cinemas = new CinemasService(db as never, allowAll, audit);

    const org = await db.organization.create({
      data: { name: `Gallery ${suffix}`, slug: `gallery-${suffix}`, status: 'APPROVED' },
    });
    orgId = org.id;
    const venue = await db.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, city: 'Hyderabad', country: 'India' },
    });
    const cinema = await db.cinema.create({
      data: { organizationId: orgId, venueId: venue.id, name: `C ${suffix}`, city: 'Hyderabad' },
    });
    cinemaId = cinema.id;
    const movie = await db.movie.create({
      data: {
        organizationId: orgId,
        title: `Gallery Film ${suffix}`,
        slug: `gallery-film-${suffix}`,
        status: 'PUBLISHED',
        runtimeMinutes: 100,
        language: 'English',
      },
    });
    movieId = movie.id;
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    const screens = await db.screen.findMany({ where: { cinemaId }, select: { id: true } });
    const ids = screens.map((s: { id: string }) => s.id);
    await db.showSeat.deleteMany({ where: { eventSession: { screenId: { in: ids } } } });
    await db.ticketType.deleteMany({ where: { eventSession: { screenId: { in: ids } } } });
    await db.eventSession.deleteMany({ where: { screenId: { in: ids } } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.movie.deleteMany({ where: { organizationId: orgId } });
    await db.seat.deleteMany({ where: { seatMap: { screenId: { in: ids } } } });
    await db.seatZone.deleteMany({ where: { seatMap: { screenId: { in: ids } } } });
    await db.seatRow.deleteMany({ where: { section: { seatMap: { screenId: { in: ids } } } } });
    await db.seatSection.deleteMany({ where: { seatMap: { screenId: { in: ids } } } });
    await db.seatCategory.deleteMany({ where: { seatMap: { screenId: { in: ids } } } });
    // Clones point at their source; break the lineage before deleting either end.
    await db.seatMap.updateMany({
      where: { screenId: { in: ids } },
      data: { clonedFromId: null },
    });
    await db.seatMap.deleteMany({ where: { screenId: { in: ids } } });
    await db.screen.deleteMany({ where: { cinemaId } });
    await db.cinema.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  const newSpace = (name: string) =>
    db!.screen.create({
      data: { cinemaId, name: `${name} ${suffix}`, screenType: '2D', capacity: 10 },
    });

  /** Every seat a preview would hand a buyer, block by block for a sectioned venue. */
  const previewSeats = async (layoutId: string) => {
    const first = await layouts.preview(ORGANIZER, layoutId);
    if (first.view === 'seats')
      return first.sections.flatMap((s) => s.rows.flatMap((r) => r.seats));
    const all = [];
    for (const block of first.sections.filter((s) => s.kind === 'SECTION')) {
      const one = await layouts.preview(ORGANIZER, layoutId, block.id);
      if (one.view !== 'seats') throw new Error('expected seats for a named block');
      all.push(...one.sections.flatMap((s) => s.rows.flatMap((r) => r.seats)));
    }
    return all;
  };

  describe.each<VenueTemplateKey>([
    'CINEMA',
    'PREMIUM_CINEMA',
    'AUDITORIUM',
    'FLAT_HALL',
    'BASKETBALL',
    'ARENA',
  ])('%s', (template) => {
    maybe('every screen that counts it agrees on one bookable number', async () => {
      const space = await newSpace(template);
      const created = await layouts.createFromTemplate(ORGANIZER, space.id, {
        template,
        basePriceMinor: 20_000,
      });
      expect(created.status).toBe('DRAFT');
      const expected = seatCount(generateVenue(template));
      expect(created.seats).toBe(expected);

      // The preview works on the DRAFT - checking before publishing is the point.
      const preview = await layouts.preview(ORGANIZER, created.id);
      const reconciled = reconcileSeats(preview.preview.kindCounts);
      expect(reconciled.bookable).toBe(expected);
      expect(preview.sessionId).toBe('preview');

      const seats = await previewSeats(created.id);
      expect(seats).toHaveLength(expected);
      expect(seats.filter((s) => s.kind === 'GAP')).toHaveLength(0);
      expect(seats.every((s) => s.status === 'AVAILABLE')).toBe(true);
      // Accessible seats reach the buyer's view with their kind, not as plain seats.
      expect(seats.some((s) => s.kind === 'WHEELCHAIR')).toBe(true);
      expect(seats.some((s) => s.kind === 'COMPANION')).toBe(true);

      if (preview.view === 'overview') {
        const summed = preview.sections.reduce((n, s) => n + s.totalCount, 0);
        expect(summed).toBe(expected);
      }

      await layouts.publish(ORGANIZER, created.id, {});
      const versions = await layouts.listVersions(ORGANIZER, space.id);
      expect(versions[0].capacity).toBe(expected);
      expect(reconcileSeats(versions[0].kindCounts).bookable).toBe(expected);

      // The space list (#263) says the same number.
      const listed = (await cinemas.listScreens(ORGANIZER, cinemaId)) as {
        id: string;
        bookableSeats: number | null;
      }[];
      expect(listed.find((s) => s.id === space.id)?.bookableSeats).toBe(expected);
    });
  });

  describe('a session sold from a gallery layout', () => {
    let screenId = '';
    let v1 = '';
    let sessionId = '';
    let expected = 0;

    maybe('sells every seat and wheelchair space, and no aisle', async () => {
      const space = await newSpace('Hall');
      screenId = space.id;
      const created = await layouts.createFromTemplate(ORGANIZER, screenId, {
        template: 'FLAT_HALL',
        basePriceMinor: 15_000,
      });
      v1 = created.id;
      await layouts.publish(ORGANIZER, v1, {});
      expected = created.seats;

      const scheduled = await shows.scheduleShow(ORGANIZER, movieId, {
        screenId,
        startsAt: new Date(Date.now() + 210 * 86_400_000),
        endsAt: new Date(Date.now() + 210 * 86_400_000 + 3 * 3_600_000),
      } as never);
      sessionId = scheduled.sessionId;

      const inventory = await db!.showSeat.findMany({
        where: { eventSessionId: sessionId },
        select: { status: true, seat: { select: { kind: true, seatMapId: true } } },
      });
      expect(inventory).toHaveLength(expected);
      const kinds = inventory.map((r: { seat: { kind: string } }) => r.seat.kind);
      expect(kinds).not.toContain('GAP');
      expect(kinds).toContain('WHEELCHAIR');
      expect(kinds).toContain('COMPANION');
      expect(inventory.every((r: { seat: { seatMapId: string } }) => r.seat.seatMapId === v1)).toBe(
        true,
      );

      // The buyer sees the wheelchair space labelled as one.
      const layout = await shows.getPublicSeatLayout(sessionId);
      if (layout.view !== 'seats') throw new Error('expected seats');
      const offered = layout.sections.flatMap((s) => s.rows.flatMap((r) => r.seats));
      expect(offered).toHaveLength(expected);
      expect(offered.filter((s) => s.kind === 'WHEELCHAIR').length).toBeGreaterThan(0);
    });

    maybe('a blocked seat is not AVAILABLE, and comes off what the session can sell', async () => {
      const one = await db!.showSeat.findFirst({
        where: { eventSessionId: sessionId, status: 'AVAILABLE' },
      });
      await db!.showSeat.update({
        where: { id: one.id },
        data: { status: 'BLOCKED', overrideKind: 'MANUAL_BLOCK', overrideReason: 'test' },
      });
      // Booking's hold is "UPDATE ... WHERE status = 'AVAILABLE'", so this count IS what can sell.
      const sellable = await db!.showSeat.count({
        where: { eventSessionId: sessionId, status: 'AVAILABLE' },
      });
      expect(sellable).toBe(expected - 1);

      const versions = await layouts.listVersions(ORGANIZER, screenId);
      const blocked = await db!.showSeat.count({
        where: { eventSessionId: sessionId, status: 'BLOCKED' },
      });
      expect(reconcileSeats(versions[0].kindCounts, { blocked }).bookable).toBe(sellable);

      const layout = await shows.getPublicSeatLayout(sessionId);
      if (layout.view !== 'seats') throw new Error('expected seats');
      const seat = layout.sections
        .flatMap((s) => s.rows.flatMap((r) => r.seats))
        .find((s) => s.id === one.seatId);
      expect(seat?.status).not.toBe('AVAILABLE');
    });

    maybe('publishing a new version leaves the sold session on the version it sold', async () => {
      // A sale, as the database records one.
      const sold = await db!.showSeat.findFirst({
        where: { eventSessionId: sessionId, status: 'AVAILABLE' },
      });
      await db!.showSeat.update({ where: { id: sold.id }, data: { status: 'SOLD' } });
      const before = await db!.showSeat.findMany({
        where: { eventSessionId: sessionId },
        select: { id: true, seatId: true, status: true },
        orderBy: { id: 'asc' },
      });

      // The published version itself refuses to change.
      await expect(
        layouts.applyTemplate(ORGANIZER, v1, { template: 'PREMIUM_CINEMA', basePriceMinor: 1 }),
      ).rejects.toThrow();

      // A new, smaller room: clone, rebuild from another template, publish now.
      const draft = await layouts.clone(ORGANIZER, v1, {});
      await layouts.applyTemplate(ORGANIZER, draft.id, {
        template: 'PREMIUM_CINEMA',
        basePriceMinor: 30_000,
      });
      await layouts.publish(ORGANIZER, draft.id, {});

      const session = await db!.eventSession.findUnique({ where: { id: sessionId } });
      expect(session.seatMapId).toBe(v1);
      const after = await db!.showSeat.findMany({
        where: { eventSessionId: sessionId },
        select: { id: true, seatId: true, status: true },
        orderBy: { id: 'asc' },
      });
      expect(after).toEqual(before);

      const layout = await shows.getPublicSeatLayout(sessionId);
      expect(layout.seatMapId).toBe(v1);

      // And a show scheduled now gets the new room.
      const next = await shows.scheduleShow(ORGANIZER, movieId, {
        screenId,
        startsAt: new Date(Date.now() + 220 * 86_400_000),
        endsAt: new Date(Date.now() + 220 * 86_400_000 + 3 * 3_600_000),
      } as never);
      const nextCount = await db!.showSeat.count({ where: { eventSessionId: next.sessionId } });
      expect(nextCount).toBe(seatCount(generateVenue('PREMIUM_CINEMA')));
    });
  });

  maybe('cloning a sectioned venue keeps its map', async () => {
    /*
      A clone copied seats and nothing else, so an arena came back as a GRID with no stage and
      no block outlines. Published, it would have sent every seat in the building to a phone
      as one grid.
    */
    const space = await newSpace('Court');
    const created = await layouts.createFromTemplate(ORGANIZER, space.id, {
      template: 'BASKETBALL',
      basePriceMinor: 10_000,
      name: 'Basketball',
    });
    await layouts.publish(ORGANIZER, created.id, {});
    const clone = await layouts.clone(ORGANIZER, created.id, {});
    const copy = await db!.seatMap.findUnique({
      where: { id: clone.id },
      include: { sections: true },
    });
    expect(copy.layoutKind).toBe('SECTIONED');
    expect(copy.focalLabel).toBe('COURT');
    expect(copy.sections.every((s: { shape: unknown }) => Array.isArray(s.shape))).toBe(true);
    const preview = await layouts.preview(ORGANIZER, clone.id);
    expect(preview.view).toBe('overview');
  });
});
