/* eslint-disable @typescript-eslint/no-var-requires */

/**
 * Serializes the test suites whose subject is GLOBAL notification state.
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────────────
 * Several things in this subsystem are deliberately global, and are right to be:
 *
 *   `dispatchDue()` sweeps every notification that is pending and due — one worker, one
 *   sweep, everything owed gets sent.
 *
 *   The certification ladder asks "has ANY message through msg91/sms ever been accepted, and
 *   has any provider ever called back". Scoping that to a caller would defeat it: the whole
 *   point is that evidence is evidence, wherever it came from.
 *
 *   Cost analytics totals a window across the platform.
 *
 * Jest runs suites in parallel workers against one Postgres, so a suite that WRITES that
 * global state runs concurrently with a suite whose assertions READ it. Two sweeps deliver
 * each other's notifications through each other's mocks; a suite creating msg91 rows makes a
 * certification test see evidence it did not create. The symptom is always the same: passes
 * alone, fails in a full run, and cannot be fixed by filtering the assertions, because the
 * damage lands before those assertions run.
 *
 * ── WHY AN ADVISORY LOCK AND NOT `--runInBand` ─────────────────────────────────────
 * Serializing the whole run to fix seven files would cost every other suite its parallelism,
 * and would express the constraint in a CI flag rather than in the code that has it. An
 * advisory lock says precisely what is true — these suites may not sweep at the same time —
 * and says it where somebody adding an eighth will see it.
 *
 * ── WHY IT OPENS ITS OWN CONNECTION ────────────────────────────────────────────────
 * A session advisory lock belongs to the CONNECTION that took it, and Prisma pools. Taking
 * the lock through a suite's ordinary client would work by luck and unlock through whichever
 * pooled connection happened to be free — leaving the lock held for the rest of the run, and
 * every other sweep suite blocked behind a lock nobody owns any more.
 *
 * So the lock gets a client of its own, pinned to `connection_limit=1`. If a worker dies
 * without releasing, its connection drops and Postgres releases the lock with it, so a
 * crashed suite cannot wedge the rest of the run.
 *
 * ── WHY NOT SCOPE `dispatchDue` INSTEAD ────────────────────────────────────────────
 * Because a sweep that only sweeps some of what is owed is a worse sweep. Adding a filter to
 * production code so tests can share a database would put a parameter in the delivery path
 * whose only real caller is a test, and the first person to use it in earnest would quietly
 * stop delivering somebody's notifications.
 */

/** One arbitrary but stable key. Every suite using this lock shares it, which is the point. */
const SWEEP_LOCK_KEY = 918_273_645;

export interface SweepLock {
  release(): Promise<void>;
}

/** A no-op handle, for a suite that is skipping because no database is reachable. */
const NOOP: SweepLock = { release: async () => undefined };

/**
 * How long to keep trying before giving up and running unlocked.
 *
 * ── WHY THIS NUMBER IS A COMPROMISE, AND WHAT IT COSTS EITHER WAY ──────────────────
 * The lock is load-bearing, not decorative: with it permanently unavailable, `market-flows`
 * and `fallback` both fail. They each call the global sweep, and a sweep delivers whatever
 * is due through whichever suite's mock got there first, so two of them running at once
 * corrupt each other regardless of how carefully their assertions are scoped.
 *
 * So giving up cheaply is not free -- it trades a hang for a flake. But waiting is not free
 * either: at two minutes, nine suites each waiting out the deadline turned a hundred-second
 * step into nineteen minutes.
 *
 * Forty-five seconds is comfortably longer than any of these suites takes to run, so in the
 * ordinary case the wait never approaches it and the lock simply works. The worst case is
 * bounded at roughly seven minutes rather than unbounded, which is the property that matters.
 */
const ACQUIRE_DEADLINE_MS = 45_000;
const ACQUIRE_POLL_MS = 100;

/**
 * Take the sweep lock, waiting up to a deadline, then proceeding WITHOUT it.
 *
 * -- WHY THIS POLLS INSTEAD OF BLOCKING, AND WHY IT GIVES UP --------------------------
 * The first version used `pg_advisory_lock`, which blocks until the lock is free. That is
 * the natural thing to reach for and it deadlocked CI for the better part of an hour.
 *
 * The mechanism: a suite whose `beforeAll` has Jest's default five-second timeout blocks on
 * the lock, the hook times out, and Jest moves on -- but the QUERY is still pending on a
 * connection nobody disconnects. When the holder releases, that orphaned query acquires the
 * lock, and the handle it would have been released through was never returned to anyone. The
 * lock is then held by a dead test for the rest of the run, and every suite behind it blocks
 * forever. Slow, contended machines hit it; a fast laptop ran it five times clean.
 *
 * `pg_try_advisory_lock` returns immediately either way, so no query is ever left pending and
 * there is nothing to orphan. Polling to a deadline keeps the serialization that these suites
 * need, and giving up after it keeps the failure BOUNDED: past the deadline the suite runs
 * unlocked, which is exactly the behaviour it had before this file existed. That can produce
 * a flake. It cannot produce a hung pipeline, and between a rare re-run and an hour of
 * silence the choice is not close.
 */
export async function acquireSweepLock(url: string | undefined): Promise<SweepLock> {
  if (!url) return NOOP;
  const { PrismaClient } = require('@prisma/client');
  const separator = url.includes('?') ? '&' : '?';
  const client = new PrismaClient({
    datasources: { db: { url: `${url}${separator}connection_limit=1` } },
  });
  const deadline = Date.now() + ACQUIRE_DEADLINE_MS;
  let held = false;
  try {
    do {
      // `require`d client, so it is untyped here; the shape is asserted rather than generic.
      const rows = (await client.$queryRawUnsafe(
        `SELECT pg_try_advisory_lock(${SWEEP_LOCK_KEY}) AS locked`,
      )) as { locked: boolean }[];
      held = rows?.[0]?.locked === true;
      if (held) break;
      await new Promise((resolve) => setTimeout(resolve, ACQUIRE_POLL_MS));
    } while (Date.now() < deadline);
  } catch {
    // A database that cannot take a lock is one the suite is about to skip against anyway.
    await client.$disconnect().catch(() => undefined);
    return NOOP;
  }
  const waitedMs = Date.now() - (deadline - ACQUIRE_DEADLINE_MS);
  /*
    Reported when it is long enough to matter. Where the time went in a slow run has had to be
    inferred from arithmetic twice; a line in the log is cheaper than a guess.
  */
  if (held && waitedMs > 1_000) {
    // eslint-disable-next-line no-console
    console.warn(`[sweep-lock] waited ${Math.round(waitedMs / 100) / 10}s for the lock.`);
  }
  if (!held) {
    /*
      Ran out of patience. Proceed unlocked rather than block: this suite may now interleave
      with another and produce a confusing failure, which is recoverable, where a hang is not.
    */
    // eslint-disable-next-line no-console
    console.warn('[sweep-lock] could not acquire within the deadline; running unlocked.');
    await client.$disconnect().catch(() => undefined);
    return NOOP;
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await client
        .$executeRawUnsafe(`SELECT pg_advisory_unlock(${SWEEP_LOCK_KEY})`)
        .catch(() => undefined);
      await client.$disconnect().catch(() => undefined);
    },
  };
}
