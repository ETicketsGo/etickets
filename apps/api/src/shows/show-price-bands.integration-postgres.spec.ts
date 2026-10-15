import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ShowsService } from './shows.service';
import { CinemaPricingPolicyService } from '../pricing/cinema-policy/cinema-pricing-policy.service';

/**
 * integration-real-postgres - a price outside the regulated band is refused when it is SET.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * Walking QA (2026-10-15): a Vijayawada Recliner show was repriced to Rs 300 under the Andhra
 * Pradesh Rs 250 limit. The pricing dialog said "Prices updated", the show's pill still blamed
 * an unrelated seat class, and checkout then refused every Recliner seat. Nothing anywhere told
 * the operator why. The bulk "Schedule a run" path had the same hole for explicit prices.
 *
 * ── THE FIXTURE ────────────────────────────────────────────────────────────────────
 * Like the AP rate-table suites, this CLONES the seeded Andhra Pradesh rows into a test-only
 * country and activates the clones there, so the band is the real transcription and the seeded
 * rows are never touched. The venue stays in India so the show prices in rupees.
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

const ORGANIZER = { id: 'itest-bands', email: 'b@t.test', fullName: 'B', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const noAudit = { record: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

describe('integration-real-postgres: regulated price bands when a price is set', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let service: ShowsService;
  let unwired: ShowsService;

  const stamp = Date.now();
  const AP_COUNTRY = `ApBandsTest${stamp}`;
  let orgId = '';
  let venueId = '';
  let cinemaId = '';
  let screenId = '';
  let movieId = '';
  const cat: Record<string, string> = {};

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }
    const seeded = await db.cinemaPricingPolicy.findMany({
      where: { country: 'India', region: 'Andhra Pradesh' },
    });
    if (seeded.length === 0) throw new Error('AP policies are not seeded; run the seed first.');
    for (const row of seeded) {
      const { id: _id, createdAt: _c, updatedAt: _u, supersedesId: _s, ...values } = row;
      await db.cinemaPricingPolicy.create({
        data: { ...values, country: AP_COUNTRY, status: 'ACTIVE' },
      });
    }

    const policies = new CinemaPricingPolicyService(db as never);
    const args = [db as never, allowAll, noAudit, cfg] as const;
    // Positional, like every scheduling suite; the policy service is the last argument.
    service = new (ShowsService as unknown as new (...a: unknown[]) => ShowsService)(
      ...args,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      policies,
    );
    unwired = new ShowsService(...args);

    const org = await db.organization.create({
      data: { name: `Bands ${stamp}`, slug: `bands-${stamp}`, status: 'APPROVED' },
    });
    orgId = org.id;
    const venue = await db.venue.create({
      data: {
        organizationId: orgId,
        name: `Bands Venue ${stamp}`,
        city: 'Vijayawada',
        region: 'Andhra Pradesh',
        country: 'India',
        timezone: 'Asia/Kolkata',
        capacity: 10,
      },
    });
    venueId = venue.id;
    const cinema = await db.cinema.create({
      data: {
        organizationId: orgId,
        venueId,
        name: `Bands Cinema ${stamp}`,
        city: 'Vijayawada',
        region: 'Andhra Pradesh',
        country: AP_COUNTRY,
        timezone: 'Asia/Kolkata',
        localBodyType: 'MUNICIPAL_CORPORATION',
        cinemaFormat: 'MULTIPLEX',
        climateType: 'AC',
      },
    });
    cinemaId = cinema.id;
    const screen = await db.screen.create({
      data: { cinemaId, name: 'Screen 1', screenType: '2D', capacity: 6 },
    });
    screenId = screen.id;
    const seatMap = await db.seatMap.create({ data: { screenId, name: 'L' } });
    const defs: [string, number, string | null][] = [
      ['Stalls', 15_000, 'REGULAR'],
      ['Lounge', 25_000, 'RECLINER'],
      ['Platinum Executive', 20_000, null],
    ];
    for (const [i, [name, price, cls]] of defs.entries()) {
      const c = await db.seatCategory.create({
        data: {
          seatMapId: seatMap.id,
          name,
          basePriceMinor: price,
          sortOrder: i,
          regulatoryClass: cls as never,
        },
      });
      cat[name] = c.id;
      const sec = await db.seatSection.create({
        data: { seatMapId: seatMap.id, name: `S${i}`, sortOrder: i },
      });
      const row = await db.seatRow.create({
        data: { sectionId: sec.id, label: String.fromCharCode(65 + i), sortOrder: i },
      });
      await db.seat.createMany({
        data: [1, 2].map((n) => ({
          seatMapId: seatMap.id,
          rowId: row.id,
          seatCategoryId: c.id,
          label: `${String.fromCharCode(65 + i)}${n}`,
          colIndex: n,
          kind: 'SEAT',
        })),
      });
    }
    const movie = await db.movie.create({
      data: {
        organizationId: orgId,
        title: `Bands Movie ${stamp}`,
        slug: `bands-movie-${stamp}`,
        runtimeMinutes: 100,
        language: 'Telugu',
        status: 'PUBLISHED',
      },
    });
    movieId = movie.id;
  }, 60_000);

  afterAll(async () => {
    if (available && db) {
      const ids = (
        await db.eventSession.findMany({ where: { event: { movieId } }, select: { id: true } })
      ).map((s: { id: string }) => s.id);
      await db.showSeat.deleteMany({ where: { eventSessionId: { in: ids } } });
      await db.ticketInventory.deleteMany({
        where: { ticketType: { eventSessionId: { in: ids } } },
      });
      await db.ticketType.deleteMany({ where: { eventSessionId: { in: ids } } });
      await db.eventSession.deleteMany({ where: { id: { in: ids } } });
      await db.event.deleteMany({ where: { movieId } });
      await db.movie.deleteMany({ where: { id: movieId } });
      await db.seat.deleteMany({ where: { seatMap: { screen: { cinemaId } } } });
      await db.seatRow.deleteMany({ where: { section: { seatMap: { screen: { cinemaId } } } } });
      await db.seatSection.deleteMany({ where: { seatMap: { screen: { cinemaId } } } });
      await db.seatCategory.deleteMany({ where: { seatMap: { screen: { cinemaId } } } });
      await db.seatMap.deleteMany({ where: { screen: { cinemaId } } });
      await db.screen.deleteMany({ where: { cinemaId } });
      await db.cinema.deleteMany({ where: { id: cinemaId } });
      await db.venue.deleteMany({ where: { organizationId: orgId } });
      await db.organization.deleteMany({ where: { id: orgId } });
      await db.cinemaPricingPolicy.deleteMany({ where: { country: AP_COUNTRY } });
    }
    await db?.$disconnect();
  }, 60_000);

  const maybe = (name: string, fn: () => Promise<void>, t = 60_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      t,
    );

  let showN = 0;
  /** A fresh show, far in the future so the policy's dates and "already started" never bite. */
  const newShow = async () => {
    showN += 1;
    const start = new Date(Date.UTC(2031, 2, showN, 6, 0));
    const r = await service.scheduleShow(ORGANIZER, movieId, {
      screenId,
      startsAt: start,
      endsAt: new Date(start.getTime() + 2 * 3_600_000),
    } as never);
    return r.sessionId;
  };
  const priceOf = async (sessionId: string, name: string) =>
    (await (db as Client).ticketType.findFirst({ where: { eventSessionId: sessionId, name } }))!
      .priceMinor as number;

  maybe('the pricing view names the limit for each mapped class, none for unmapped', async () => {
    const sessionId = await newShow();
    const view = await service.getShowPricing(ORGANIZER, sessionId);
    const by = Object.fromEntries(view.categories.map((c) => [c.name, c]));
    expect(by.Stalls.regulatoryClass).toBe('REGULAR');
    expect(by.Stalls.priceLimit).toMatchObject({ maxMinor: 15_000, sellable: true });
    expect(by.Stalls.priceLimit!.place).toBe('Andhra Pradesh');
    expect(by.Lounge.priceLimit).toMatchObject({ maxMinor: 25_000, sellable: true });
    // Unmapped: no class, so no band to show - readiness names the mapping problem.
    expect(by['Platinum Executive'].regulatoryClass).toBeNull();
    expect(by['Platinum Executive'].priceLimit).toBeNull();
  });

  maybe(
    'a reprice above the class limit is refused, says the limit, and stores nothing',
    async () => {
      const sessionId = await newShow();
      const view = await service.getShowPricing(ORGANIZER, sessionId);
      const lounge = view.categories.find((c) => c.name === 'Lounge')!;
      await expect(
        service.updateShowPricing(ORGANIZER, sessionId, {
          prices: [{ ticketTypeId: lounge.ticketTypeId, priceMinor: 30_000 }],
        }),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/Lounge: Andhra Pradesh allows at most ₹250 for a Recliner/),
      });
      expect(await priceOf(sessionId, 'Lounge')).toBe(25_000);
    },
  );

  maybe('a reprice at or under the limit is saved, exactly as before', async () => {
    const sessionId = await newShow();
    const view = await service.getShowPricing(ORGANIZER, sessionId);
    const stalls = view.categories.find((c) => c.name === 'Stalls')!;
    // Inclusive: exactly the ceiling is lawful.
    await service.updateShowPricing(ORGANIZER, sessionId, {
      prices: [{ ticketTypeId: stalls.ticketTypeId, priceMinor: 15_000 }],
    });
    await service.updateShowPricing(ORGANIZER, sessionId, {
      prices: [{ ticketTypeId: stalls.ticketTypeId, priceMinor: 12_000 }],
    });
    expect(await priceOf(sessionId, 'Stalls')).toBe(12_000);
  });

  maybe('an unmapped category is not refused here: the mapping is its own problem', async () => {
    const sessionId = await newShow();
    const view = await service.getShowPricing(ORGANIZER, sessionId);
    const plat = view.categories.find((c) => c.name === 'Platinum Executive')!;
    await service.updateShowPricing(ORGANIZER, sessionId, {
      prices: [{ ticketTypeId: plat.ticketTypeId, priceMinor: 99_000 }],
    });
    expect(await priceOf(sessionId, 'Platinum Executive')).toBe(99_000);
  });

  maybe('a run with an explicit price above the limit is refused at PREVIEW', async () => {
    await expect(
      service.bulkScheduleShows(ORGANIZER, movieId, {
        screenId,
        dates: ['2031-05-01'],
        times: ['10:00'],
        padMinutes: 0,
        timezone: 'Asia/Kolkata',
        dryRun: true,
        pricing: [{ seatCategoryId: cat.Stalls, priceMinor: 20_000 }],
      } as never),
    ).rejects.toMatchObject({ message: expect.stringMatching(/Stalls: .*at most ₹150/) });
  });

  maybe('a single show with an explicit price above the limit is not created', async () => {
    const before = await (db as Client).eventSession.count({ where: { event: { movieId } } });
    await expect(
      service.scheduleShow(ORGANIZER, movieId, {
        screenId,
        startsAt: new Date('2031-06-01T06:00:00Z'),
        endsAt: new Date('2031-06-01T08:00:00Z'),
        pricing: [{ seatCategoryId: cat.Lounge, priceMinor: 25_100 }],
      } as never),
    ).rejects.toMatchObject({ message: expect.stringMatching(/at most ₹250/) });
    expect(await (db as Client).eventSession.count({ where: { event: { movieId } } })).toBe(before);
  });

  maybe('a run inside every limit is created at the prices given', async () => {
    const r = await service.bulkScheduleShows(ORGANIZER, movieId, {
      screenId,
      dates: ['2031-07-01'],
      times: ['10:00'],
      padMinutes: 0,
      timezone: 'Asia/Kolkata',
      dryRun: false,
      pricing: [
        { seatCategoryId: cat.Stalls, priceMinor: 14_000 },
        { seatCategoryId: cat.Lounge, priceMinor: 25_000 },
      ],
    } as never);
    expect(r.created).toHaveLength(1);
    expect(await priceOf(r.created[0].sessionId, 'Stalls')).toBe(14_000);
    expect(await priceOf(r.created[0].sessionId, 'Lounge')).toBe(25_000);
  });

  maybe('without the policy service wired, prices are stored as before', async () => {
    const sessionId = await newShow();
    const view = await unwired.getShowPricing(ORGANIZER, sessionId);
    const lounge = view.categories.find((c) => c.name === 'Lounge')!;
    expect(lounge.priceLimit).toBeNull();
    await unwired.updateShowPricing(ORGANIZER, sessionId, {
      prices: [{ ticketTypeId: lounge.ticketTypeId, priceMinor: 30_000 }],
    });
    expect(await priceOf(sessionId, 'Lounge')).toBe(30_000);
  });
});
