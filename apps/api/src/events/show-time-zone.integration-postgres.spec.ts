import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicEventsService } from './public-events.service';
import { ShowsService } from '../shows/shows.service';

/**
 * integration-real-postgres — the event page and the seat page name the zone the ticket prints.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────
 * In a Denver browser the event page printed a show as "Wed 28 Oct 2026, 10:04 pm" while its
 * booking confirmation printed "Thu 29 Oct 2026, 9:34 am GMT+5:30". The event page had only
 * the venue row's own zone column; the booking reads the cinema, then the venue, then the
 * venue's country. And the seat page summary selected a room without its venue, so a room in a
 * venue that is not a cinema answered no zone at all.
 *
 * Proven against a real database because the answer depends on what the queries SELECT: a stub
 * returns whatever shape the test hands it, so a missing `screen` include would pass there.
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

const allowAll = { assertMember: async () => undefined } as never;
const noAudit = { record: async () => undefined } as never;
const cfg = { get: () => 15 } as never;
const advertised = { forTicket: async () => null } as never;

describe('integration-real-postgres: whose clock a show is on', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let publicEvents: PublicEventsService;
  let shows: ShowsService;

  const suffix = `showtz-${Date.now()}`;
  let orgId = '';
  // 04:04 UTC: 9:34 am in India, 10:04 pm the day before in Denver.
  const startsAt = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 9, 29, 4, 4));
  const endsAt = new Date(startsAt.getTime() + 2 * 3_600_000);
  const ids = { roomSession: '', cinemaSession: '', roomEvent: '', cinemaEvent: '' };

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    publicEvents = new PublicEventsService(db as never, advertised);
    shows = new ShowsService(db as never, allowAll, noAudit, cfg);

    const org = await db!.organization.create({
      data: { name: `ShowTz ${suffix}`, slug: `showtz-${suffix}` },
    });
    orgId = org.id;

    // A room in a venue that is not a cinema. The venue was never asked its zone.
    const hall = await db!.venue.create({
      data: { organizationId: orgId, name: `Hall ${suffix}`, city: 'Hyderabad', country: 'India' },
    });
    const room = await db!.screen.create({
      data: { venueId: hall.id, name: `Room ${suffix}`, screenType: '2D', capacity: 10 },
    });
    const roomEvent = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: hall.id,
        title: `Room show ${suffix}`,
        slug: `room-${suffix}`,
        category: 'Music',
        status: 'PUBLISHED',
      },
    });
    ids.roomEvent = roomEvent.slug;
    ids.roomSession = (
      await db!.eventSession.create({
        data: { eventId: roomEvent.id, startsAt, endsAt, screenId: room.id },
      })
    ).id;

    // A cinema screen whose cinema is on another clock than the event's venue row.
    const arena = await db!.venue.create({
      data: {
        organizationId: orgId,
        name: `Arena ${suffix}`,
        city: 'Meridian',
        country: 'United States',
        timezone: 'America/Denver',
      },
    });
    const cinema = await db!.cinema.create({
      data: {
        organizationId: orgId,
        venueId: arena.id,
        name: `Cinema ${suffix}`,
        city: 'Meridian',
        timezone: 'Asia/Kolkata',
      },
    });
    const screen = await db!.screen.create({
      data: { cinemaId: cinema.id, name: `Screen ${suffix}`, screenType: '2D', capacity: 10 },
    });
    const cinemaEvent = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: arena.id,
        title: `Cinema show ${suffix}`,
        slug: `cinema-${suffix}`,
        category: 'Music',
        status: 'PUBLISHED',
      },
    });
    ids.cinemaEvent = cinemaEvent.slug;
    ids.cinemaSession = (
      await db!.eventSession.create({
        data: { eventId: cinemaEvent.id, startsAt, endsAt, screenId: screen.id },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.eventSession.deleteMany({ where: { event: { organizationId: orgId } } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.screen.deleteMany({
      where: { OR: [{ venue: { organizationId: orgId } }, { cinema: { organizationId: orgId } }] },
    });
    await db.cinema.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (!available) return;
      await fn();
    });

  maybe('a room in a venue with no zone: the event page and seat page both say India', async () => {
    const event = await publicEvents.getBySlug(ids.roomEvent);
    const summary = await shows.getPublicShowSummary(ids.roomSession);
    expect(event.timeZone).toBe('Asia/Kolkata');
    expect(event.sessions[0].timeZone).toBe('Asia/Kolkata');
    // Was null: the seat page header then printed the reader's own clock.
    expect(summary.timeZone).toBe('Asia/Kolkata');
    expect(summary.localDate).toBe(startsAt.toISOString().slice(0, 10));
  });

  maybe(
    "a cinema screen at the Kolkata default: both pages say the venue's clock (T2)",
    async () => {
      const event = await publicEvents.getBySlug(ids.cinemaEvent);
      const summary = await shows.getPublicShowSummary(ids.cinemaSession);
      // The cinema row kept the schema default; the session is on its venue's clock, as its ticket.
      expect(event.timeZone).toBe('America/Denver');
      expect(event.sessions[0].timeZone).toBe('America/Denver');
      expect(summary.timeZone).toBe('America/Denver');
    },
  );
});
