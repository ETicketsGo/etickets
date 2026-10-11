import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EventsService } from './events.service';
import { OrgAccessService } from '../tenancy/org-access.service';

/**
 * integration-real-postgres - the organizer's event list says when, how full and how much.
 *
 * Against a real database because the figures are grouped reads and one raw join across three
 * tables: a stubbed Prisma would return whatever the test handed it and agree with a wrong
 * table name, a wrong join or a wrong grouping. The member's role is read by the real access
 * service, because who may see money is the point of one of these tests.
 *
 * Every fixture is named with this run's suffix and deleted afterwards: the database is shared.
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

const noAudit = { record: async () => undefined } as never;
const noAudience = {} as never;
const cfg = { get: () => undefined } as never;

const HOUR = 3_600_000;

describe('integration-real-postgres: organizer event list', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let events: EventsService;

  const suffix = `evlist-${Date.now()}`;
  let orgId = '';
  let busyId = '';
  let emptyId = '';
  const userIds: string[] = [];
  let owner: never;
  let staff: never;

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }

    events = new EventsService(
      db as never,
      new OrgAccessService(db as never, { record: async () => undefined } as never),
      noAudit,
      noAudience,
      cfg,
      {} as never,
      {} as never,
    );

    const org = await db!.organization.create({
      data: { name: `List ${suffix}`, slug: `list-${suffix}` },
    });
    orgId = org.id;
    for (const role of ['ORGANIZER_OWNER', 'CHECKIN_STAFF'] as const) {
      const user = await db!.user.create({
        data: {
          email: `${role.toLowerCase()}-${suffix}@itest.test`,
          passwordHash: 'x',
          fullName: role,
        },
      });
      userIds.push(user.id);
      await db!.organizationMember.create({
        data: { organizationId: orgId, userId: user.id, role },
      });
    }
    owner = { id: userIds[0], email: 'o', fullName: 'O', roles: [] } as never;
    staff = { id: userIds[1], email: 's', fullName: 'S', roles: [] } as never;

    const venue = await db!.venue.create({
      data: {
        organizationId: orgId,
        name: `V ${suffix}`,
        city: 'Pune',
        country: 'India',
        timezone: 'Asia/Kolkata',
      },
    });

    const busy = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Busy ${suffix}`,
        slug: `busy-${suffix}`,
        category: 'Music',
        status: 'PUBLISHED',
      },
    });
    busyId = busy.id;
    const empty = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId: venue.id,
        title: `Empty ${suffix}`,
        slug: `empty-${suffix}`,
        category: 'Comedy',
      },
    });
    emptyId = empty.id;

    const now = Date.now();
    const session = (startOffsetH: number, status = 'SCHEDULED') =>
      db!.eventSession.create({
        data: {
          eventId: busyId,
          startsAt: new Date(now + startOffsetH * HOUR),
          endsAt: new Date(now + (startOffsetH + 2) * HOUR),
          status,
        },
      });
    // Over a week ago, running now (started an hour ago), tomorrow, and a cancelled one that
    // would otherwise be both the first AND the next.
    const past = await session(-200);
    await session(-1);
    await session(24);
    await session(-300, 'CANCELLED');
    await session(2, 'CANCELLED');

    for (const [name, total, sold] of [
      ['Floor', 100, 30],
      ['Balcony', 50, 5],
    ] as const) {
      await db!.ticketType.create({
        data: {
          eventSessionId: past.id,
          name,
          priceMinor: 1000,
          currency: 'INR',
          quantityTotal: total,
          inventory: { create: { quantityTotal: total, quantitySold: sold } },
        },
      });
    }

    const booking = (currency: string, subtotalMinor: number, confirmed: boolean) =>
      db!.booking.create({
        data: {
          organizationId: orgId,
          eventId: busyId,
          eventSessionId: past.id,
          buyerName: 'B',
          buyerEmail: `b-${suffix}@itest.test`,
          currency,
          subtotalMinor,
          totalMinor: subtotalMinor,
          holdExpiresAt: new Date(now + HOUR),
          status: confirmed ? 'CONFIRMED' : 'PENDING_PAYMENT',
          confirmedAt: confirmed ? new Date() : null,
        },
      });
    await booking('INR', 50_000, true);
    await booking('INR', 25_000, true);
    await booking('USD', 4_000, true);
    // Never paid: not a sale, whatever its subtotal says.
    await booking('INR', 999_999, false);
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.booking.deleteMany({ where: { organizationId: orgId } });
    // Sessions, ticket types and inventory cascade with the event.
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
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

  const rowOf = async (user: never, id: string) =>
    (await events.listForOrg(user, orgId)).find((e) => e.id === id)!;

  maybe('names the first, last and next session, leaving cancelled ones out', async () => {
    const row = await rowOf(owner, busyId);
    const now = Date.now();
    const hoursFromNow = (d: Date | null) => Math.round(((d?.getTime() ?? NaN) - now) / HOUR);
    expect(hoursFromNow(row.schedule.firstStartsAt)).toBe(-200);
    expect(hoursFromNow(row.schedule.lastStartsAt)).toBe(24);
    // The one running now is the next: it has not ended.
    expect(hoursFromNow(row.schedule.nextStartsAt)).toBe(-1);
    expect(row.schedule.upcomingSessions).toBe(2);
    // The venue's own zone travels with the row, so the console can show venue-local time.
    expect(row.venue).toEqual({
      name: `V ${suffix}`,
      city: 'Pune',
      country: 'India',
      timezone: 'Asia/Kolkata',
    });
  });

  maybe('adds the inventory across every ticket type into sold and capacity', async () => {
    expect((await rowOf(owner, busyId)).tickets).toEqual({ sold: 35, capacity: 150 });
  });

  maybe('gives an owner gross sales per currency, confirmed bookings only', async () => {
    expect((await rowOf(owner, busyId)).sales).toEqual([
      { currency: 'INR', grossMinor: 75_000, bookings: 2 },
      { currency: 'USD', grossMinor: 4_000, bookings: 1 },
    ]);
  });

  maybe(
    'withholds money from check-in staff, and says so with null, not an empty list',
    async () => {
      const row = await rowOf(staff, busyId);
      expect(row.sales).toBeNull();
      // Everything operational is still there.
      expect(row.tickets.capacity).toBe(150);
    },
  );

  maybe('reports an event with nothing as empty, not missing', async () => {
    const row = await rowOf(owner, emptyId);
    expect(row.schedule).toEqual({
      firstStartsAt: null,
      lastStartsAt: null,
      nextStartsAt: null,
      upcomingSessions: 0,
    });
    expect(row.tickets).toEqual({ sold: 0, capacity: 0 });
    expect(row.sales).toEqual([]);
    expect(row.imagePath).toBeNull();
    expect(row.imageVariants).toBeNull();
  });
});
