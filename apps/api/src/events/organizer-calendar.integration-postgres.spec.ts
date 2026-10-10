import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Role } from '@eticketsgo/shared-types';
import { OrgAccessService } from '../tenancy/org-access.service';
import { OrganizerCalendarService } from './organizer-calendar.service';
import type { RequestUser } from '../common/decorators';

/**
 * integration-real-postgres - the organizer calendar's window query.
 *
 * ── WHY A REAL DATABASE ─────────────────────────────────────────────────────────────
 * What this endpoint promises is a WHERE clause: every session touching the window (including
 * one that began before it and is still running), nothing outside it, nothing from another
 * organization, nothing archived. A mocked Prisma would only echo back the rows the test
 * handed it and prove none of that. Fixtures are this spec's own, uniquely named, and removed
 * afterwards - the database is shared. Skips (never fabricates a pass) with no database.
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

describe('integration-real-postgres: organizer calendar window', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let calendar: OrganizerCalendarService;
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  let orgId = '';
  let owner: RequestUser;
  let staff: RequestUser;

  const at = (iso: string) => new Date(iso);

  async function event(
    organizationId: string,
    venueId: string,
    title: string,
    status: string,
    sessions: [string, string][],
  ) {
    const e = await db!.event.create({
      data: {
        organizationId,
        venueId,
        title: `${title} ${suffix}`,
        slug: `cal-${title.toLowerCase().replace(/\W+/g, '-')}-${suffix}`,
        category: 'Music',
        status,
      },
    });
    for (const [startsAt, endsAt] of sessions) {
      await db!.eventSession.create({
        data: { eventId: e.id, startsAt: at(startsAt), endsAt: at(endsAt) },
      });
    }
    return e;
  }

  async function user(label: string): Promise<RequestUser> {
    const u = await db!.user.create({
      data: {
        email: `calendar-${label}-${suffix}@e2e.test`,
        passwordHash: 'x',
        fullName: `Calendar ${label}`,
      },
    });
    userIds.push(u.id);
    return { id: u.id, email: u.email, fullName: u.fullName, roles: [Role.CUSTOMER] };
  }

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
    calendar = new OrganizerCalendarService(
      db as never,
      new OrgAccessService(db as never, { record: async () => undefined } as never),
    );

    const org = await db!.organization.create({
      data: { name: `Calendar ${suffix}`, slug: `calendar-${suffix}` },
    });
    orgId = org.id;
    orgIds.push(org.id);
    const venue = await db!.venue.create({
      data: {
        organizationId: orgId,
        name: `Hall ${suffix}`,
        city: 'Hyderabad',
        country: 'India',
      },
    });

    owner = await user('owner');
    staff = await user('staff');
    await db!.organizationMember.create({
      data: { organizationId: orgId, userId: owner.id, role: Role.ORGANIZER_OWNER },
    });
    await db!.organizationMember.create({
      data: { organizationId: orgId, userId: staff.id, role: Role.CHECKIN_STAFF },
    });

    const concert = await event(orgId, venue.id, 'Inside', 'PUBLISHED', [
      ['2030-03-10T13:30:00Z', '2030-03-10T16:30:00Z'],
    ]);
    // Ticket totals are summed over the session's ticket types.
    const [session] = await db!.eventSession.findMany({ where: { eventId: concert.id } });
    for (const [total, sold] of [
      [100, 12],
      [50, 3],
    ]) {
      const t = await db!.ticketType.create({
        data: {
          eventSessionId: session.id,
          name: `T${total}`,
          priceMinor: 1000,
          quantityTotal: total,
        },
      });
      await db!.ticketInventory.create({
        data: { ticketTypeId: t.id, quantityTotal: total, quantitySold: sold },
      });
    }
    // Began before the window, still running inside it.
    await event(orgId, venue.id, 'Festival', 'UNDER_REVIEW', [
      ['2030-03-05T10:00:00Z', '2030-03-12T10:00:00Z'],
    ]);
    // Entirely before, entirely after, and ending exactly where the window starts.
    await event(orgId, venue.id, 'Outside', 'PUBLISHED', [
      ['2030-02-01T10:00:00Z', '2030-02-01T12:00:00Z'],
      ['2030-04-20T10:00:00Z', '2030-04-20T12:00:00Z'],
      ['2030-03-07T22:00:00Z', '2030-03-08T00:00:00Z'],
    ]);
    await event(orgId, venue.id, 'Archived', 'ARCHIVED', [
      ['2030-03-10T10:00:00Z', '2030-03-10T12:00:00Z'],
    ]);

    // Another organization's session in the same window must never appear.
    const other = await db!.organization.create({
      data: { name: `Other calendar ${suffix}`, slug: `other-calendar-${suffix}` },
    });
    orgIds.push(other.id);
    const otherVenue = await db!.venue.create({
      data: { organizationId: other.id, name: `Theirs ${suffix}`, city: 'Pune', country: 'India' },
    });
    await event(other.id, otherVenue.id, 'Theirs', 'PUBLISHED', [
      ['2030-03-10T13:30:00Z', '2030-03-10T16:30:00Z'],
    ]);
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    const where = { event: { organizationId: { in: orgIds } } };
    await db.ticketInventory.deleteMany({ where: { ticketType: { eventSession: where } } });
    await db.ticketType.deleteMany({ where: { eventSession: where } });
    await db.eventSession.deleteMany({ where });
    await db.event.deleteMany({ where: { organizationId: { in: orgIds } } });
    await db.venue.deleteMany({ where: { organizationId: { in: orgIds } } });
    await db.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (!available) return;
      await fn();
    });

  maybe('returns every session touching the window, and nothing else', async () => {
    const res = await calendar.sessions(
      owner,
      orgId,
      at('2030-03-08T00:00:00Z'),
      at('2030-04-01T00:00:00Z'),
    );
    const titles = res.sessions.map((s) => s.event.title.replace(` ${suffix}`, ''));
    expect(titles).toEqual(['Festival', 'Inside']);
    expect(res.truncated).toBe(false);

    const inside = res.sessions.find((s) => s.event.title.startsWith('Inside'))!;
    expect(inside.sold).toBe(15);
    expect(inside.capacity).toBe(150);
    expect(inside.venue.city).toBe('Hyderabad');
    expect(inside.venue.country).toBe('India');
    expect(inside.cinemaTimezone).toBeNull();
    const festival = res.sessions.find((s) => s.event.title.startsWith('Festival'))!;
    expect(festival.sold).toBeNull();
    expect(festival.event.status).toBe('UNDER_REVIEW');
  });

  maybe('refuses check-in staff, as the event-detail read does', async () => {
    await expect(
      calendar.sessions(staff, orgId, at('2030-03-08T00:00:00Z'), at('2030-04-01T00:00:00Z')),
    ).rejects.toMatchObject({ status: 403 });
  });

  maybe('refuses a window that is backwards or longer than the limit', async () => {
    await expect(
      calendar.sessions(owner, orgId, at('2030-04-01T00:00:00Z'), at('2030-03-01T00:00:00Z')),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      calendar.sessions(owner, orgId, at('2030-01-01T00:00:00Z'), at('2030-04-01T00:00:00Z')),
    ).rejects.toMatchObject({ status: 400 });
  });
});
