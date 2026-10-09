import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ShowsService } from '../../shows/shows.service';
import { BookingsService } from '../../bookings/bookings.service';
import { PilotReadinessService } from '../../cinemas/pilot-readiness.service';
import { PricingStrategiesService } from '../pricing-strategies.service';
import {
  FlatPricingStrategy,
  SeatPricingStrategy,
  TierPricingStrategy,
} from '../pricing-strategies';
import { CinemaPricingPolicyService } from './cinema-pricing-policy.service';
import { SaleEligibilityService } from './sale-eligibility.service';
import { SALE_NOT_OPEN_REASON } from './sale-eligibility';

/**
 * integration-real-postgres - readiness, checkout and the storefront give one answer.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * QA, 2026-10-09: a Hyderabad cinema's readiness page said "Ready to open, Blocking 0" while
 * every checkout for its shows was refused with a 409 - Telangana has no active price rules -
 * and the buyer's seat page let them pick seats for a show nobody could buy.
 *
 * Proven against a real database because the defect lived in what each reader QUERIED: the
 * readiness service never loaded a policy at all. A stub returns whatever the test hands it.
 *
 * ── THE FIXTURE ────────────────────────────────────────────────────────────────────
 * A country only this file uses, with ACTIVE fixture rules for "Andhra Pradesh" and none for
 * "Telangana". The rules are invented for the test (no real rate), named with a prefix this
 * file deletes, and never touch the seeded India rows other suites assert stay DRAFT.
 *
 * Skips (never fabricates a pass) when no database is reachable.
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

const ORGANIZER = {
  id: 'itest-eligibility',
  email: 'e@t.test',
  fullName: 'E',
  roles: [],
} as never;
const allowAll = { assertMember: async () => undefined } as never;

const suffix = `elig-${Date.now()}`;
const COUNTRY = `EligibilityTest${Date.now()}`;
const REFERENCE = `ITEST-ELIG-${suffix}`;

describe('integration-real-postgres: one sale-eligibility truth', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let shows: ShowsService;
  let readiness: PilotReadinessService;
  let bookings: BookingsService;

  let orgId = '';
  const cinemas: Record<'tg' | 'ap', { cinemaId: string; screenId: string; sessionId: string }> = {
    tg: { cinemaId: '', screenId: '', sessionId: '' },
    ap: { cinemaId: '', screenId: '', sessionId: '' },
  };

  const LAYOUT = {
    name: 'Main',
    sections: [
      {
        name: 'Main',
        categoryName: 'Standard',
        basePriceMinor: 15_000,
        rowLabels: ['A', 'B'],
        seatsPerRow: 5,
      },
    ],
  };

  async function makeCinema(key: 'tg' | 'ap', region: string, city: string) {
    const cinema = await db!.cinema.create({
      data: {
        organizationId: orgId,
        name: `Elig ${key} ${suffix}`,
        city,
        region,
        country: COUNTRY,
        timezone: 'Asia/Kolkata',
      },
    });
    // The venue is in India so the show is priced in rupees, as a real one is; the CINEMA
    // carries the jurisdiction the policy engine matches on.
    const venue = await db!.venue.create({
      data: {
        organizationId: orgId,
        name: `Elig venue ${key} ${suffix}`,
        city,
        region,
        country: 'India',
        timezone: 'Asia/Kolkata',
      },
    });
    await db!.cinema.update({ where: { id: cinema.id }, data: { venueId: venue.id } });
    const screen = await db!.screen.create({
      data: { cinemaId: cinema.id, name: 'Screen 1', screenType: '2D', capacity: 10 },
    });
    const movie = await db!.movie.create({
      data: {
        organizationId: orgId,
        title: `Elig Film ${key} ${suffix}`,
        slug: `elig-film-${key}-${suffix}`,
        status: 'PUBLISHED',
        runtimeMinutes: 100,
        language: 'Telugu',
      },
    });
    await shows.generateSeatMap(ORGANIZER, screen.id, LAYOUT as never);
    const start = Date.now() + (key === 'tg' ? 30 : 31) * 86_400_000;
    const scheduled = await shows.scheduleShow(ORGANIZER, movie.id, {
      screenId: screen.id,
      startsAt: new Date(start),
      endsAt: new Date(start + 3 * 3_600_000),
    } as never);
    cinemas[key] = { cinemaId: cinema.id, screenId: screen.id, sessionId: scheduled.sessionId };
  }

  /** Buy one seat through the real booking path. Returns the refusal, or null if it got past. */
  async function tryToBuy(sessionId: string) {
    const ticketType = await db!.ticketType.findFirst({ where: { eventSessionId: sessionId } });
    const seat = await db!.showSeat.findFirst({
      where: { eventSessionId: sessionId, status: 'AVAILABLE' },
      select: { seatId: true },
    });
    try {
      await bookings.create(null, {
        eventSessionId: sessionId,
        buyerName: 'Buyer',
        buyerEmail: 'buyer@t.test',
        items: [{ ticketTypeId: ticketType.id, quantity: 1, seatIds: [seat.seatId] }],
      } as never);
      return null;
    } catch (e) {
      const err = e as { getStatus?: () => number; details?: Record<string, unknown> };
      if (err.details?.reason === SALE_NOT_OPEN_REASON) {
        return { status: err.getStatus?.(), details: err.details };
      }
      // Anything else is past the eligibility check (the pricing stub stops it there).
      return null;
    }
  }

  const salesChecks = async (key: 'tg' | 'ap') => {
    const report = await readiness.evaluate(ORGANIZER, cinemas[key].cinemaId);
    return {
      overall: report.overall,
      sales: report.sections.find((s) => s.section === 'SALES')?.checks ?? [],
    };
  };

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

    const policies = new CinemaPricingPolicyService(db as never);
    const eligibility = new SaleEligibilityService(db as never, policies);
    const audit = { record: async () => undefined } as never;
    shows = new ShowsService(
      db as never,
      allowAll,
      audit,
      { get: () => 15 } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      eligibility,
    );
    readiness = new PilotReadinessService(
      db as never,
      allowAll,
      { get: () => undefined } as never,
      eligibility,
    );
    bookings = new BookingsService(
      db as never,
      // Pricing is not under test: stop the booking the moment it gets past eligibility, so
      // nothing is held and nothing has to be cleaned up.
      { quote: async () => Promise.reject(new Error('past eligibility')) } as never,
      new PricingStrategiesService(
        new FlatPricingStrategy(),
        new TierPricingStrategy(),
        new SeatPricingStrategy(),
      ),
      audit,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      policies,
    );

    // Fixture rules: "Andhra Pradesh" written, "Telangana" not. Invented amounts.
    const base = {
      country: COUNTRY,
      region: 'Andhra Pradesh',
      maintenanceTreatment: 'NOT_APPLICABLE' as const,
      onlineFeePolicy: 'ALLOWED' as const,
      status: 'ACTIVE' as const,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      regulatoryReference: REFERENCE,
    };
    await db.cinemaPricingPolicy.create({ data: base });
    await db.cinemaPricingPolicy.create({
      data: { ...base, seatCategory: 'REGULAR', ticketPriceMaxMinor: 20_000 },
    });

    const org = await db.organization.create({
      data: { name: `Elig ${suffix}`, slug: `elig-${suffix}`, status: 'APPROVED' },
    });
    orgId = org.id;
    await makeCinema('tg', 'Telangana', 'Hyderabad');
    await makeCinema('ap', 'Andhra Pradesh', 'Vijayawada');

    // The AP cinema's seats are mapped, as a correctly configured cinema's are.
    await db.seatCategory.updateMany({
      where: { seatMap: { screenId: cinemas.ap.screenId } },
      data: { regulatoryClass: 'REGULAR' },
    });
    // And so are Telangana's: the refusal there is the missing state rules, nothing else.
    await db.seatCategory.updateMany({
      where: { seatMap: { screenId: cinemas.tg.screenId } },
      data: { regulatoryClass: 'REGULAR' },
    });
  }, 180_000);

  afterAll(async () => {
    if (!db || !available) return;
    const screenIds = [cinemas.tg.screenId, cinemas.ap.screenId].filter(Boolean);
    await db.showSeat.deleteMany({ where: { seat: { seatMap: { screenId: { in: screenIds } } } } });
    await db.ticketType.deleteMany({ where: { eventSession: { screenId: { in: screenIds } } } });
    await db.eventSession.deleteMany({ where: { screenId: { in: screenIds } } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.movie.deleteMany({ where: { organizationId: orgId } });
    await db.seat.deleteMany({ where: { seatMap: { screenId: { in: screenIds } } } });
    await db.seatRow.deleteMany({
      where: { section: { seatMap: { screenId: { in: screenIds } } } },
    });
    await db.seatSection.deleteMany({ where: { seatMap: { screenId: { in: screenIds } } } });
    await db.seatCategory.deleteMany({ where: { seatMap: { screenId: { in: screenIds } } } });
    await db.seatMap.deleteMany({ where: { screenId: { in: screenIds } } });
    await db.screen.deleteMany({ where: { id: { in: screenIds } } });
    await db.cinema.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.cinemaPricingPolicy.deleteMany({ where: { regulatoryReference: REFERENCE } });
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      60_000,
    );

  describe('a Telangana-like cinema (no state price rules)', () => {
    maybe('readiness BLOCKS, and says so in plain words with no link', async () => {
      const { overall, sales } = await salesChecks('tg');
      expect(overall).toBe('BLOCKED');
      expect(sales).toEqual([
        {
          section: 'SALES',
          code: 'SALE_NO_PRICING_POLICY',
          level: 'BLOCKED',
          message:
            'Ticket sales are paused for cinemas in Telangana: no state price rules are configured yet. Contact support.',
          fixPath: null,
        },
      ]);
    });

    maybe('checkout refuses with a 409 carrying the same blocker', async () => {
      const refusal = await tryToBuy(cinemas.tg.sessionId);
      expect(refusal).toEqual({
        status: 409,
        details: { reason: SALE_NOT_OPEN_REASON, blockers: ['NO_PRICING_POLICY'] },
      });
    });

    maybe('the public show summary tells the storefront before a seat is picked', async () => {
      const summary = await shows.getPublicShowSummary(cinemas.tg.sessionId);
      expect(summary.onlineBooking.open).toBe(false);
      expect(summary.onlineBooking.message).toBe(
        'Online booking is not open for this show yet. Please check back later or contact the venue.',
      );
      // Nothing about the reason leaves the server.
      expect(JSON.stringify(summary.onlineBooking)).not.toMatch(/Telangana|polic|regulat/i);
    });
  });

  describe('an Andhra Pradesh-like cinema with mapped seat classes', () => {
    maybe('readiness reports online sales open', async () => {
      const { sales } = await salesChecks('ap');
      expect(sales.map((c) => [c.code, c.level])).toEqual([['SALES_OPEN', 'READY']]);
    });

    maybe('checkout gets past eligibility', async () => {
      expect(await tryToBuy(cinemas.ap.sessionId)).toBeNull();
    });

    maybe('the public show summary says it is open', async () => {
      const summary = await shows.getPublicShowSummary(cinemas.ap.sessionId);
      expect(summary.onlineBooking).toEqual({ open: true, message: null, closedTicketTypeIds: [] });
    });

    maybe('and all three change together when a seat class is cleared', async () => {
      const where = { seatMap: { screenId: cinemas.ap.screenId } };
      await db!.seatCategory.updateMany({ where, data: { regulatoryClass: null } });
      try {
        const { sales } = await salesChecks('ap');
        expect(sales.map((c) => [c.code, c.level, c.fixPath])).toEqual([
          [
            'SALE_SEAT_CLASS_UNMAPPED',
            'BLOCKED',
            `/organizer/cinemas/${cinemas.ap.cinemaId}/readiness#seat-classes`,
          ],
        ]);
        expect(sales[0].message).toMatch(/^Seat category Standard needs a regulatory seat class/);
        expect((await tryToBuy(cinemas.ap.sessionId))?.details).toEqual({
          reason: SALE_NOT_OPEN_REASON,
          blockers: ['SEAT_CLASS_UNMAPPED'],
        });
        expect((await shows.getPublicShowSummary(cinemas.ap.sessionId)).onlineBooking.open).toBe(
          false,
        );
      } finally {
        await db!.seatCategory.updateMany({ where, data: { regulatoryClass: 'REGULAR' } });
      }
    });
  });
});
