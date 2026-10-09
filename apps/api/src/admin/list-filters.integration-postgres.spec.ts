/*
  ── WHY THIS FILE HAS ITS OWN MARKET AND ITS OWN YEAR ───────────────────────────────
  55 spec files write venues in 'India' and almost all of them write rows dated "now". A fixture
  dimension another file can also write is a shared global, not a fixture, so this file uses a
  market nobody else sells in (New Zealand, under two spellings, against Australia as the market
  that must be left out) and a window in January 2020 that no other file's rows can fall into. It
  also filters by its own organizer throughout, so a parallel file cannot move any number here.
*/
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AdminService } from './admin.service';
import { AdminGroupingService } from './admin-grouping.service';
import { RefundsService } from '../refunds/refunds.service';
import { SettlementService } from '../payments/settlement/settlement.service';
import { SupportService } from '../support/support.service';
import { AuditQueryService } from '../audit/audit-query.service';

/**
 * integration-real-postgres - the finance and operations filters against a real database.
 *
 * ── WHAT THIS PROVES THAT THE UNIT SPEC CANNOT ─────────────────────────────────────
 *  - The Prisma `where` each list builds and the raw SQL each grouped summary builds select the
 *    SAME rows: the summary's counts add up to the list's total, and its per-currency money adds
 *    up to the listed rows' money, currency by currency. Two queries in two dialects written to
 *    agree are only known to agree by running both.
 *  - The window is whole UTC days at both ends: a row at 23:59:59.999 on `to` is in, a row at
 *    midnight after it is out, and so is a row a millisecond before `from`. The raw summary
 *    compares zone-less timestamps, so this also catches a session time zone shifting the day.
 *  - "New Zealand" and "nz" are one market, and Australia is not in it.
 *  - Two currencies are kept apart: NZD and USD come back as two totals, never one.
 *
 * Read-only against everything it did not create. Every row is created here and deleted after.
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

const suffix = `lf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** The window under test, and instants just inside and just outside it. */
const FROM = '2020-01-10';
const TO = '2020-01-12';
const AT = {
  beforeFrom: new Date('2020-01-09T23:59:59.999Z'),
  fromStart: new Date('2020-01-10T00:00:00.000Z'),
  middle: new Date('2020-01-11T12:00:00.000Z'),
  toEnd: new Date('2020-01-12T23:59:59.999Z'),
  afterTo: new Date('2020-01-13T00:00:00.000Z'),
};
const INSIDE = [AT.fromStart, AT.middle, AT.toEnd];
const OUTSIDE = [AT.beforeFrom, AT.afterTo];

describe('integration-real-postgres: admin finance and operations filters', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;

  let admin: AdminService;
  let grouping: AdminGroupingService;
  let refunds: RefundsService;
  let settlements: SettlementService;
  let support: SupportService;
  let audit: AuditQueryService;

  const ids = {
    orgs: [] as string[],
    events: [] as string[],
    bookings: [] as string[],
    feedback: [] as string[],
    audit: [] as string[],
  };
  let orgA = '';
  let orgB = '';
  /** Events of org A: NZ in NZD ("New Zealand"), NZ in USD ("nz"), and AU in AUD. */
  let evNzd = '';
  let evUsd = '';
  let evAud = '';
  /** Org B's event in New Zealand, which the organizer filter must leave out. */
  let evOther = '';

  async function makeEvent(organizationId: string, country: string, label: string) {
    const venue = await db!.venue.create({
      data: { organizationId, name: `LF ${label}`, city: 'Auckland', country },
    });
    const event = await db!.event.create({
      data: {
        organizationId,
        venueId: venue.id,
        title: `LF ${label} ${suffix}`,
        slug: `lf-${label}-${suffix}`,
        category: 'Music',
        status: 'PUBLISHED',
      },
    });
    const session = await db!.eventSession.create({
      data: {
        eventId: event.id,
        startsAt: new Date('2020-02-01T10:00:00.000Z'),
        endsAt: new Date('2020-02-01T12:00:00.000Z'),
      },
    });
    ids.events.push(event.id);
    return { eventId: event.id, sessionId: session.id };
  }

  /**
   * One sale: a booking, its payment, a refund request and - for the first sale of a currency
   * on an event - nothing else; settlements are one per event and currency, made separately.
   * Amounts differ per row so a total that dropped or doubled a row cannot match by accident.
   */
  let seq = 0;
  async function sale(
    organizationId: string,
    ev: { eventId: string; sessionId: string },
    currency: string,
    at: Date,
  ) {
    seq += 1;
    const amount = 1_000 + seq * 7;
    const booking = await db!.booking.create({
      data: {
        organizationId,
        eventId: ev.eventId,
        eventSessionId: ev.sessionId,
        buyerName: 'LF Buyer',
        buyerEmail: `lf-${seq}-${suffix}@example.test`,
        status: 'CONFIRMED',
        currency,
        subtotalMinor: amount,
        totalMinor: amount,
        holdExpiresAt: at,
        createdAt: at,
      },
    });
    ids.bookings.push(booking.id);
    await db!.payment.create({
      data: {
        bookingId: booking.id,
        provider: 'mock',
        status: 'SUCCEEDED',
        amountMinor: amount,
        currency,
        createdAt: at,
      },
    });
    await db!.refund.create({
      data: {
        bookingId: booking.id,
        organizationId,
        amountMinor: Math.floor(amount / 2),
        status: seq % 2 === 0 ? 'COMPLETED' : 'REQUESTED',
        reason: 'LF fixture',
        createdAt: at,
      },
    });
    const fb = await db!.feedback.create({
      data: {
        kind: 'COMPLAINT',
        organizationId,
        bookingId: booking.id,
        message: `LF complaint ${seq}`,
        status: 'OPEN',
        createdAt: at,
      },
    });
    ids.feedback.push(fb.id);
    const entry = await db!.auditLog.create({
      data: {
        organizationId,
        action: 'BOOKING_CONFIRMED',
        entityType: 'Booking',
        entityId: booking.id,
        metadata: { eventId: ev.eventId },
        createdAt: at,
      },
    });
    ids.audit.push(entry.id);
    return booking.id;
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

    const none = {} as never;
    admin = new AdminService(db as never, none);
    grouping = new AdminGroupingService(db as never);
    refunds = new RefundsService(db as never, none, none, none, none, none, none, none);
    settlements = new SettlementService(db as never, none, none, none, none);
    support = new SupportService(db as never);
    audit = new AuditQueryService(db as never);

    const a = await db.organization.create({
      data: { name: `LF A ${suffix}`, slug: `lf-a-${suffix}`, registeredCountry: 'New Zealand' },
    });
    const b = await db.organization.create({
      data: { name: `LF B ${suffix}`, slug: `lf-b-${suffix}`, registeredCountry: 'nz' },
    });
    orgA = a.id;
    orgB = b.id;
    ids.orgs.push(orgA, orgB);

    const nzd = await makeEvent(orgA, 'New Zealand', 'nzd');
    const usd = await makeEvent(orgA, 'nz', 'usd');
    const aud = await makeEvent(orgA, 'Australia', 'aud');
    const other = await makeEvent(orgB, 'New Zealand', 'other');
    evNzd = nzd.eventId;
    evUsd = usd.eventId;
    evAud = aud.eventId;
    evOther = other.eventId;

    for (const at of [...INSIDE, ...OUTSIDE]) {
      await sale(orgA, nzd, 'NZD', at);
      await sale(orgA, usd, 'USD', at);
      await sale(orgA, aud, 'AUD', at);
      await sale(orgB, other, 'NZD', at);
    }

    // One settlement per event and currency - the unique key - each dated inside or outside.
    const settlementRows: [string, string, string, Date, number][] = [
      [orgA, evNzd, 'nzd', AT.middle, 50_000],
      [orgA, evUsd, 'usd', AT.toEnd, 70_001],
      [orgA, evAud, 'aud', AT.middle, 90_000],
      [orgB, evOther, 'nzd', AT.middle, 11_000],
    ];
    for (const [organizationId, eventId, currency, at, payable] of settlementRows) {
      await db.settlement.create({
        data: {
          organizationId,
          eventId,
          currency,
          provider: 'mock',
          status: 'ELIGIBLE',
          grossSalesMinor: payable,
          payableMinor: payable,
          createdAt: at,
        },
      });
    }
    // The same event in a second currency, dated just after the window: must be left out.
    await db.settlement.create({
      data: {
        organizationId: orgA,
        eventId: evNzd,
        currency: 'usd',
        provider: 'mock',
        status: 'ELIGIBLE',
        payableMinor: 5,
        createdAt: AT.afterTo,
      },
    });

    // An audit entry ABOUT the NZD event itself, and a platform entry with no organizer.
    const own = await db.auditLog.create({
      data: {
        organizationId: orgA,
        action: 'EVENT_PUBLISHED',
        entityType: 'Event',
        entityId: evNzd,
        createdAt: AT.middle,
      },
    });
    const platform = await db.auditLog.create({
      data: {
        organizationId: null,
        action: 'PLATFORM_FIXTURE',
        entityType: 'Event',
        entityId: evNzd,
        createdAt: AT.middle,
      },
    });
    ids.audit.push(own.id, platform.id);
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.auditLog.deleteMany({ where: { id: { in: ids.audit } } }).catch(() => {});
    await db.feedback.deleteMany({ where: { id: { in: ids.feedback } } }).catch(() => {});
    await db.refund.deleteMany({ where: { bookingId: { in: ids.bookings } } }).catch(() => {});
    await db.payment.deleteMany({ where: { bookingId: { in: ids.bookings } } }).catch(() => {});
    await db.settlement.deleteMany({ where: { organizationId: { in: ids.orgs } } }).catch(() => {});
    await db.booking.deleteMany({ where: { id: { in: ids.bookings } } }).catch(() => {});
    await db.eventSession.deleteMany({ where: { eventId: { in: ids.events } } }).catch(() => {});
    await db.event.deleteMany({ where: { id: { in: ids.events } } }).catch(() => {});
    await db.venue.deleteMany({ where: { organizationId: { in: ids.orgs } } }).catch(() => {});
    await db.organization.deleteMany({ where: { id: { in: ids.orgs } } }).catch(() => {});
    await db.$disconnect();
  }, 120_000);

  const guard = () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] test skipped - DB unavailable');
      return false;
    }
    return true;
  };

  /** Money per currency, from listed rows, upper-cased the way a person reads a code. */
  function perCurrency(rows: { currency: string; amount: number }[]) {
    const out: Record<string, { count: number; totalMinor: number }> = {};
    for (const r of rows) {
      const c = r.currency.toUpperCase();
      out[c] ??= { count: 0, totalMinor: 0 };
      out[c].count += 1;
      out[c].totalMinor += r.amount;
    }
    return out;
  }

  /** The summary grouped by currency, in the same shape. */
  async function summaryPerCurrency(resource: string, filters: Record<string, string>) {
    const summary = await grouping.grouped(resource, 'currency', filters);
    const out: Record<string, { count: number; totalMinor: number }> = {};
    for (const g of summary.groups) {
      // One currency per group, so exactly one total, in that group's own currency.
      expect(g.totals).toHaveLength(1);
      out[g.label] = { count: g.count, totalMinor: g.totals[0].totalMinor };
    }
    return out;
  }

  const WINDOW = { country: 'NZ', organizationId: '', from: FROM, to: TO };
  const window = () => ({ ...WINDOW, organizationId: orgA });

  it('payments: the list and its per-currency summary agree, in two currencies', async () => {
    if (!guard()) return;
    const filters = window();
    const list = await admin.payments({ page: 1, pageSize: 100, ...filters });

    // 3 instants inside the window x 2 NZ events of org A. Australia, org B and the two
    // boundary instants outside the window are all left out.
    expect(list.meta.total).toBe(6);
    expect(list.data.every((p) => p.currency === 'NZD' || p.currency === 'USD')).toBe(true);

    const fromList = perCurrency(
      list.data.map((p) => ({ currency: p.currency, amount: p.amountMinor })),
    );
    expect(Object.keys(fromList).sort()).toEqual(['NZD', 'USD']);
    expect(await summaryPerCurrency('payments', filters)).toEqual(fromList);
  });

  it('payments: a single day is the whole UTC day, and the event filter narrows to one event', async () => {
    if (!guard()) return;
    const lastDay = await admin.payments({
      page: 1,
      pageSize: 100,
      ...window(),
      from: TO,
      to: TO,
      eventId: evUsd,
    });
    // Only the row at 23:59:59.999 on the 12th, for the USD event.
    expect(lastDay.meta.total).toBe(1);
    expect(lastDay.data[0].currency).toBe('USD');

    const summary = await grouping.grouped('payments', 'event', {
      ...window(),
      from: TO,
      to: TO,
      eventId: evUsd,
    });
    expect(summary.groups).toEqual([
      expect.objectContaining({
        key: evUsd,
        count: 1,
        totals: [{ currency: 'USD', totalMinor: lastDay.data[0].amountMinor }],
      }),
    ]);
  });

  it('refunds: list and summary agree under status, market, organizer and window', async () => {
    if (!guard()) return;
    for (const status of [undefined, 'REQUESTED', 'COMPLETED']) {
      const filters = { ...window(), ...(status ? { status } : {}) };
      const list = await refunds.adminList(status as never, 1, 100, undefined, filters);
      const rows = list.data as unknown as { amountMinor: number; booking: { currency: string } }[];
      const fromList = perCurrency(
        rows.map((r) => ({ currency: r.booking.currency, amount: r.amountMinor })),
      );
      expect(await summaryPerCurrency('refunds', filters)).toEqual(fromList);
      if (!status) {
        expect(list.meta.total).toBe(6);
        expect(Object.keys(fromList).sort()).toEqual(['NZD', 'USD']);
      }
    }
  });

  it('settlements: list and summary agree, and a second currency outside the window is left out', async () => {
    if (!guard()) return;
    const filters = window();
    const list = await settlements.list({ page: 1, pageSize: 100, ...filters });
    expect(list.meta.total).toBe(2);
    expect(list.meta.totalPages).toBe(1);

    const fromList = perCurrency(
      list.data.map((s) => ({ currency: s.currency, amount: s.payableMinor })),
    );
    expect(fromList).toEqual({
      NZD: { count: 1, totalMinor: 50_000 },
      USD: { count: 1, totalMinor: 70_001 },
    });
    expect(await summaryPerCurrency('settlements', filters)).toEqual(fromList);

    // Without the window the late USD settlement on the NZD event comes back, as a third row.
    const unbounded = await settlements.list({
      page: 1,
      pageSize: 100,
      country: 'NZ',
      organizationId: orgA,
    });
    expect(unbounded.meta.total).toBe(3);
  });

  it('every spelling of the market counts, and only that market', async () => {
    if (!guard()) return;
    const nz = await admin.payments({
      page: 1,
      pageSize: 100,
      organizationId: orgA,
      from: FROM,
      to: TO,
      country: 'NZ',
    });
    const au = await admin.payments({
      page: 1,
      pageSize: 100,
      organizationId: orgA,
      from: FROM,
      to: TO,
      country: 'AU',
    });
    expect(nz.meta.total).toBe(6);
    expect(au.meta.total).toBe(3);
    expect(au.data.every((p) => p.currency === 'AUD')).toBe(true);
  });

  it('support: market by the organizer, event through the booking, whole UTC days', async () => {
    if (!guard()) return;
    const base = { page: 1, pageSize: 100 } as const;
    // Both organizers are registered in New Zealand: 3 days x (3 org A events + 1 org B event).
    const market = await support.list({ ...base, country: 'NZ', from: FROM, to: TO } as never);
    const mine = market.data.filter((r) => ids.feedback.includes(r.id));
    expect(mine).toHaveLength(12);

    const oneEvent = await support.list({
      ...base,
      organizationId: orgA,
      eventId: evAud,
      from: FROM,
      to: TO,
    } as never);
    expect(oneEvent.meta.total).toBe(3);

    const unbounded = await support.list({
      ...base,
      organizationId: orgA,
      eventId: evAud,
    } as never);
    expect(unbounded.meta.total).toBe(5);
  });

  it('audit: an event is its own entries plus the ones naming it, and the market drops platform rows', async () => {
    if (!guard()) return;
    const about = await audit.list({ eventId: evNzd, from: FROM, to: TO }, 1, 100);
    // 3 booking entries naming it in metadata, its own EVENT_PUBLISHED, and the platform entry.
    expect(about.meta.total).toBe(5);

    const inMarket = await audit.list(
      { eventId: evNzd, from: FROM, to: TO, country: 'NZ' },
      1,
      100,
    );
    // The platform entry has no organizer, so it is in no market.
    expect(inMarket.meta.total).toBe(4);

    const summary = await audit.summary({ eventId: evNzd, from: FROM, to: TO, country: 'NZ' });
    expect(summary.total).toBe(inMarket.meta.total);
    expect(summary.byOrganization).toEqual([
      expect.objectContaining({ organizationId: orgA, count: 4 }),
    ]);
  });
});
