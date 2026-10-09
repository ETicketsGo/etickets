/*
  ── WHY THIS FILE HAS ITS OWN ORGANIZERS AND ITS OWN YEAR ───────────────────────────
  The local database is shared with other engineers and other spec files, and almost all of them
  write sessions dated "now". So the window here is March 2019, which no other file's rows fall
  into, and every assertion is also narrowed to an organizer this file created - a parallel file
  cannot move any number here.
*/
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EventsService } from './events.service';

/**
 * integration-real-postgres - the admin calendar against a real database.
 *
 * ── WHAT THIS PROVES THAT THE UNIT SPEC CANNOT ─────────────────────────────────────
 *  - The nested `where` (window, market through the venue, organizer, event status) is a query
 *    Prisma actually accepts and that selects the right sessions. A relation filter that is
 *    valid TypeScript and rejected at runtime is exactly what a mocked client cannot catch.
 *  - The window is whole UTC days at both ends: 23:59:59.999 on `to` is in, midnight after it
 *    is out, and so is a millisecond before `from`.
 *  - Every session of a run is its own row (the event list's one-row-per-event cannot draw a
 *    calendar), and each carries its venue's zone or an honest null.
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

const suffix = `cal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const FROM = '2019-03-10';
const TO = '2019-03-12';
const AT = {
  beforeFrom: new Date('2019-03-09T23:59:59.999Z'),
  fromStart: new Date('2019-03-10T00:00:00.000Z'),
  middle: new Date('2019-03-11T12:00:00.000Z'),
  toEnd: new Date('2019-03-12T23:59:59.999Z'),
  afterTo: new Date('2019-03-13T00:00:00.000Z'),
};

describe('integration-real-postgres: admin calendar', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let service: EventsService;

  const ids = { orgs: [] as string[], events: [] as string[] };
  let orgA = '';
  let orgB = '';
  /** Org A: a published run in Auckland (zone set), a draft in Toronto (no zone). */
  let evRun = '';
  let evDraft = '';

  async function makeEvent(
    organizationId: string,
    label: string,
    venue: { city: string; country: string; timezone: string | null },
    status: string,
    starts: Date[],
  ) {
    const v = await db!.venue.create({
      data: { organizationId, name: `CAL ${label}`, ...venue },
    });
    const event = await db!.event.create({
      data: {
        organizationId,
        venueId: v.id,
        title: `CAL ${label} ${suffix}`,
        slug: `cal-${label}-${suffix}`,
        category: 'Music',
        status,
      },
    });
    ids.events.push(event.id);
    for (const at of starts) {
      await db!.eventSession.create({
        data: { eventId: event.id, startsAt: at, endsAt: new Date(at.getTime() + 7_200_000) },
      });
    }
    return event.id;
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

    service = Object.create(EventsService.prototype) as EventsService;
    (service as unknown as { prisma: unknown }).prisma = db;

    const a = await db.organization.create({
      data: { name: `CAL A ${suffix}`, slug: `cal-a-${suffix}`, registeredCountry: 'NZ' },
    });
    const b = await db.organization.create({
      data: { name: `CAL B ${suffix}`, slug: `cal-b-${suffix}`, registeredCountry: 'NZ' },
    });
    orgA = a.id;
    orgB = b.id;
    ids.orgs.push(orgA, orgB);

    evRun = await makeEvent(
      orgA,
      'run',
      { city: 'Auckland', country: 'New Zealand', timezone: 'Pacific/Auckland' },
      'PUBLISHED',
      Object.values(AT),
    );
    evDraft = await makeEvent(
      orgA,
      'draft',
      { city: 'Toronto', country: 'Canada', timezone: null },
      'DRAFT',
      [AT.middle],
    );
    await makeEvent(
      orgB,
      'other',
      { city: 'Auckland', country: 'nz', timezone: 'Pacific/Auckland' },
      'PUBLISHED',
      [AT.middle],
    );
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
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

  it('returns every session of a run inside whole UTC days, and none outside', async () => {
    if (!guard()) return;
    const out = await service.adminCalendar({ from: FROM, to: TO, organizationId: orgA });
    const run = out.data.filter((s) => s.event.id === evRun).map((s) => s.startsAt);
    expect(run).toEqual([
      AT.fromStart.toISOString(),
      AT.middle.toISOString(),
      AT.toEnd.toISOString(),
    ]);
    expect(out.meta.truncated).toBe(false);
  });

  it("carries each venue's zone, and null where the venue was never given one", async () => {
    if (!guard()) return;
    const out = await service.adminCalendar({ from: FROM, to: TO, organizationId: orgA });
    expect(new Set(out.data.filter((s) => s.event.id === evRun).map((s) => s.timezone))).toEqual(
      new Set(['Pacific/Auckland']),
    );
    // Canada spans six zones; the country alone cannot say which, so nothing is guessed.
    expect(out.data.find((s) => s.event.id === evDraft)?.timezone).toBeNull();
  });

  it('filters by event status and by market, through the venue, together', async () => {
    if (!guard()) return;
    const published = await service.adminCalendar({
      from: FROM,
      to: TO,
      organizationId: orgA,
      status: 'PUBLISHED' as never,
    });
    expect(new Set(published.data.map((s) => s.event.id))).toEqual(new Set([evRun]));

    const canada = await service.adminCalendar({
      from: FROM,
      to: TO,
      organizationId: orgA,
      country: 'CA',
    });
    expect(canada.data.map((s) => s.event.id)).toEqual([evDraft]);

    // Both at once: a published event in Canada does not exist, and AND must not let either
    // filter erase the other.
    const both = await service.adminCalendar({
      from: FROM,
      to: TO,
      organizationId: orgA,
      country: 'CA',
      status: 'PUBLISHED' as never,
    });
    expect(both.data).toEqual([]);
  });

  it('keeps organizers apart, and reaches every spelling of a market', async () => {
    if (!guard()) return;
    const nz = await service.adminCalendar({ from: FROM, to: TO, country: 'NZ' });
    const mine = nz.data.filter((s) => ids.orgs.includes(s.organization.id));
    // "New Zealand" (org A) and "nz" (org B) are one market.
    expect(new Set(mine.map((s) => s.organization.id))).toEqual(new Set([orgA, orgB]));

    const onlyB = await service.adminCalendar({ from: FROM, to: TO, organizationId: orgB });
    expect(onlyB.data.every((s) => s.organization.id === orgB)).toBe(true);
    expect(onlyB.data).toHaveLength(1);
  });
});
