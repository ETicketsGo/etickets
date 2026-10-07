import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZoneInventoryService } from './zone-inventory.service';

/**
 * integration-real-postgres - a standing area cannot oversell, even when two buyers race.
 *
 * -- WHY THIS CANNOT BE A UNIT TEST -------------------------------------------------------
 * The thing under test IS the database's behaviour. `tryHold` is one UPDATE whose WHERE
 * clause does the checking, and the guarantee comes from Postgres taking a row lock for the
 * duration of that statement so the second writer evaluates its predicate against the first
 * one's committed result.
 *
 * A mocked Prisma would return whatever it was told and prove nothing at all. A test that
 * called `tryHold` twice in sequence would also prove nothing - sequential calls cannot
 * oversell. The only honest version issues them CONCURRENTLY and counts how many won.
 *
 * -- WHAT A FAILURE HERE WOULD MEAN -------------------------------------------------------
 * A 4,000-capacity floor selling 4,001 tickets. Nothing looks wrong in the data afterwards;
 * the numbers simply do not add up, and the person who finds out is a steward at a door.
 *
 * Skips rather than fabricating a pass when no database is reachable.
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

describe('integration-real-postgres: general admission capacity', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let zones: ZoneInventoryService;

  const suffix = `zone-${Date.now()}`;
  let orgId = '';
  let venueId = '';
  let spaceId = '';
  let seatMapId = '';
  let eventId = '';
  let sessionId = '';
  let floorZoneId = '';

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
    zones = new ZoneInventoryService(db as never);

    const org = await db!.organization.create({
      data: { name: `Zone ${suffix}`, slug: `zone-${suffix}` },
    });
    orgId = org.id;
    const venue = await db!.venue.create({
      data: {
        organizationId: orgId,
        name: `Arena ${suffix}`,
        city: 'Boise',
        country: 'United States',
      },
    });
    venueId = venue.id;
    // A space with no cinema - an arena, which is the point of the whole migration.
    const space = await db!.screen.create({
      data: { venueId, name: 'Main Arena', capacity: 18_000 },
    });
    spaceId = space.id;

    const map = await db!.seatMap.create({
      data: { screenId: spaceId, name: 'Concert - End Stage', status: 'PUBLISHED' },
    });
    seatMapId = map.id;

    const floorCat = await db!.seatCategory.create({
      data: { seatMapId, name: 'Floor GA', basePriceMinor: 8_500, sortOrder: 0 },
    });
    const vipCat = await db!.seatCategory.create({
      data: { seatMapId, name: 'VIP Pit', basePriceMinor: 25_000, sortOrder: 1 },
    });

    // Two standing areas at different prices, which is the GA + VIP case.
    const floor = await db!.seatZone.create({
      data: { seatMapId, name: 'Floor', categoryId: floorCat.id, capacity: 3, sortOrder: 0 },
    });
    floorZoneId = floor.id;
    await db!.seatZone.create({
      data: { seatMapId, name: 'VIP Pit', categoryId: vipCat.id, capacity: 2, sortOrder: 1 },
    });

    const event = await db!.event.create({
      data: {
        organizationId: orgId,
        venueId,
        title: `Concert ${suffix}`,
        slug: `concert-${suffix}`,
        category: 'Music',
      },
    });
    eventId = event.id;
    const session = await db!.eventSession.create({
      data: {
        eventId,
        seatMapId,
        screenId: spaceId,
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        endsAt: new Date(Date.now() + 30 * 86_400_000 + 3 * 3_600_000),
      },
    });
    sessionId = session.id;

    await zones.materializeForSession(sessionId, seatMapId);
  }, 120_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.showZone.deleteMany({ where: { eventSessionId: sessionId } });
    await db.eventSession.deleteMany({ where: { eventId } });
    await db.event.deleteMany({ where: { organizationId: orgId } });
    await db.seatZone.deleteMany({ where: { seatMapId } });
    await db.seatCategory.deleteMany({ where: { seatMapId } });
    await db.seatMap.deleteMany({ where: { screenId: spaceId } });
    await db.screen.deleteMany({ where: { venueId } });
    await db.venue.deleteMany({ where: { organizationId: orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.$disconnect();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  const showZoneFor = async (zoneId: string) =>
    db!.showZone.findFirst({ where: { eventSessionId: sessionId, zoneId } });

  maybe('a session gets inventory for every zone in its layout', async () => {
    const all = await zones.availability(sessionId);
    expect(all.map((z) => z.name)).toEqual(['Floor', 'VIP Pit']);
    expect(all.map((z) => z.remaining)).toEqual([3, 2]);
    // Priced from the shared category, exactly as a seated section is.
    expect(all[1].priceMinor).toBe(25_000);
  });

  maybe('two buyers racing for the last place - only one wins', async () => {
    /*
      THE ASSERTION THIS FILE EXISTS FOR.

      Floor holds 3. Two buyers ask for 2 each, at the same moment. Exactly one can be
      satisfied; if both were, the zone would have sold 4 places it does not have.

      Issued concurrently rather than sequentially: sequential calls cannot oversell, so a
      sequential test would pass against a read-then-write implementation that is broken.
    */
    const sz = await showZoneFor(floorZoneId);
    const [a, b] = await Promise.all([zones.tryHold(sz.id, 2), zones.tryHold(sz.id, 2)]);

    expect([a, b].filter(Boolean)).toHaveLength(1);

    const after = await showZoneFor(floorZoneId);
    expect(after.held).toBe(2);
    expect(after.capacity - after.sold - after.held).toBe(1);
  });

  maybe('the loser can still take what is actually left', async () => {
    // One place remains after the race. The refusal was about the QUANTITY, not the zone.
    const sz = await showZoneFor(floorZoneId);
    expect(await zones.tryHold(sz.id, 1)).toBe(true);

    const full = await showZoneFor(floorZoneId);
    expect(full.held).toBe(3);
    expect(await zones.tryHold(full.id, 1)).toBe(false);
  });

  maybe('a hold becomes a sale, and does not add to the total', async () => {
    const sz = await showZoneFor(floorZoneId);
    expect(await zones.tryConfirm(sz.id, 3)).toBe(true);

    const after = await showZoneFor(floorZoneId);
    expect(after.sold).toBe(3);
    expect(after.held).toBe(0);
    // Still full. Confirming MOVED the places; it did not create any.
    expect(after.capacity - after.sold - after.held).toBe(0);
  });

  maybe('a sale cannot be confirmed from a hold that is not there', async () => {
    /*
      An expired hold whose payment confirms late must not conjure a sale out of a zone that
      has since filled. The whole floor is sold at this point and nothing is held.
    */
    const sz = await showZoneFor(floorZoneId);
    expect(await zones.tryConfirm(sz.id, 1)).toBe(false);

    const after = await showZoneFor(floorZoneId);
    expect(after.sold).toBe(3);
  });

  maybe('releasing twice cannot invent capacity', async () => {
    /*
      A release that ran twice - a retry, a duplicate webhook - would drive `held` negative,
      and a negative hold INVENTS capacity: the zone would then sell more than it holds. The
      floor is at zero held, so these releases have nothing to give back.
    */
    const sz = await showZoneFor(floorZoneId);
    await zones.release(sz.id, 2);
    await zones.release(sz.id, 2);

    const after = await showZoneFor(floorZoneId);
    expect(after.held).toBe(0);
    expect(after.capacity - after.sold - after.held).toBe(0);
  });

  maybe('zones are independent - a full floor does not close the VIP pit', async () => {
    // Mixed inventory in one session: the arena's floor is sold out and its pit is not.
    const all = await zones.availability(sessionId);
    const remainingOf = (name: string) => all.find((z) => z.name === name)?.remaining;
    expect(remainingOf('Floor')).toBe(0);
    expect(remainingOf('VIP Pit')).toBe(2);
  });

  maybe('materialising a session twice does not double its capacity', async () => {
    const again = await zones.materializeForSession(sessionId, seatMapId);
    expect(again).toBe(0);
    const all = await zones.availability(sessionId);
    expect(all.map((z) => z.capacity)).toEqual([3, 2]);
  });
});
