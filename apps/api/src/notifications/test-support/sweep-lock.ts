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
 * Take the sweep lock, waiting if another suite holds it.
 *
 * `pg_advisory_lock` blocks rather than failing, which is what is wanted: the second suite
 * should wait its turn, not error. Returns a handle whose `release()` is safe to call twice.
 */
export async function acquireSweepLock(url: string | undefined): Promise<SweepLock> {
  if (!url) return NOOP;
  const { PrismaClient } = require('@prisma/client');
  const separator = url.includes('?') ? '&' : '?';
  const client = new PrismaClient({
    datasources: { db: { url: `${url}${separator}connection_limit=1` } },
  });
  try {
    await client.$executeRawUnsafe(`SELECT pg_advisory_lock(${SWEEP_LOCK_KEY})`);
  } catch {
    // A database that cannot take a lock is one the suite is about to skip against anyway.
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
