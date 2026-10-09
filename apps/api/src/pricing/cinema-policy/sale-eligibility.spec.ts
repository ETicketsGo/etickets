import { BookingsService } from '../../bookings/bookings.service';
import { evaluatePilotReadiness } from '../../cinemas/pilot-readiness';
import {
  resolvePolicy,
  type PolicyContext,
  type PolicyRow,
} from './cinema-pricing-policy.resolver';
import {
  BUYER_SALE_NOT_OPEN,
  SALE_NOT_OPEN_REASON,
  saleBlockersFromPolicy,
  sessionSaleEligibility,
  type EligibilityTicketType,
  type PolicyCinema,
  type SaleBlockerCode,
} from './sale-eligibility';

/**
 * One answer to "can this be sold online", asked by checkout, readiness and the storefront.
 *
 * ── WHAT WENT WRONG ────────────────────────────────────────────────────────────────
 * QA, 2026-10-09: a Hyderabad cinema's readiness page said "Ready to open, Blocking 0" while
 * checkout refused every one of its shows with a 409, because Telangana has no active price
 * rules. Readiness never asked the policy engine; checkout did. Two readers, two answers.
 *
 * The test that matters is the one at the bottom: for each fixture it builds every cart a
 * buyer could build, sends each through the REAL `BookingsService.create`, collects what
 * checkout refuses, and asserts that readiness reports exactly that set - no more, no less.
 *
 * Every amount and every place below is a fixture. No rate from any government order is
 * written here; the engine holds none and neither does its test.
 */
const AT = new Date('2026-10-09T06:00:00Z');

const row = (over: Partial<PolicyRow> = {}): PolicyRow => ({
  id: over.id ?? 'p-fallback',
  version: 1,
  country: 'Fixtureland',
  region: 'North',
  district: '*',
  city: '*',
  currency: '*',
  localBodyType: null,
  cinemaFormat: null,
  climateType: null,
  seatCategory: null,
  maintenanceChargeMinor: 0,
  maintenanceTreatment: 'NOT_APPLICABLE',
  maintenanceTaxCategory: null,
  onlineFeePolicy: 'ALLOWED',
  onlineFeeCapMinor: null,
  ticketPriceMinMinor: null,
  ticketPriceMaxMinor: null,
  ticketPriceRule: null,
  effectiveFrom: new Date('2020-01-01T00:00:00Z'),
  effectiveTo: null,
  regulatoryReference: 'FIXTURE-ORDER',
  ...over,
});

/** "North" is written: a jurisdiction-level row and two class ceilings. "South" is not. */
const NORTH_ROWS: PolicyRow[] = [
  row(),
  row({ id: 'p-regular', seatCategory: 'REGULAR', ticketPriceMaxMinor: 15_000 }),
  row({ id: 'p-recliner', seatCategory: 'RECLINER', ticketPriceMaxMinor: 25_000 }),
];

const cinema = (over: Partial<PolicyCinema> = {}): PolicyCinema => ({
  id: 'cin-1',
  country: 'Fixtureland',
  region: 'North',
  district: null,
  city: 'Northtown',
  localBodyType: null,
  cinemaFormat: null,
  climateType: null,
  venue: null,
  ...over,
});

const tt = (
  id: string,
  priceMinor: number,
  seat: { name: string; regulatoryClass: string | null } | null,
): EligibilityTicketType => ({
  id,
  name: `Ticket ${id}`,
  priceMinor,
  currency: 'INR',
  seatCategory: seat,
});

const STANDARD_UNMAPPED = { name: 'Standard', regulatoryClass: null };
const GOLD_REGULAR = { name: 'Gold', regulatoryClass: 'REGULAR' };
const LOUNGER_RECLINER = { name: 'Lounger', regulatoryClass: 'RECLINER' };

interface Fixture {
  name: string;
  rows: PolicyRow[];
  cinema: PolicyCinema;
  ticketTypes: EligibilityTicketType[];
  expected: SaleBlockerCode[];
}

const FIXTURES: Fixture[] = [
  {
    name: 'a state with no price rules (the Telangana case)',
    rows: NORTH_ROWS,
    cinema: cinema({ region: 'South', city: 'Southtown' }),
    ticketTypes: [tt('a', 15_000, GOLD_REGULAR), tt('b', 25_000, LOUNGER_RECLINER)],
    expected: ['NO_PRICING_POLICY'],
  },
  {
    name: 'a seat category with no regulatory class',
    rows: NORTH_ROWS,
    cinema: cinema(),
    ticketTypes: [tt('a', 15_000, STANDARD_UNMAPPED)],
    expected: ['SEAT_CLASS_UNMAPPED'],
  },
  {
    name: 'one mapped and one unmapped category',
    rows: NORTH_ROWS,
    cinema: cinema(),
    ticketTypes: [tt('a', 15_000, GOLD_REGULAR), tt('b', 15_000, STANDARD_UNMAPPED)],
    expected: ['SEAT_CLASS_UNMAPPED'],
  },
  {
    name: 'a state that prices by cinema type, for a cinema with no type',
    rows: [row({ localBodyType: 'MUNICIPAL_CORPORATION' })],
    cinema: cinema(),
    ticketTypes: [tt('a', 15_000, GOLD_REGULAR)],
    expected: ['CINEMA_NOT_CLASSIFIED'],
  },
  {
    name: 'two equally specific rules',
    rows: [row({ id: 'x1' }), row({ id: 'x2', regulatoryReference: 'FIXTURE-OTHER' })],
    cinema: cinema(),
    ticketTypes: [tt('a', 15_000, null)],
    expected: ['PRICING_POLICY_CONFLICT'],
  },
  {
    name: 'a ticket priced over its class ceiling',
    rows: NORTH_ROWS,
    cinema: cinema(),
    ticketTypes: [tt('a', 15_100, GOLD_REGULAR), tt('b', 25_000, LOUNGER_RECLINER)],
    expected: ['PRICE_OVER_CEILING'],
  },
  {
    name: 'a correctly configured cinema (the Andhra Pradesh case)',
    rows: NORTH_ROWS,
    cinema: cinema(),
    ticketTypes: [tt('a', 15_000, GOLD_REGULAR), tt('b', 25_000, LOUNGER_RECLINER)],
    expected: [],
  },
  {
    name: 'an unregulated country',
    rows: NORTH_ROWS,
    cinema: cinema({ country: 'Elsewhere', region: 'Anywhere' }),
    ticketTypes: [tt('a', 99_000, STANDARD_UNMAPPED)],
    expected: [],
  },
];

const resolverFor = (rows: PolicyRow[]) => async (ctx: PolicyContext) => resolvePolicy(rows, ctx);

/** The real booking path, with a policy service reading the fixture's rows. */
function checkoutFor(f: Fixture) {
  const session = {
    id: 'sess-1',
    eventId: 'ev-1',
    // Not seated, so the cart needs no seat ids: what is under test is the pricing refusal.
    screenId: null,
    startsAt: new Date(Date.now() + 3 * 86_400_000),
    status: 'SCHEDULED',
    event: {
      id: 'ev-1',
      organizationId: 'org-1',
      status: 'PUBLISHED',
      experienceType: 'MOVIE',
      feeMode: 'CUSTOMER_PAYS',
      isFree: false,
      category: 'Movie',
      venue: { country: 'India', region: f.cinema.region, city: f.cinema.city },
      organization: {
        registeredCountry: 'India',
        registeredRegion: f.cinema.region,
        cashPaymentsEnabled: false,
        name: 'Fixture Cinemas',
        status: 'APPROVED',
      },
    },
    screen: { cinema: f.cinema },
  };
  const ticketTypes = f.ticketTypes.map((t) => ({
    ...t,
    eventSessionId: 'sess-1',
    maxPerOrder: 10,
    salesStartAt: null,
    salesEndAt: null,
    status: 'ACTIVE',
    seatCategoryId: null,
    seatZoneId: null,
  }));
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    eventSession: { findUnique: jest.fn().mockResolvedValue(session) },
    ticketType: {
      findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
        ticketTypes.filter((t) => args.where.id.in.includes(t.id)),
      ),
    },
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    coupon: { findUnique: jest.fn().mockResolvedValue(null) },
    // Anything past the eligibility check is not this test's business; stop there.
    $transaction: jest.fn().mockRejectedValue(new Error('past eligibility')),
  };
  const pricingStrategies = {
    quote: jest.fn((input: { lines: { basePriceMinor: number; quantity: number }[] }) => ({
      subtotalMinor: input.lines.reduce((n, l) => n + l.basePriceMinor * l.quantity, 0),
      lines: [],
    })),
  };
  const pricing = {
    quote: jest.fn().mockRejectedValue(new Error('past eligibility')),
  };
  const policyService = {
    resolve: resolverFor(f.rows),
    logResolution: () => undefined,
    auditFor: () => ({}),
  };
  const stub = {} as never;
  const service = new BookingsService(
    prisma as never,
    pricing as never,
    pricingStrategies as never,
    audit as never,
    stub,
    stub,
    stub,
    stub,
    stub,
    undefined,
    undefined,
    policyService as never,
  );
  return { service, audit };
}

/** Every cart readiness promises to speak for: each ticket type alone, and all together. */
const cartsOf = (f: Fixture) => [
  ...f.ticketTypes.map((t) => [t.id]),
  ...(f.ticketTypes.length > 1 ? [f.ticketTypes.map((t) => t.id)] : []),
];

async function checkoutRefusals(f: Fixture) {
  const { service } = checkoutFor(f);
  const refused = new Set<string>();
  const sold: string[][] = [];
  for (const ids of cartsOf(f)) {
    try {
      await service.create(null, {
        eventSessionId: 'sess-1',
        buyerName: 'B',
        buyerEmail: 'b@t.test',
        items: ids.map((ticketTypeId) => ({ ticketTypeId, quantity: 1 })),
      } as never);
    } catch (e) {
      const details = (e as { details?: { reason?: string; blockers?: string[] } }).details;
      if (details?.reason === SALE_NOT_OPEN_REASON) {
        details.blockers?.forEach((code) => refused.add(code));
        continue;
      }
    }
    sold.push(ids);
  }
  return { refused, sold };
}

describe('saleBlockersFromPolicy - each kind of blocker', () => {
  it.each(FIXTURES.filter((f) => f.expected.length > 0))('$name', async (f) => {
    const verdict = await sessionSaleEligibility(
      resolverFor(f.rows),
      f.cinema,
      f.ticketTypes,
      'India',
      AT,
    );
    expect(verdict.sellable).toBe(false);
    expect([...new Set(verdict.blockers.map((b) => b.code))].sort()).toEqual(
      [...f.expected].sort(),
    );
    for (const b of verdict.blockers) {
      // The buyer is told the same plain sentence whatever the reason.
      expect(b.buyerMessage).toBe(BUYER_SALE_NOT_OPEN);
      // The organizer is told what to do in words, never in the engine's vocabulary.
      expect(b.organizerMessage).not.toMatch(
        /POLICY_|INVALID_|FIXTURE-|G\.O\.|regulatoryReference/,
      );
      // ASCII only, by house rule, apart from the currency symbol a price is written with.
      expect(b.organizerMessage.replace(/₹/g, '')).toMatch(/^[\x20-\x7E]*$/);
      // Only the organizer's own problems link anywhere.
      if (b.owner === 'PLATFORM') expect(b.fixPath).toBeNull();
      else expect(b.fixPath).toMatch(/^\/organizer\/cinemas\/cin-1\//);
    }
  });

  it('tells a Telangana-like organizer to contact support, naming the state', async () => {
    const [b] = (
      await sessionSaleEligibility(
        resolverFor(NORTH_ROWS),
        FIXTURES[0].cinema,
        FIXTURES[0].ticketTypes,
        'India',
        AT,
      )
    ).blockers;
    expect(b.organizerMessage).toBe(
      'Ticket sales are paused for cinemas in South: no state price rules are configured yet. Contact support.',
    );
    expect(b.owner).toBe('PLATFORM');
  });

  it('names the unmapped category and sends the organizer to Seat classes', async () => {
    const [b] = (
      await sessionSaleEligibility(
        resolverFor(NORTH_ROWS),
        cinema(),
        [tt('a', 1, STANDARD_UNMAPPED)],
        'India',
        AT,
      )
    ).blockers;
    expect(b.organizerMessage).toMatch(/^Seat category Standard needs a regulatory seat class/);
    expect(b.organizerMessage).toMatch(/Set it under Seat classes\.$/);
    expect(b.fixPath).toBe('/organizer/cinemas/cin-1/readiness#seat-classes');
  });

  it('keeps the rest of the room on sale when only one category is unmapped', async () => {
    const verdict = await sessionSaleEligibility(
      resolverFor(NORTH_ROWS),
      cinema(),
      [tt('a', 15_000, GOLD_REGULAR), tt('b', 15_000, STANDARD_UNMAPPED)],
      'India',
      AT,
    );
    expect(verdict.sellable).toBe(false);
    expect(verdict.sellableTicketTypeIds).toEqual(['a']);
  });

  it('reports a status the mapping does not know as the platform`s, with no link', () => {
    const blockers = saleBlockersFromPolicy(
      {
        resolution: {
          status: 'PRICE_EXCEEDS_LIMIT',
          policy: null,
          explanation: 'x',
          specificity: 0,
        },
        effect: {} as never,
        context: { region: 'North', currency: 'INR', unmappedSeatCategories: [] } as never,
        overCeiling: [],
      },
      { cinemaId: 'cin-1', ticketTypeIds: ['a'] },
    );
    expect(blockers).toEqual([
      expect.objectContaining({
        code: 'REGULATORY_PRICING_UNRESOLVED',
        owner: 'PLATFORM',
        fixPath: null,
        ticketTypeIds: ['a'],
      }),
    ]);
  });
});

describe('checkout refuses with the buyer sentence, never the regulation', () => {
  it('409s a Telangana-like show with a plain message and a machine-readable reason', async () => {
    const { service, audit } = checkoutFor(FIXTURES[0]);
    const err = await service
      .create(null, {
        eventSessionId: 'sess-1',
        buyerName: 'B',
        buyerEmail: 'b@t.test',
        items: [{ ticketTypeId: 'a', quantity: 1 }],
      } as never)
      .catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.message).toBe(BUYER_SALE_NOT_OPEN);
    expect(err.message).not.toMatch(/Telangana|South|regulat|polic/i);
    expect(err.details).toEqual({ reason: SALE_NOT_OPEN_REASON, blockers: ['NO_PRICING_POLICY'] });
    // The full explanation still reaches the audit, where somebody can act on it.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CINEMA_PRICING_POLICY_BLOCKED_BOOKING' }),
    );
  });
});

describe('readiness and checkout agree, fixture by fixture', () => {
  it.each(FIXTURES)('$name', async (f) => {
    // Checkout: every cart, through the real booking path.
    const { refused, sold } = await checkoutRefusals(f);

    // Readiness: the same shows, through the function readiness is built from, into the
    // readiness rules themselves.
    const verdict = await sessionSaleEligibility(
      resolverFor(f.rows),
      f.cinema,
      f.ticketTypes,
      'India',
      AT,
    );
    const checks = evaluatePilotReadiness({
      cinemaId: 'cin-1',
      organization: { status: 'APPROVED', contactEmail: 'a@t.test', contactPhone: null },
      cinema: { timezone: 'Asia/Kolkata', status: 'ACTIVE', address: 'x', city: 'x' },
      activeScreens: 1,
      totalScreens: 1,
      activeScreensWithoutPublishedLayout: [],
      operatorCount: 2,
      pricedCategories: 1,
      unpricedCategories: 0,
      futureShowsWithZeroPrice: 0,
      futureShowsPriced: 1,
      activeFeeRules: 1,
      hasCancellationPolicy: true,
      hasInrPaymentRoute: true,
      payments: {
        environment: 'STAGING',
        provider: 'razorpay',
        razorpay: { hasKeyId: true, hasKeySecret: true, hasWebhookSecret: true, mode: 'test' },
        liveEnabled: false,
      },
      futurePublishedShows: 1,
      publicCatalogueReachable: true,
      onlineSales: {
        sessionsChecked: 1,
        blockers: verdict.blockers.map((b) => ({ ...b, affectedSessions: 1 })),
      },
    });
    const readinessBlocking = new Set(
      checks
        .filter((c) => c.section === 'SALES' && c.level === 'BLOCKED')
        .map((c) => c.code.replace(/^SALE_/, '')),
    );

    expect([...readinessBlocking].sort()).toEqual([...refused].sort());
    expect([...refused].sort()).toEqual([...f.expected].sort());
    // And the storefront's "can anything be bought" matches whether any cart went through.
    expect(verdict.sellableTicketTypeIds.length > 0).toBe(sold.some((ids) => ids.length === 1));
    if (f.expected.length === 0) {
      expect(checks.find((c) => c.code === 'SALES_OPEN')?.level).toBe('READY');
    }
  });
});
