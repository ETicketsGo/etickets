import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { saleStateLabel } from '@eticketsgo/shared-types';
import { ShowsService } from '../shows/shows.service';
import { BookingsService } from '../bookings/bookings.service';
import { PricingStrategiesService } from '../pricing/pricing-strategies.service';
import {
  FlatPricingStrategy,
  SeatPricingStrategy,
  TierPricingStrategy,
} from '../pricing/pricing-strategies';
import { CinemaPricingPolicyService } from '../pricing/cinema-policy/cinema-pricing-policy.service';
import { SaleEligibilityService } from '../pricing/cinema-policy/sale-eligibility.service';
import { SALE_NOT_OPEN_REASON } from '../pricing/cinema-policy/sale-eligibility';
import { OrganizerSaleEligibilityService } from './organizer-sale-eligibility.service';

/**
 * integration-real-postgres - the unified sale state agrees with what checkout accepts.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * QA, 2026-10-10: one Vijayawada show read "Not selling" on the Overview and "Selling" in the
 * cinema drawer, while checkout sold its mapped seat category and refused the unmapped one.
 * The screens now render one server answer; this file holds that answer to checkout itself:
 *
 *   SELLING      -> a booking for every listed category gets past checkout's sale checks
 *   PARTIAL      -> the open categories get past them, the closed ones are refused
 *   NOT_SELLING  -> every category is refused (SALE_NOT_OPEN for a regulatory reason)
 *
 * Real Postgres because the defect lived in what each reader QUERIED; a stub returns whatever
 * the test hands it. The booking is real `BookingsService.create` with pricing stubbed to stop
 * it the moment it is past eligibility, so nothing is held and nothing has to be released.
 *
 * ── THE FIXTURE ────────────────────────────────────────────────────────────────────
 * A country only this file uses, with ACTIVE fixture rules for "Andhra Pradesh" and none for
 * "Telangana". Invented amounts, a reference this file deletes; no seeded row is touched.
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
  id: 'itest-sale-state',
  email: 's@t.test',
  fullName: 'S',
  roles: [],
} as never;
const allowAll = { assertMember: async () => undefined } as never;

const suffix = `state-${Date.now()}`;
const COUNTRY = `SaleStateTest${Date.now()}`;
const REFERENCE = `ITEST-STATE-${suffix}`;

type Key = 'tg' | 'ap';
type Outcome =
  | { outcome: 'ACCEPTED' }
  | { outcome: 'SALE_NOT_OPEN'; blockers: unknown }
  | { outcome: 'REFUSED'; message: string };

describe('integration-real-postgres: the unified sale state agrees with checkout', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let shows: ShowsService;
  let bookings: BookingsService;
  let eligibility: SaleEligibilityService;
  let organizer: OrganizerSaleEligibilityService;

  let orgId = '';
  let otherOrgId = '';
  const fx: Record<Key, { screenId: string; sessionId: string; eventId: string }> = {
    tg: { screenId: '', sessionId: '', eventId: '' },
    ap: { screenId: '', sessionId: '', eventId: '' },
  };

  // Two seat categories, so one can be mapped and the other not.
  const LAYOUT = {
    name: 'Main',
    sections: [
      {
        name: 'Gold',
        categoryName: 'Gold',
        basePriceMinor: 18_000,
        rowLabels: ['A'],
        seatsPerRow: 5,
      },
      {
        name: 'Standard',
        categoryName: 'Standard',
        basePriceMinor: 15_000,
        rowLabels: ['B'],
        seatsPerRow: 5,
      },
    ],
  };

  async function makeCinema(key: Key, region: string, city: string) {
    const venue = await db!.venue.create({
      data: {
        organizationId: orgId,
        name: `State venue ${key} ${suffix}`,
        city,
        region,
        country: 'India',
        timezone: 'Asia/Kolkata',
      },
    });
    const cinema = await db!.cinema.create({
      data: {
        organizationId: orgId,
        name: `State ${key} ${suffix}`,
        city,
        region,
        country: COUNTRY,
        timezone: 'Asia/Kolkata',
        venueId: venue.id,
      },
    });
    const screen = await db!.screen.create({
      data: { cinemaId: cinema.id, name: 'Screen 1', screenType: '2D', capacity: 10 },
    });
    const movie = await db!.movie.create({
      data: {
        organizationId: orgId,
        title: `State Film ${key} ${suffix}`,
        slug: `state-film-${key}-${suffix}`,
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
    const session = await db!.eventSession.findUniqueOrThrow({
      where: { id: scheduled.sessionId },
      select: { eventId: true },
    });
    fx[key] = { screenId: screen.id, sessionId: scheduled.sessionId, eventId: session.eventId };
  }

  const mapCategory = (key: Key, name: string, cls: 'REGULAR' | null) =>
    db!.seatCategory.updateMany({
      where: { name, seatMap: { screenId: fx[key].screenId } },
      data: { regulatoryClass: cls },
    });

  const ticketTypes = (key: Key) =>
    db!.ticketType.findMany({
      where: { eventSessionId: fx[key].sessionId, status: 'ACTIVE' },
      select: { id: true, name: true, seatCategoryId: true },
    }) as Promise<{ id: string; name: string; seatCategoryId: string }[]>;

  /** One seat of one ticket type through the real booking path. */
  async function tryToBuy(key: Key, ticketTypeId: string): Promise<Outcome> {
    const tt = await db!.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId } });
    const seat = await db!.showSeat.findFirst({
      where: {
        eventSessionId: fx[key].sessionId,
        status: 'AVAILABLE',
        seat: { seatCategoryId: tt.seatCategoryId },
      },
      select: { seatId: true },
    });
    try {
      await bookings.create(null, {
        eventSessionId: fx[key].sessionId,
        buyerName: 'Buyer',
        buyerEmail: 'buyer@t.test',
        items: [{ ticketTypeId, quantity: 1, seatIds: [seat.seatId] }],
      } as never);
      return { outcome: 'ACCEPTED' };
    } catch (e) {
      const err = e as { message?: string; details?: Record<string, unknown> };
      // The pricing stub: everything checkout checks before pricing has passed.
      if (err.message === 'past eligibility') return { outcome: 'ACCEPTED' };
      if (err.details?.reason === SALE_NOT_OPEN_REASON)
        return { outcome: 'SALE_NOT_OPEN', blockers: err.details.blockers };
      return { outcome: 'REFUSED', message: String(err.message) };
    }
  }

  const stateOf = async (key: Key) => {
    const [answer] = await eligibility.sessionStates({ id: fx[key].sessionId });
    return answer!.state;
  };

  /** Every listed category, bought one at a time, against what the state says of it. */
  async function expectCheckoutAgrees(key: Key) {
    const state = await stateOf(key);
    for (const t of await ticketTypes(key)) {
      const result = await tryToBuy(key, t.id);
      if (state.openTicketTypeIds.includes(t.id)) {
        expect([t.name, result]).toEqual([t.name, { outcome: 'ACCEPTED' }]);
      } else {
        expect(state.closedTicketTypeIds).toContain(t.id);
        expect([t.name, result.outcome]).not.toEqual([t.name, 'ACCEPTED']);
      }
    }
    return state;
  }

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
    eligibility = new SaleEligibilityService(db as never, policies);
    organizer = new OrganizerSaleEligibilityService(db as never, allowAll, eligibility);
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
    bookings = new BookingsService(
      db as never,
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
      data: { name: `State ${suffix}`, slug: `state-${suffix}`, status: 'APPROVED' },
    });
    orgId = org.id;
    const other = await db.organization.create({
      data: { name: `State other ${suffix}`, slug: `state-other-${suffix}`, status: 'APPROVED' },
    });
    otherOrgId = other.id;
    await makeCinema('tg', 'Telangana', 'Hyderabad');
    await makeCinema('ap', 'Andhra Pradesh', 'Vijayawada');

    // Telangana fully mapped: its only refusal is the missing state rules.
    await mapCategory('tg', 'Gold', 'REGULAR');
    await mapCategory('tg', 'Standard', 'REGULAR');
    // Vijayawada as found on QA: Gold mapped, Standard not.
    await mapCategory('ap', 'Gold', 'REGULAR');
  }, 180_000);

  afterAll(async () => {
    if (!db || !available) return;
    const screenIds = [fx.tg.screenId, fx.ap.screenId].filter(Boolean);
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
    await db.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
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
      90_000,
    );

  maybe(
    'Telangana: NOT_SELLING, and checkout refuses every category with SALE_NOT_OPEN',
    async () => {
      const state = await stateOf('tg');
      expect(state.state).toBe('NOT_SELLING');
      expect(saleStateLabel(state)).toBe('Not selling: Telangana pricing rules not configured');
      expect(state.openTicketTypeIds).toEqual([]);
      for (const t of await ticketTypes('tg')) {
        expect(await tryToBuy('tg', t.id)).toEqual({
          outcome: 'SALE_NOT_OPEN',
          blockers: ['NO_PRICING_POLICY'],
        });
      }
    },
  );

  maybe(
    'Vijayawada, one category unmapped: PARTIAL - Gold sells, Standard is refused',
    async () => {
      const state = await expectCheckoutAgrees('ap');
      expect(state.state).toBe('PARTIAL');
      expect(saleStateLabel(state)).toBe('Partly selling: seat classes not mapped');
      const byName = new Map((await ticketTypes('ap')).map((t) => [t.name, t.id]));
      expect(state.openTicketTypeIds).toEqual([byName.get('Gold')]);
      expect(state.closedTicketTypeIds).toEqual([byName.get('Standard')]);
      expect(await tryToBuy('ap', byName.get('Standard')!)).toEqual({
        outcome: 'SALE_NOT_OPEN',
        blockers: ['SEAT_CLASS_UNMAPPED'],
      });
    },
  );

  maybe('Vijayawada, every category mapped: SELLING, and checkout takes each one', async () => {
    await mapCategory('ap', 'Standard', 'REGULAR');
    try {
      const state = await expectCheckoutAgrees('ap');
      expect(state.state).toBe('SELLING');
      expect(state.closedTicketTypeIds).toEqual([]);
    } finally {
      await mapCategory('ap', 'Standard', null);
    }
  });

  maybe('a paused show is NOT_SELLING, and checkout refuses it too', async () => {
    await db!.eventSession.update({ where: { id: fx.ap.sessionId }, data: { status: 'PAUSED' } });
    try {
      const state = await expectCheckoutAgrees('ap');
      expect(saleStateLabel(state)).toBe('Not selling: sales paused');
    } finally {
      await db!.eventSession.update({
        where: { id: fx.ap.sessionId },
        data: { status: 'SCHEDULED' },
      });
    }
  });

  maybe(
    'the per-event and per-show reads give the same answer, scoped to the organization',
    async () => {
      const { events } = await organizer.forEvents(ORGANIZER, orgId, [
        fx.tg.eventId,
        fx.ap.eventId,
      ]);
      const byId = new Map(events.map((e) => [e.eventId, e]));
      expect(byId.get(fx.tg.eventId)?.state).toBe('NOT_SELLING');
      expect(byId.get(fx.ap.eventId)?.state).toBe('PARTIAL');
      expect(saleStateLabel(byId.get(fx.ap.eventId)!)).toBe(
        'Partly selling: seat classes not mapped',
      );

      const { sessions } = await organizer.forSessions(ORGANIZER, orgId, [fx.ap.sessionId]);
      expect(sessions[0]).toMatchObject({ state: 'PARTIAL', open: true, sellable: false });

      // Another organization asking gets nothing back, not a refusal that confirms the ids.
      expect((await organizer.forEvents(ORGANIZER, otherOrgId, [fx.ap.eventId])).events).toEqual(
        [],
      );
      expect(
        (await organizer.forSessions(ORGANIZER, otherOrgId, [fx.ap.sessionId])).sessions,
      ).toEqual([]);
    },
  );
});
