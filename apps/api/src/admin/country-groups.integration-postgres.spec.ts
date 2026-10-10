import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AdminService } from './admin.service';
import { AdminGroupingService } from './admin-grouping.service';

/**
 * integration-real-postgres - a country group is a market, on a real database.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * The owner: "Bookings and payments display USA and United States as separate country groups."
 * `Venue.country` is free text from before the venue form had a country list, so one market is
 * stored as "US", "USA", "United States", "United States of America" and "u.s.a.". The grouped
 * summary grouped by the stored text, so each spelling was its own chip with its own slice of
 * the money, and none of them was the market.
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────────────
 *  - Every spelling the market table lists lands in ONE group, keyed by the ISO code and labelled
 *    with the market's name, on the bookings and the payments summaries.
 *  - A value the table does not list is its own group, "Unknown (<value>)", and is never merged
 *    into a market - even when it is sold in the same currency as one.
 *  - Clicking a group gives a list whose total and per-currency money are EXACTLY the group's,
 *    through the real list services, and the groups add up to the unscoped list.
 *  - The country filter (an ISO code) selects the same rows as the market's group.
 *  - Nothing stored changes: the venues still hold what was typed.
 *
 * Isolated by a per-run suffix in every buyer email and searched by it, so the shared database's
 * other rows (and parallel spec files) cannot move a number here. Every row is created here and
 * deleted after. Skips (never fabricates a pass) when no database is reachable.
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

const suffix = `cg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Each stored spelling, the market it must land in (null = unknown) and what it sells in. */
const SPELLINGS: { stored: string; market: string | null; currency: string }[] = [
  { stored: 'US', market: 'US', currency: 'USD' },
  { stored: 'USA', market: 'US', currency: 'USD' },
  { stored: 'United States', market: 'US', currency: 'USD' },
  { stored: 'United States of America', market: 'US', currency: 'USD' },
  { stored: 'u.s.a.', market: 'US', currency: 'USD' },
  { stored: 'India', market: 'IN', currency: 'INR' },
  { stored: 'IN', market: 'IN', currency: 'INR' },
  { stored: 'india', market: 'IN', currency: 'INR' },
  { stored: 'UK', market: 'GB', currency: 'GBP' },
  { stored: 'United Kingdom', market: 'GB', currency: 'GBP' },
  { stored: 'GB', market: 'GB', currency: 'GBP' },
  { stored: 'Canada', market: 'CA', currency: 'CAD' },
  { stored: 'CA', market: 'CA', currency: 'CAD' },
  // Not a market. Sold in dollars on purpose: it must still not be folded into the US.
  { stored: 'Atlantis', market: null, currency: 'USD' },
];

const LABELS: Record<string, string> = {
  US: 'United States',
  IN: 'India',
  GB: 'United Kingdom',
  CA: 'Canada',
  Atlantis: 'Unknown (Atlantis)',
};

/** The group key a spelling must land under: its market's code, else its own text. */
const keyOf = (s: (typeof SPELLINGS)[number]) => s.market ?? s.stored;

describe('integration-real-postgres: a country group is a market', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let admin: AdminService;
  let grouping: AdminGroupingService;

  let orgId = '';
  const venueIds: string[] = [];
  const eventIds: string[] = [];
  const bookingIds: string[] = [];

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
    admin = new AdminService(db as never, {} as never);
    grouping = new AdminGroupingService(db as never);

    const org = await db.organization.create({
      data: { name: `CG ${suffix}`, slug: `cg-${suffix}`, registeredCountry: 'IN' },
    });
    orgId = org.id;

    let seq = 0;
    for (const s of SPELLINGS) {
      seq += 1;
      const venue = await db.venue.create({
        data: { organizationId: orgId, name: `CG ${seq}`, city: 'Somewhere', country: s.stored },
      });
      venueIds.push(venue.id);
      const event = await db.event.create({
        data: {
          organizationId: orgId,
          venueId: venue.id,
          title: `CG ${seq} ${suffix}`,
          slug: `cg-${seq}-${suffix}`,
          category: 'Music',
          status: 'PUBLISHED',
        },
      });
      eventIds.push(event.id);
      const now = Date.now();
      const session = await db.eventSession.create({
        data: {
          eventId: event.id,
          startsAt: new Date(now + 86_400_000),
          endsAt: new Date(now + 90_000_000),
        },
      });
      // Amounts differ per row, so a total that dropped or doubled one cannot match by accident.
      const amount = 1_000 + seq * 7;
      const booking = await db.booking.create({
        data: {
          organizationId: orgId,
          eventId: event.id,
          eventSessionId: session.id,
          buyerName: 'CG Buyer',
          buyerEmail: `cg-${seq}-${suffix}@example.test`,
          status: 'CONFIRMED',
          currency: s.currency,
          subtotalMinor: amount,
          totalMinor: amount,
          holdExpiresAt: new Date(now),
        },
      });
      bookingIds.push(booking.id);
      await db.payment.create({
        data: {
          bookingId: booking.id,
          provider: 'mock',
          status: 'SUCCEEDED',
          amountMinor: amount + 3,
          currency: s.currency,
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.payment.deleteMany({ where: { bookingId: { in: bookingIds } } }).catch(() => {});
    await db.booking.deleteMany({ where: { id: { in: bookingIds } } }).catch(() => {});
    await db.eventSession.deleteMany({ where: { eventId: { in: eventIds } } }).catch(() => {});
    await db.event.deleteMany({ where: { id: { in: eventIds } } }).catch(() => {});
    await db.venue.deleteMany({ where: { id: { in: venueIds } } }).catch(() => {});
    await db.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
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

  /** Money per currency from listed rows, sorted, in the summary's shape. */
  function totalsOf(rows: { currency: string; amount: number }[]) {
    const out: Record<string, number> = {};
    for (const r of rows) out[r.currency] = (out[r.currency] ?? 0) + r.amount;
    return Object.entries(out)
      .map(([currency, totalMinor]) => ({ currency, totalMinor }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  }

  /** What each group should hold, worked out from the fixture table alone. */
  function expectedGroups(amountFor: (index: number) => number) {
    const out: Record<
      string,
      { label: string; count: number; rows: { currency: string; amount: number }[] }
    > = {};
    SPELLINGS.forEach((s, i) => {
      const key = keyOf(s);
      out[key] ??= { label: LABELS[key], count: 0, rows: [] };
      out[key].count += 1;
      out[key].rows.push({ currency: s.currency, amount: amountFor(i + 1) });
    });
    return Object.fromEntries(
      Object.entries(out).map(([key, g]) => [
        key,
        { label: g.label, count: g.count, totals: totalsOf(g.rows) },
      ]),
    );
  }

  /** The two queues under test, each as its summary filter and its real list. */
  const QUEUES = {
    bookings: {
      filters: () => ({ q: suffix }),
      list: async (extra: Record<string, string | undefined>) => {
        const res = await admin.bookings({ page: 1, pageSize: 100, q: suffix, ...extra });
        return {
          total: res.meta.total,
          rows: res.data.map((b) => ({ currency: b.currency, amount: b.totalMinor })),
        };
      },
      amount: (seq: number) => 1_000 + seq * 7,
    },
    payments: {
      filters: () => ({ q: suffix, organizationId: orgId }),
      list: async (extra: Record<string, string | undefined>) => {
        const res = await admin.payments({
          page: 1,
          pageSize: 100,
          q: suffix,
          organizationId: orgId,
          ...extra,
        });
        return {
          total: res.meta.total,
          rows: res.data.map((p) => ({ currency: p.currency, amount: p.amountMinor })),
        };
      },
      amount: (seq: number) => 1_000 + seq * 7 + 3,
    },
  } as const;

  for (const [resource, queue] of Object.entries(QUEUES)) {
    it(`${resource}: every spelling of a market is one group, named for the market`, async () => {
      if (!guard()) return;
      const summary = await grouping.grouped(resource, 'country', queue.filters());
      const got = Object.fromEntries(
        summary.groups.map((g) => [g.key, { label: g.label, count: g.count, totals: g.totals }]),
      );
      expect(got).toEqual(expectedGroups(queue.amount));
    });

    it(`${resource}: each group's list holds exactly the group's rows and money`, async () => {
      if (!guard()) return;
      const summary = await grouping.grouped(resource, 'country', queue.filters());
      expect(summary.groups.length).toBe(5);
      for (const g of summary.groups) {
        const listed = await queue.list({ groupBy: 'country', groupKey: g.key ?? undefined });
        // Described pairs: jest's expect takes no message, so the group goes in the value.
        expect({ group: g.label, count: listed.total, totals: totalsOf(listed.rows) }).toEqual({
          group: g.label,
          count: g.count,
          totals: g.totals,
        });
      }
    });

    it(`${resource}: the groups add up to the whole list`, async () => {
      if (!guard()) return;
      const summary = await grouping.grouped(resource, 'country', queue.filters());
      const whole = await queue.list({});
      expect(summary.groups.reduce((n, g) => n + g.count, 0)).toBe(whole.total);
      expect(whole.total).toBe(SPELLINGS.length);
    });

    it(`${resource}: the country filter selects the market's group, unknown values left out`, async () => {
      if (!guard()) return;
      for (const code of ['US', 'IN', 'GB', 'CA']) {
        const filtered = await queue.list({ country: code });
        const summary = await grouping.grouped(resource, 'country', {
          ...queue.filters(),
          country: code,
        });
        const expected = SPELLINGS.filter((s) => s.market === code).length;
        expect({
          code,
          listed: filtered.total,
          groups: summary.groups.map((g) => [g.key, g.count]),
        }).toEqual({ code, listed: expected, groups: [[code, expected]] });
      }
    });
  }

  it('reads a key that is a stored spelling as its market, for links made before', async () => {
    if (!guard()) return;
    const listed = await QUEUES.bookings.list({ groupBy: 'country', groupKey: 'United States' });
    expect(listed.total).toBe(SPELLINGS.filter((s) => s.market === 'US').length);
  });

  it('does not change what was stored', async () => {
    if (!guard()) return;
    const venues = await db!.venue.findMany({
      where: { id: { in: venueIds } },
      select: { id: true, country: true },
    });
    const byId = new Map(venues.map((v: { id: string; country: string }) => [v.id, v.country]));
    expect(venueIds.map((id) => byId.get(id))).toEqual(SPELLINGS.map((s) => s.stored));
  });
});
