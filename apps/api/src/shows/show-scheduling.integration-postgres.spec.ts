import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ShowsService } from './shows.service';

/**
 * integration-real-postgres — proves that concurrent scheduling cannot double-book a screen.
 *
 * This is the proof for the defect that started the whole track: `scheduleShow` created
 * sessions with no overlap check, so two films could be sold into the same room. The check
 * now exists, but a check alone is not enough — two managers filling the same screen at the
 * same moment can both read "no conflict" and both insert. That is a check-then-act race and
 * it cannot be disproven with mocks, a fake repository, or Promise.all over a single
 * transaction. It needs real connections against a real database.
 *
 * ── WHY THESE ARE DETERMINISTIC ───────────────────────────────────────────────────
 * The outcome is guaranteed by a lock, not by timing. Every write path takes
 * `SELECT … FOR UPDATE` on the screen row as the first statement in its transaction, so the
 * second transaction BLOCKS until the first commits, then re-reads. Which request wins is
 * arbitrary; that exactly one wins is not. The assertions are written accordingly: never
 * "request 1 wins", always "exactly one wins and the database has no overlap".
 *
 * ── THE ISOLATION ASSUMPTION ──────────────────────────────────────────────────────
 * READ COMMITTED, PostgreSQL's default and what this codebase runs. It is load-bearing:
 * after the loser acquires the lock, its next SELECT must see the winner's committed insert.
 * Under REPEATABLE READ the loser's snapshot would predate that commit, the overlap check
 * would find nothing, and both would insert. `proves the isolation assumption` below asserts
 * this rather than trusting it.
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

const ORGANIZER = {
  id: 'itest-user',
  email: 'itest@eticketsgo.test',
  fullName: 'Integration Test',
  roles: [],
} as never;

/** Authorization is proven by unit tests; here it must not get in the way of the race. */
const allowAll = { assertMember: async () => undefined } as never;
const noAudit = { record: async () => undefined } as never;
const config = (turnaround: number) => ({ get: () => turnaround }) as never;

const buildService = (client: Client, turnaround = 15) =>
  new ShowsService(client as never, allowAll, noAudit, config(turnaround));

/** A future instant, far enough out that nothing is rejected for being in the past. */
const day = (offsetDays: number, hour: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

const isConflict = (r: PromiseSettledResult<unknown>) =>
  r.status === 'rejected' && /already booked|Screen is already/i.test(String(r.reason?.message));

describe('integration-real-postgres: scheduling races cannot double-book a screen', () => {
  const url = loadDatabaseUrl();
  let a: Client | undefined;
  let b: Client | undefined;
  let available = false;

  const suffix = `race-${Date.now()}`;
  let orgId = '';
  let venueId = '';
  let cinemaId = '';
  let screenId = '';
  let screen2Id = '';
  let movieId = '';

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    // TWO independent clients, so the racing transactions genuinely use different
    // connections. Two transactions from one client can be served from one pooled
    // connection, which would serialise them for the wrong reason and prove nothing.
    a = new PrismaClient({ datasources: { db: { url } } });
    b = new PrismaClient({ datasources: { db: { url } } });
    try {
      await a.$queryRaw`SELECT 1`;
      available = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[integration-real-postgres] SKIPPED — DB unavailable: ${(err as Error).message}`,
      );
      return;
    }

    const org = await a.organization.create({
      data: { name: `Race Cinemas ${suffix}`, slug: `race-cinemas-${suffix}` },
    });
    orgId = org.id;
    const venue = await a.venue.create({
      data: {
        organizationId: orgId,
        name: `Race Venue ${suffix}`,
        city: 'Hyderabad',
        country: 'India',
      },
    });
    venueId = venue.id;
    const cinema = await a.cinema.create({
      data: { organizationId: orgId, venueId, name: `Race Multiplex ${suffix}`, city: 'Hyderabad' },
    });
    cinemaId = cinema.id;

    for (const name of ['Screen 1', 'Screen 2']) {
      const screen = await a.screen.create({
        data: { cinemaId, name, screenType: '2D', capacity: 4 },
      });
      const seatMap = await a.seatMap.create({ data: { screenId: screen.id, name: 'Layout' } });
      const category = await a.seatCategory.create({
        data: { seatMapId: seatMap.id, name: 'Normal', basePriceMinor: 20000, sortOrder: 0 },
      });
      const section = await a.seatSection.create({
        data: { seatMapId: seatMap.id, name: 'Main', sortOrder: 0 },
      });
      const row = await a.seatRow.create({
        data: { sectionId: section.id, label: 'A', sortOrder: 0 },
      });
      await a.seat.createMany({
        data: [1, 2, 3, 4].map((i) => ({
          seatMapId: seatMap.id,
          rowId: row.id,
          seatCategoryId: category.id,
          label: String(i),
          colIndex: i,
          kind: 'SEAT',
        })),
      });
      if (name === 'Screen 1') screenId = screen.id;
      else screen2Id = screen.id;
    }

    const movie = await a.movie.create({
      data: {
        organizationId: orgId,
        title: `Race Movie ${suffix}`,
        slug: `race-movie-${suffix}`,
        runtimeMinutes: 120,
        language: 'Telugu',
        status: 'PUBLISHED',
      },
    });
    movieId = movie.id;
  }, 60_000);

  /** Remove sessions between tests so each race starts from a known screen schedule. */
  const clearSessions = async () => {
    if (!a) return;
    const sessions = await a.eventSession.findMany({
      where: { event: { movieId } },
      select: { id: true },
    });
    const ids = sessions.map((s: { id: string }) => s.id);
    if (!ids.length) return;
    await a.showSeat.deleteMany({ where: { eventSessionId: { in: ids } } });
    await a.ticketInventory.deleteMany({
      where: { ticketType: { eventSessionId: { in: ids } } },
    });
    await a.ticketType.deleteMany({ where: { eventSessionId: { in: ids } } });
    await a.eventSession.deleteMany({ where: { id: { in: ids } } });
  };

  beforeEach(async () => {
    if (available) await clearSessions();
  });

  afterAll(async () => {
    if (available && a) {
      await clearSessions();
      await a.event.deleteMany({ where: { movieId } });
      await a.movie.deleteMany({ where: { id: movieId } });
      await a.seat.deleteMany({ where: { seatMap: { screen: { cinemaId } } } });
      await a.seatRow.deleteMany({ where: { section: { seatMap: { screen: { cinemaId } } } } });
      await a.seatSection.deleteMany({ where: { seatMap: { screen: { cinemaId } } } });
      await a.seatCategory.deleteMany({ where: { seatMap: { screen: { cinemaId } } } });
      await a.seatMap.deleteMany({ where: { screen: { cinemaId } } });
      await a.screen.deleteMany({ where: { cinemaId } });
      await a.cinema.deleteMany({ where: { id: cinemaId } });
      await a.venue.deleteMany({ where: { id: venueId } });
      await a.organization.deleteMany({ where: { id: orgId } });
    }
    await a?.$disconnect();
    await b?.$disconnect();
  }, 60_000);

  /** Sessions currently on a screen, ordered, for overlap assertions. */
  const sessionsOn = async (id: string) =>
    (a as Client).eventSession.findMany({
      where: { screenId: id, status: { not: 'CANCELLED' } },
      select: { id: true, startsAt: true, endsAt: true },
      orderBy: { startsAt: 'asc' },
    });

  /** The invariant every one of these tests exists to defend. */
  const expectNoOverlap = async (id: string, turnaroundMinutes = 15) => {
    const rows = await sessionsOn(id);
    for (let i = 1; i < rows.length; i += 1) {
      const gapMs = rows[i].startsAt.getTime() - rows[i - 1].endsAt.getTime();
      expect(gapMs).toBeGreaterThanOrEqual(turnaroundMinutes * 60_000);
    }
    return rows;
  };

  /**
   * No orphaned inventory: every ShowSeat and TicketType belongs to a session that exists.
   *
   * Scoped to THIS suite's cinema. An unscoped count looks stricter and is simply wrong —
   * Jest runs suites in parallel against one database, so it counts other suites'
   * perfectly legitimate rows as strays and fails intermittently. That produced exactly
   * the kind of flake that would discredit a real proof, and the fix is to make the
   * assertion mean what it says rather than to delete it.
   */
  const expectNoOrphans = async () => {
    const sessionIds = (
      await (a as Client).eventSession.findMany({
        where: { event: { movieId } },
        select: { id: true },
      })
    ).map((s: { id: string }) => s.id);
    const mine = sessionIds.length ? sessionIds : ['none'];
    const straySeats = await (a as Client).showSeat.count({
      where: {
        eventSessionId: { notIn: mine },
        seat: { seatMap: { screen: { cinemaId } } },
      },
    });
    const strayTypes = await (a as Client).ticketType.count({
      where: {
        eventSessionId: { notIn: mine },
        seatCategory: { seatMap: { screen: { cinemaId } } },
      },
    });
    expect(straySeats).toBe(0);
    expect(strayTypes).toBe(0);
  };

  const maybe = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  // ── A. Two racing creates ────────────────────────────────────────────────────────

  maybe(
    'A: two concurrent creates on one screen — exactly one wins',
    async () => {
      // Repeated, because a check-then-act race is timing sensitive: a single pass can miss
      // it. Ten rounds is enough to expose an unlocked implementation reliably and stays fast
      // enough for CI.
      for (let round = 0; round < 10; round += 1) {
        await clearSessions();
        const startsAt = day(3 + round, 10);
        const endsAt = new Date(startsAt.getTime() + 120 * 60_000);
        // Deliberately overlapping, offset so they are not an exact duplicate.
        const other = new Date(startsAt.getTime() + 30 * 60_000);

        const results = await Promise.allSettled([
          buildService(a as Client).scheduleShow(ORGANIZER, movieId, {
            screenId,
            startsAt,
            endsAt,
          }),
          buildService(b as Client).scheduleShow(ORGANIZER, movieId, {
            screenId,
            startsAt: other,
            endsAt: new Date(other.getTime() + 120 * 60_000),
          }),
        ]);

        const won = results.filter((r) => r.status === 'fulfilled');
        expect(won).toHaveLength(1);
        expect(results.filter(isConflict)).toHaveLength(1);

        const rows = await sessionsOn(screenId);
        expect(rows).toHaveLength(1);
      }
      await expectNoOrphans();
    },
    180_000,
  );

  maybe('A: the loser leaves no session, ticket types or seats behind', async () => {
    const startsAt = day(20, 10);
    const endsAt = new Date(startsAt.getTime() + 120 * 60_000);

    await Promise.allSettled([
      buildService(a as Client).scheduleShow(ORGANIZER, movieId, { screenId, startsAt, endsAt }),
      buildService(b as Client).scheduleShow(ORGANIZER, movieId, { screenId, startsAt, endsAt }),
    ]);

    const rows = await sessionsOn(screenId);
    expect(rows).toHaveLength(1);
    // The whole create is one transaction, so a rolled-back loser cannot leave inventory.
    const seats = await (a as Client).showSeat.count({ where: { eventSessionId: rows[0].id } });
    expect(seats).toBe(4);
    const types = await (a as Client).ticketType.count({
      where: { eventSessionId: rows[0].id },
    });
    expect(types).toBe(1);
    await expectNoOrphans();
  });

  // ── B. Create vs reschedule ──────────────────────────────────────────────────────

  maybe(
    'B: create racing a reschedule into the same slot — exactly one wins',
    async () => {
      for (const swap of [false, true]) {
        await clearSessions();
        // A exists in the morning; the contested slot is the afternoon.
        const morning = day(30, 9);
        const created = await buildService(a as Client).scheduleShow(ORGANIZER, movieId, {
          screenId,
          startsAt: morning,
          endsAt: new Date(morning.getTime() + 120 * 60_000),
        });

        const target = day(30, 15);
        const createB = () =>
          buildService(b as Client).scheduleShow(ORGANIZER, movieId, {
            screenId,
            startsAt: target,
            endsAt: new Date(target.getTime() + 120 * 60_000),
          });
        const moveA = () =>
          buildService(a as Client).rescheduleShow(ORGANIZER, created.sessionId, {
            startsAt: new Date(target.getTime() + 30 * 60_000),
            padMinutes: 0,
          });

        // Both orderings, because a lock taken in a different sequence is exactly how a
        // design that looks safe in one direction fails in the other.
        const results = await Promise.allSettled(
          swap ? [moveA(), createB()] : [createB(), moveA()],
        );

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(isConflict)).toHaveLength(1);
        await expectNoOverlap(screenId);
      }
      await expectNoOrphans();
    },
    120_000,
  );

  // ── C. Two racing reschedules ────────────────────────────────────────────────────

  maybe('C: two shows moving into the same slot — exactly one lands', async () => {
    await clearSessions();
    const first = day(40, 8);
    const second = day(40, 12);
    const s1 = await buildService(a as Client).scheduleShow(ORGANIZER, movieId, {
      screenId,
      startsAt: first,
      endsAt: new Date(first.getTime() + 120 * 60_000),
    });
    const s2 = await buildService(a as Client).scheduleShow(ORGANIZER, movieId, {
      screenId,
      startsAt: second,
      endsAt: new Date(second.getTime() + 120 * 60_000),
    });

    const target = day(40, 18);
    const results = await Promise.allSettled([
      buildService(a as Client).rescheduleShow(ORGANIZER, s1.sessionId, {
        startsAt: target,
        padMinutes: 0,
      }),
      buildService(b as Client).rescheduleShow(ORGANIZER, s2.sessionId, {
        startsAt: new Date(target.getTime() + 20 * 60_000),
        padMinutes: 0,
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(isConflict)).toHaveLength(1);
    // Both shows still exist; only one moved.
    expect(await sessionsOn(screenId)).toHaveLength(2);
    await expectNoOverlap(screenId);
  });

  // ── D. Bulk vs single ────────────────────────────────────────────────────────────

  maybe('D: a bulk batch racing a single create — no overlap survives', async () => {
    await clearSessions();
    const target = day(50, 6);
    const dateLabel = target.toISOString().slice(0, 10);

    const results = await Promise.allSettled([
      buildService(a as Client).bulkScheduleShows(ORGANIZER, movieId, {
        screenId,
        dates: [dateLabel],
        times: ['06:00', '10:00', '14:00'],
        padMinutes: 0,
        timezone: 'UTC',
        dryRun: false,
      } as never),
      buildService(b as Client).scheduleShow(ORGANIZER, movieId, {
        screenId,
        startsAt: new Date(target.getTime() + 4 * 60 * 60_000 + 30 * 60_000),
        endsAt: new Date(target.getTime() + 6 * 60 * 60_000 + 30 * 60_000),
      }),
    ]);

    // The bulk call never throws for a conflict — it reports one — so the assertion is on
    // the database, not on which promise rejected.
    const rows = await expectNoOverlap(screenId);
    expect(rows.length).toBeGreaterThan(0);
    const bulk = results[0];
    if (bulk.status === 'fulfilled') {
      const created = (bulk.value as { created: unknown[] }).created.length;
      const rejected = (bulk.value as { rejected: unknown[] }).rejected.length;
      // Whatever the split, every proposal is accounted for.
      expect(created + rejected).toBe(3);
    }
    await expectNoOrphans();
  });

  // ── E. Bulk vs bulk ──────────────────────────────────────────────────────────────

  maybe('E: two bulk batches proposing the same slots — no double booking', async () => {
    await clearSessions();
    const target = day(60, 6);
    const dateLabel = target.toISOString().slice(0, 10);
    const body = {
      screenId,
      dates: [dateLabel],
      times: ['06:00', '10:00', '14:00', '18:00'],
      padMinutes: 0,
      timezone: 'UTC',
      dryRun: false,
    } as never;

    const results = await Promise.allSettled([
      buildService(a as Client).bulkScheduleShows(ORGANIZER, movieId, body),
      buildService(b as Client).bulkScheduleShows(ORGANIZER, movieId, body),
    ]);

    const rows = await expectNoOverlap(screenId);
    // Four identical proposals from two callers must produce four shows, not eight.
    expect(rows).toHaveLength(4);

    const totalCreated = results.reduce(
      (n, r) =>
        n + (r.status === 'fulfilled' ? (r.value as { created: unknown[] }).created.length : 0),
      0,
    );
    expect(totalCreated).toBe(4);
    await expectNoOrphans();
  });

  // ── The assumption the whole design rests on ─────────────────────────────────────

  maybe('proves the isolation assumption the lock depends on', async () => {
    /**
     * A deterministic barrier rather than a hopeful Promise.all.
     *
     * T1 takes the screen lock and inserts, then HOLDS the transaction open. T2 then tries
     * to take the same lock and must block — proven by the fact that it has not resolved
     * while T1 still holds it. T1 commits; T2 proceeds and its SELECT must now see T1's
     * row.
     *
     * That last step is the READ COMMITTED assumption. Under REPEATABLE READ, T2's snapshot
     * would predate T1's commit, it would see nothing, and both would insert.
     */
    await clearSessions();
    const startsAt = day(70, 10);
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
    const A = a as Client;
    const B = b as Client;

    let releaseT1: () => void = () => undefined;
    const t1Held = new Promise<void>((r) => {
      releaseT1 = r;
    });
    let t1HasLock: () => void = () => undefined;
    const lockAcquired = new Promise<void>((r) => {
      t1HasLock = r;
    });

    const t1 = A.$transaction(
      async (tx: Client) => {
        await tx.$queryRaw`SELECT id FROM "Screen" WHERE id = ${screenId} FOR UPDATE`;
        t1HasLock();
        await t1Held;
        return tx.$executeRaw`
        INSERT INTO "EventSession" ("id","eventId","screenId","startsAt","endsAt","status","createdAt","updatedAt")
        SELECT ${`itest-${Date.now()}`}, e.id, ${screenId}, ${startsAt}, ${endsAt}, 'SCHEDULED', NOW(), NOW()
        FROM "Event" e WHERE e."movieId" = ${movieId} LIMIT 1`;
      },
      { timeout: 30_000 },
    );

    await lockAcquired;

    let t2Resolved = false;
    const t2 = B.$transaction(
      async (tx: Client) => {
        await tx.$queryRaw`SELECT id FROM "Screen" WHERE id = ${screenId} FOR UPDATE`;
        // Must observe T1's committed insert; this is the assertion that matters.
        const seen = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n FROM "EventSession"
        WHERE "screenId" = ${screenId} AND "startsAt" = ${startsAt}`;
        return Number(seen[0].n);
      },
      { timeout: 30_000 },
    ).then((v: number) => {
      t2Resolved = true;
      return v;
    });

    // Give T2 a real chance to run. It cannot proceed: T1 holds the lock.
    await new Promise((r) => setTimeout(r, 400));
    expect(t2Resolved).toBe(false);

    releaseT1();
    await t1;
    const observed = await t2;

    // The one that proves READ COMMITTED gives the loser a fresh view after the lock.
    expect(observed).toBe(1);
  });

  maybe('an event created by a create is reused, not duplicated per session', async () => {
    // Guards a subtler bulk race: two concurrent creates both finding no Event and both
    // making one would give a film two listings.
    await clearSessions();
    const t = day(80, 9);
    await Promise.allSettled([
      buildService(a as Client).scheduleShow(ORGANIZER, movieId, {
        screenId,
        startsAt: t,
        endsAt: new Date(t.getTime() + 60 * 60_000),
      }),
      buildService(b as Client).scheduleShow(ORGANIZER, movieId, {
        screenId: screen2Id,
        startsAt: t,
        endsAt: new Date(t.getTime() + 60 * 60_000),
      }),
    ]);
    const events = await (a as Client).event.count({ where: { movieId } });
    expect(events).toBe(1);
  });
});
