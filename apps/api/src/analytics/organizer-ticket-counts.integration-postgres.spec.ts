import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Role } from '@eticketsgo/shared-types';
import { AnalyticsService } from './analytics.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import type { RequestUser } from '../common/decorators';

/**
 * integration-real-postgres - the organizer Overview's ticket figures equal the records.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * The Overview showed "Tickets sold 41" and "42 of 48,317 places" in one tile, and the owner
 * asked which was true. Both are, and they count different things, so each is pinned here to a
 * direct count of the rows it claims to summarise:
 *
 *   - "Tickets sold" (`attendance.issued`) = Ticket rows of the organization whose status is
 *     ACTIVE or CHECKED_IN. Not REFUNDED, CANCELLED, VOID or TRANSFERRED. Not another
 *     organization's tickets.
 *   - "Checked in" (`attendance.checkedIn`) = the CHECKED_IN rows among those.
 *   - "Places taken" (`capacity.sold` of `capacity.capacity`) = the SUM of
 *     TicketInventory.quantitySold (and quantityTotal) over the organization's ticket types:
 *     the inventory counter the booking path raises and the refund path lowers.
 *
 * Real Postgres because the figures are aggregates over relation filters, which a mocked
 * Prisma would only echo back. Fixtures are uniquely named and removed afterwards (the
 * database is shared). Skips, never fabricates a pass, with no database.
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

describe('integration-real-postgres: organizer ticket figures reconcile with the records', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let svc: AnalyticsService;

  const tag = `tix-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  let serialN = 0;
  let owner: RequestUser;
  let mineId = '';

  async function makeOrg(label: string) {
    const org = await db!.organization.create({
      data: { name: `${label} ${tag}`, slug: `${label}-${tag}`, status: 'APPROVED' },
    });
    orgIds.push(org.id);
    const venue = await db!.venue.create({
      data: {
        organizationId: org.id,
        name: `Hall ${tag}`,
        city: 'Vijayawada',
        country: 'India',
        timezone: 'Asia/Kolkata',
      },
    });
    const event = await db!.event.create({
      data: {
        organizationId: org.id,
        venueId: venue.id,
        title: `${label} ${tag}`,
        slug: `${label}-${tag}`,
        category: 'Concert',
        status: 'PUBLISHED',
      },
    });
    const startsAt = new Date(Date.now() + 7 * 86_400_000);
    const session = await db!.eventSession.create({
      data: {
        eventId: event.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 7_200_000),
      },
    });
    return { orgId: org.id, eventId: event.id, sessionId: session.id };
  }

  async function makeType(sessionId: string, total: number, sold: number) {
    const t = await db!.ticketType.create({
      data: {
        eventSessionId: sessionId,
        name: `GA ${tag}`,
        priceMinor: 1000,
        quantityTotal: total,
        inventory: { create: { quantityTotal: total, quantitySold: sold } },
      },
    });
    return t.id;
  }

  async function booking(
    org: { orgId: string; eventId: string; sessionId: string },
    ticketTypeId: string,
    statuses: string[],
  ) {
    const b = await db!.booking.create({
      data: {
        organizationId: org.orgId,
        eventId: org.eventId,
        eventSessionId: org.sessionId,
        buyerName: `Buyer ${tag}`,
        buyerEmail: `buyer-${tag}@test.invalid`,
        status: 'CONFIRMED',
        subtotalMinor: 1000 * statuses.length,
        totalMinor: 1000 * statuses.length,
        confirmedAt: new Date(),
        holdExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    for (const status of statuses) {
      await db!.ticket.create({
        data: {
          bookingId: b.id,
          ticketTypeId,
          eventSessionId: org.sessionId,
          organizationId: org.orgId,
          serial: `${tag}-T${++serialN}`,
          nonce: 'n',
          status: status as never,
        },
      });
    }
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
    svc = new AnalyticsService(db as never, new OrgAccessService(db as never), {} as never);

    const u = await db!.user.create({
      data: {
        email: `owner-${tag}@test.invalid`,
        fullName: `Owner ${tag}`,
        passwordHash: 'x',
        roles: ['ORGANIZER_OWNER'],
      },
    });
    userIds.push(u.id);
    owner = { id: u.id, email: u.email, fullName: u.fullName, roles: [Role.ORGANIZER_OWNER] };

    const mine = await makeOrg('mine');
    mineId = mine.orgId;
    await db!.organizationMember.create({
      data: { organizationId: mine.orgId, userId: u.id, role: 'ORGANIZER_OWNER' },
    });
    // Two ticket types, so "places" is a SUM across them and not one row read back.
    const ga = await makeType(mine.sessionId, 100, 5);
    const vip = await makeType(mine.sessionId, 20, 2);
    await booking(mine, ga, ['ACTIVE', 'ACTIVE', 'CHECKED_IN', 'REFUNDED']);
    await booking(mine, ga, ['CANCELLED', 'VOID', 'TRANSFERRED']);
    await booking(mine, vip, ['ACTIVE', 'CHECKED_IN']);

    // Another organization's valid tickets must never be counted.
    const theirs = await makeOrg('theirs');
    const theirType = await makeType(theirs.sessionId, 50, 3);
    await booking(theirs, theirType, ['ACTIVE', 'ACTIVE', 'CHECKED_IN']);
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    const orgFilter = { organizationId: { in: orgIds } };
    await db.ticket.deleteMany({ where: orgFilter });
    await db.booking.deleteMany({ where: orgFilter });
    await db.ticketInventory.deleteMany({
      where: { ticketType: { eventSession: { event: orgFilter } } },
    });
    await db.ticketType.deleteMany({ where: { eventSession: { event: orgFilter } } });
    await db.eventSession.deleteMany({ where: { event: orgFilter } });
    await db.event.deleteMany({ where: orgFilter });
    await db.venue.deleteMany({ where: orgFilter });
    await db.organizationMember.deleteMany({ where: orgFilter });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
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
      120_000,
    );

  maybe(
    '"Tickets sold" is exactly the ACTIVE and CHECKED_IN tickets of this organization',
    async () => {
      const a = await svc.organizer(owner, mineId);
      const direct = await db!.ticket.count({
        where: { organizationId: mineId, status: { in: ['ACTIVE', 'CHECKED_IN'] } },
      });
      expect(direct).toBe(5);
      expect(a.attendance.issued).toBe(direct);
    },
  );

  maybe('"Checked in" is exactly the CHECKED_IN tickets among them', async () => {
    const a = await svc.organizer(owner, mineId);
    const direct = await db!.ticket.count({
      where: { organizationId: mineId, status: 'CHECKED_IN' },
    });
    expect(direct).toBe(2);
    expect(a.attendance.checkedIn).toBe(direct);
  });

  maybe('"Places taken" is the inventory counter summed over this organization only', async () => {
    const a = await svc.organizer(owner, mineId);
    const inv = await db!.ticketInventory.aggregate({
      where: { ticketType: { eventSession: { event: { organizationId: mineId } } } },
      _sum: { quantitySold: true, quantityTotal: true },
    });
    expect(inv._sum.quantitySold).toBe(7);
    expect(inv._sum.quantityTotal).toBe(120);
    expect(a.capacity.sold).toBe(inv._sum.quantitySold);
    expect(a.capacity.capacity).toBe(inv._sum.quantityTotal);
  });

  maybe('the two figures can differ, and that is not a counting error', async () => {
    // Here the fixture's counter (7) is above the valid tickets (5), as on QA (42 vs 41): a
    // counter and a set of rows are two records, and the tile now names both.
    const a = await svc.organizer(owner, mineId);
    expect(a.capacity.sold).not.toBe(a.attendance.issued);
  });
});
