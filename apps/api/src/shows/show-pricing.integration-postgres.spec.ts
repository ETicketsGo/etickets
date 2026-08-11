import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ShowsService } from './shows.service';

/**
 * integration-real-postgres — a show's price is the show's, not the room's.
 *
 * These exist because a live rehearsal turned up two things a unit test would not have:
 * a brand-new organization could not schedule its first show at all, and copying a day
 * quietly reproduced it at the layout's base price instead of the price it was trading at.
 * Both are about rows that only exist once several tables agree, so they need a real
 * database.
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

const ORGANIZER = { id: 'itest-pricing', email: 'p@t.test', fullName: 'P', roles: [] } as never;
const allowAll = { assertMember: async () => undefined } as never;
const noAudit = { record: async () => undefined } as never;
const cfg = { get: () => 15 } as never;

describe('integration-real-postgres: show pricing', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let service: ShowsService;

  const suffix = `pricing-${Date.now()}`;
  let orgId = '';
  let cinemaId = '';
  let screenId = '';
  let movieId = '';
  let standardId = '';
  let premiumId = '';

  /** A two-category room: ₹200 stalls, ₹300 balcony. */
  const makeScreen = async (name: string) => {
    const client = db as Client;
    const screen = await client.screen.create({
      data: { cinemaId, name, screenType: '2D', capacity: 4 },
    });
    const seatMap = await client.seatMap.create({ data: { screenId: screen.id, name: 'L' } });
    const cats: Record<string, string> = {};
    for (const [i, [catName, price]] of (
      [
        ['STANDARD', 20000],
        ['PREMIUM', 30000],
      ] as [string, number][]
    ).entries()) {
      const cat = await client.seatCategory.create({
        data: { seatMapId: seatMap.id, name: catName, basePriceMinor: price, sortOrder: i },
      });
      cats[catName] = cat.id;
      const sec = await client.seatSection.create({
        data: { seatMapId: seatMap.id, name: `S${i}`, sortOrder: i },
      });
      const row = await client.seatRow.create({
        data: { sectionId: sec.id, label: String.fromCharCode(65 + i), sortOrder: i },
      });
      await client.seat.createMany({
        data: [1, 2].map((n) => ({
          seatMapId: seatMap.id,
          rowId: row.id,
          seatCategoryId: cat.id,
          label: `${String.fromCharCode(65 + i)}${n}`,
          colIndex: n,
          kind: 'SEAT',
        })),
      });
    }
    return { screenId: screen.id, cats };
  };

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
    service = new ShowsService(db as never, allowAll, noAudit, cfg);

    const org = await db.organization.create({
      data: { name: `Pricing ${suffix}`, slug: `pricing-${suffix}` },
    });
    orgId = org.id;
    // Deliberately NO venue: this organization is as new as a real one, and that is the
    // condition the first-show blocker needed.
    const cinema = await db.cinema.create({
      data: {
        organizationId: orgId,
        name: `C ${suffix}`,
        city: 'Bengaluru',
        timezone: 'Asia/Kolkata',
      },
    });
    cinemaId = cinema.id;
    const made = await makeScreen('Screen 1');
    screenId = made.screenId;
    standardId = made.cats.STANDARD;
    premiumId = made.cats.PREMIUM;
    const movie = await db.movie.create({
      data: {
        organizationId: orgId,
        title: `Pricing Movie ${suffix}`,
        slug: `pricing-movie-${suffix}`,
        runtimeMinutes: 100,
        language: 'Kannada',
        status: 'PUBLISHED',
      },
    });
    movieId = movie.id;
  }, 60_000);

  const clear = async () => {
    if (!db) return;
    const ids = (
      await db.eventSession.findMany({ where: { event: { movieId } }, select: { id: true } })
    ).map((s: { id: string }) => s.id);
    if (!ids.length) return;
    await db.showSeat.deleteMany({ where: { eventSessionId: { in: ids } } });
    await db.ticketInventory.deleteMany({ where: { ticketType: { eventSessionId: { in: ids } } } });
    await db.ticketType.deleteMany({ where: { eventSessionId: { in: ids } } });
    await db.eventSession.deleteMany({ where: { id: { in: ids } } });
  };

  beforeEach(async () => {
    if (available) await clear();
  });

  afterAll(async () => {
    if (available && db) {
      await clear();
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

  /** Prices for one local day, as `HH:mm CATEGORY` → minor units. */
  const pricesOn = async (date: string) => {
    const sessions = await (db as Client).eventSession.findMany({
      where: { screenId, event: { movieId } },
      select: { startsAt: true, ticketTypes: { select: { name: true, priceMinor: true } } },
      orderBy: { startsAt: 'asc' },
    });
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
    const out: Record<string, number> = {};
    for (const s of sessions) {
      if (dateFmt.format(s.startsAt) !== date) continue;
      for (const t of s.ticketTypes) out[`${fmt.format(s.startsAt)} ${t.name}`] = t.priceMinor;
    }
    return out;
  };

  const bulk = (date: string, times: string[], pricing?: { id: string; price: number }[]) =>
    service.bulkScheduleShows(ORGANIZER, movieId, {
      screenId,
      dates: [date],
      times,
      padMinutes: 0,
      timezone: 'Asia/Kolkata',
      dryRun: false,
      ...(pricing
        ? { pricing: pricing.map((p) => ({ seatCategoryId: p.id, priceMinor: p.price })) }
        : {}),
    } as never);

  // ── The first show a real theater ever schedules ───────────────────────────

  maybe('an organization with no venue can still schedule its first show', async () => {
    const client = db as Client;
    expect(await client.venue.count({ where: { organizationId: orgId } })).toBe(0);
    expect((await client.cinema.findUnique({ where: { id: cinemaId } }))!.venueId).toBeNull();

    // This refused before, with "No venue is available for this organization." — a concept
    // the operator has never seen and there is no endpoint to create.
    const r = await service.scheduleShow(ORGANIZER, movieId, {
      screenId,
      startsAt: new Date('2031-03-01T12:30:00Z'),
      endsAt: new Date('2031-03-01T14:30:00Z'),
    } as never);
    expect(r.sessionId).toBeTruthy();

    const venues = await client.venue.findMany({ where: { organizationId: orgId } });
    expect(venues).toHaveLength(1);
    // Made from the cinema, not borrowed from somewhere else in the organization.
    expect(venues[0].city).toBe('Bengaluru');
    // And recorded, so the next show does not make a second one.
    expect((await client.cinema.findUnique({ where: { id: cinemaId } }))!.venueId).toBe(
      venues[0].id,
    );

    await service.scheduleShow(ORGANIZER, movieId, {
      screenId,
      startsAt: new Date('2031-03-01T16:30:00Z'),
      endsAt: new Date('2031-03-01T18:30:00Z'),
    } as never);
    expect(await client.venue.count({ where: { organizationId: orgId } })).toBe(1);
  });

  // ── Price belongs to the show ──────────────────────────────────────────────

  maybe('two shows on one layout hold different prices, and no new layout appears', async () => {
    const client = db as Client;
    const layoutsBefore = await client.seatMap.count({ where: { screenId } });

    await bulk('2031-04-01', ['14:00']);
    await bulk(
      '2031-04-01',
      ['18:00'],
      [
        { id: standardId, price: 25000 },
        { id: premiumId, price: 40000 },
      ],
    );

    expect(await pricesOn('2031-04-01')).toEqual({
      '14:00 STANDARD': 20000,
      '14:00 PREMIUM': 30000,
      '18:00 STANDARD': 25000,
      '18:00 PREMIUM': 40000,
    });
    expect(await client.seatMap.count({ where: { screenId } })).toBe(layoutsBefore);
    // The layout's own prices are a template for new shows and nothing else.
    const cat = await client.seatCategory.findUnique({ where: { id: premiumId } });
    expect(cat!.basePriceMinor).toBe(30000);
  });

  // ── Copying a day ──────────────────────────────────────────────────────────

  maybe('copying a day carries the prices it was actually trading at', async () => {
    await bulk(
      '2031-05-01',
      ['14:00', '18:00'],
      [
        { id: standardId, price: 35000 },
        { id: premiumId, price: 50000 },
      ],
    );

    await service.copySchedule(ORGANIZER, movieId, {
      sourceScreenId: screenId,
      sourceDate: '2031-05-01',
      targetDate: '2031-05-02',
      dryRun: false,
    } as never);

    // Before the fix every one of these was the layout base — ₹200/₹300 — and nothing said
    // so. A day trading at ₹350 reproduced itself as a 43% discount.
    expect(await pricesOn('2031-05-02')).toEqual({
      '14:00 STANDARD': 35000,
      '14:00 PREMIUM': 50000,
      '18:00 STANDARD': 35000,
      '18:00 PREMIUM': 50000,
    });
  });

  maybe('a day priced per showing copies as per showing, not as one price', async () => {
    // The case a single pricing array cannot express: a cheap matinee and a full-price
    // evening. If the carry-forward collapsed the day to one price this would come back
    // with the matinee at the evening's rate, or both at the base.
    await bulk(
      '2031-06-01',
      ['11:00'],
      [
        { id: standardId, price: 12000 },
        { id: premiumId, price: 18000 },
      ],
    );
    await bulk(
      '2031-06-01',
      ['19:00'],
      [
        { id: standardId, price: 30000 },
        { id: premiumId, price: 45000 },
      ],
    );

    await service.copySchedule(ORGANIZER, movieId, {
      sourceScreenId: screenId,
      sourceDate: '2031-06-01',
      targetDate: '2031-06-02',
      dryRun: false,
    } as never);

    expect(await pricesOn('2031-06-02')).toEqual({
      '11:00 STANDARD': 12000,
      '11:00 PREMIUM': 18000,
      '19:00 STANDARD': 30000,
      '19:00 PREMIUM': 45000,
    });
  });

  maybe('an explicit price still beats the price being carried forward', async () => {
    await bulk(
      '2031-07-01',
      ['14:00'],
      [
        { id: standardId, price: 35000 },
        { id: premiumId, price: 50000 },
      ],
    );

    await service.copySchedule(ORGANIZER, movieId, {
      sourceScreenId: screenId,
      sourceDate: '2031-07-01',
      targetDate: '2031-07-02',
      pricing: [{ seatCategoryId: standardId, priceMinor: 9900 }],
      dryRun: false,
    } as never);

    // Asking for a price is a stronger statement than inheriting one — but only for the
    // category actually named. PREMIUM was not mentioned, so it still carries.
    expect(await pricesOn('2031-07-02')).toEqual({
      '14:00 STANDARD': 9900,
      '14:00 PREMIUM': 50000,
    });
  });

  // ── Repricing a scheduled show ─────────────────────────────────────────────

  const ticketTypesOf = async (
    sessionId: string,
  ): Promise<{ id: string; name: string; priceMinor: number }[]> =>
    (db as Client).ticketType.findMany({
      where: { eventSessionId: sessionId },
      orderBy: { name: 'asc' },
    });

  maybe('a future show can be repriced without touching the layout', async () => {
    const client = db as Client;
    const layoutsBefore = await client.seatMap.count({ where: { screenId } });
    const [{ sessionId }] = (await bulk('2031-09-01', ['14:00'])).created;

    const before = await ticketTypesOf(sessionId);
    expect(before.map((t) => t.priceMinor)).toEqual([30000, 20000]); // PREMIUM, STANDARD

    const after = await service.updateShowPricing(ORGANIZER, sessionId, {
      prices: before.map((t) => ({ ticketTypeId: t.id, priceMinor: t.priceMinor + 5000 })),
    });
    expect(after.categories.map((c) => c.priceMinor).sort()).toEqual([25000, 35000]);
    expect(await client.seatMap.count({ where: { screenId } })).toBe(layoutsBefore);
    // And the room's own prices are where they were.
    expect(
      (await client.seatCategory.findUnique({ where: { id: premiumId } }))!.basePriceMinor,
    ).toBe(30000);
  });

  maybe('a sold category is fixed; the rest of the show is not', async () => {
    const client = db as Client;
    const [{ sessionId }] = (await bulk('2031-09-05', ['14:00'])).created;
    const [premium, standard] = await ticketTypesOf(sessionId);

    // One seat sold in PREMIUM. Nothing sold in STANDARD.
    await client.ticketInventory.update({
      where: { ticketTypeId: premium.id },
      data: { quantitySold: 1 },
    });

    await expect(
      service.updateShowPricing(ORGANIZER, sessionId, {
        prices: [{ ticketTypeId: premium.id, priceMinor: 99900 }],
      }),
    ).rejects.toThrow(/already sold 1 seats/);

    // The refusal is total: STANDARD is untouched even though it was in the same request.
    await expect(
      service.updateShowPricing(ORGANIZER, sessionId, {
        prices: [
          { ticketTypeId: premium.id, priceMinor: 99900 },
          { ticketTypeId: standard.id, priceMinor: 25000 },
        ],
      }),
    ).rejects.toThrow(/price is fixed/);
    expect((await client.ticketType.findUnique({ where: { id: standard.id } }))!.priceMinor).toBe(
      20000,
    );

    // Repricing the categories that have NOT sold still works.
    await service.updateShowPricing(ORGANIZER, sessionId, {
      prices: [
        // Sending the sold row at its CURRENT price is not a change, so it is allowed —
        // this is what the dialog does, because the endpoint takes the whole show.
        { ticketTypeId: premium.id, priceMinor: premium.priceMinor },
        { ticketTypeId: standard.id, priceMinor: 25000 },
      ],
    });
    expect((await client.ticketType.findUnique({ where: { id: standard.id } }))!.priceMinor).toBe(
      25000,
    );
  });

  maybe('a show that has already started cannot be repriced', async () => {
    const client = db as Client;
    const [{ sessionId }] = (await bulk('2031-09-08', ['14:00'])).created;
    const [premium] = await ticketTypesOf(sessionId);
    await client.eventSession.update({
      where: { id: sessionId },
      data: { startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 60_000) },
    });
    await expect(
      service.updateShowPricing(ORGANIZER, sessionId, {
        prices: [{ ticketTypeId: premium.id, priceMinor: 1000 }],
      }),
    ).rejects.toThrow(/already started/);
  });

  maybe('a cancelled show cannot be repriced', async () => {
    const client = db as Client;
    const [{ sessionId }] = (await bulk('2031-09-11', ['14:00'])).created;
    const [premium] = await ticketTypesOf(sessionId);
    await client.eventSession.update({ where: { id: sessionId }, data: { status: 'CANCELLED' } });
    await expect(
      service.updateShowPricing(ORGANIZER, sessionId, {
        prices: [{ ticketTypeId: premium.id, priceMinor: 1000 }],
      }),
    ).rejects.toThrow(/cancelled/);
  });

  maybe("another show's ticket type cannot be repriced through this one", async () => {
    const a = (await bulk('2031-09-14', ['14:00'])).created[0];
    const b = (await bulk('2031-09-14', ['18:00'])).created[0];
    const [premiumB] = await ticketTypesOf(b.sessionId);
    await expect(
      service.updateShowPricing(ORGANIZER, a.sessionId, {
        prices: [{ ticketTypeId: premiumB.id, priceMinor: 100 }],
      }),
    ).rejects.toThrow(/do not belong to this show/);
    // And B is untouched, so a refused request wrote nothing anywhere.
    expect((await ticketTypesOf(b.sessionId))[0].priceMinor).toBe(premiumB.priceMinor);
  });

  maybe('the readiness view of the show reports what is locked and what is not', async () => {
    const client = db as Client;
    const [{ sessionId }] = (await bulk('2031-09-17', ['14:00'])).created;
    const [premium] = await ticketTypesOf(sessionId);
    await client.ticketInventory.update({
      where: { ticketTypeId: premium.id },
      data: { quantitySold: 2, quantityHeld: 1 },
    });
    const view = await service.getShowPricing(ORGANIZER, sessionId);
    const p = view.categories.find((c) => c.name === 'PREMIUM')!;
    expect(p.locked).toBe(true);
    expect(p.soldCount).toBe(2);
    expect(p.heldCount).toBe(1);
    // A held seat does NOT lock a price: the buyer's line was snapshotted when they held it.
    const s = view.categories.find((c) => c.name === 'STANDARD')!;
    expect(s.locked).toBe(false);
    expect(view.timezone).toBe('Asia/Kolkata');
  });

  maybe('a dry run copies nothing, priced or otherwise', async () => {
    await bulk('2031-08-01', ['14:00'], [{ id: standardId, price: 35000 }]);
    const r = await service.copySchedule(ORGANIZER, movieId, {
      sourceScreenId: screenId,
      sourceDate: '2031-08-01',
      targetDate: '2031-08-02',
      dryRun: true,
    } as never);
    expect(r.created).toHaveLength(0);
    expect(await pricesOn('2031-08-02')).toEqual({});
  });
});
