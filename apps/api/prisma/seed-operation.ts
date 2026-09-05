/* eslint-disable no-console */
import { assertDestructiveResetAllowed, destructiveResetVerdict } from './destructive-guard';
import { BACKUP_DIR, listBackups, prune, restoreDrill, takeBackup } from './backup';
/**
 * The single entry point the `db-seed` Railway service runs.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * `db-seed` used to be wired straight to `prisma/seed.ts`, whose first act is to empty every
 * table. Deploying that service — for any reason, including redeploying it to run something
 * else — wiped the environment. That is not a hypothetical: it happened to QA, and it took
 * the events, bookings, tax rules and payment configuration with it.
 *
 * The start command lives in `deploy/railway/db-seed.railway.json`, which is config-as-code
 * and therefore OVERRIDES anything set through the Railway API or dashboard. So "just set a
 * different start command for one run" does not work, and quietly runs the destructive seed
 * instead. That is the trap this file closes: the service now always runs the same command,
 * and an environment variable — which config-as-code does not override — selects the work.
 *
 * ── THE DEFAULT IS READ-ONLY, ON PURPOSE ───────────────────────────────────────────
 * With no SEED_OPERATION set, this prints a census and changes nothing. A stray redeploy is
 * then a no-op that tells you what is in the database, rather than an event that empties it.
 *
 *   SEED_OPERATION=status         (default)  read-only census
 *   SEED_OPERATION=india-cinema              write AP + TG policies, all DRAFT, idempotent
 *   SEED_OPERATION=full-reset                EMPTY EVERY TABLE and reseed demo data
 *
 * `full-reset` additionally requires SEED_ALLOW_DESTRUCTIVE=yes. One variable can be set by
 * accident; two, one of which says what it does, is a decision.
 */
/*
  Empty means unset. `??` only defaults on null/undefined, so a variable set to an empty
  string — exactly what clearing the field can leave behind — fell through to the
  unknown-operation branch and exited 1. The safe default has to cover "set to nothing" as
  well as "never set", or the failure mode returns the moment someone blanks the value
  instead of deleting it.
*/

const requested = (process.env.SEED_OPERATION ?? '').trim().toLowerCase();
const operation = requested === '' ? 'status' : requested;

console.log(`seed-operation: ${operation}`);

switch (operation) {
  case 'status': {
    /*
      The default, and it writes nothing.

      It reports which environment it believes it is in BEFORE anything else, because the most
      dangerous mistake available here is running a command against a database you think is
      somewhere else. Reporting the destructive verdict on a read-only run means the guard is
      exercised and visible every time, rather than only being consulted on the one run where
      being wrong is unrecoverable.
    */
    const verdict = destructiveResetVerdict();
    console.log(`  environment      APP_ENV=${verdict.appEnv ?? '(not set)'}`);
    if (verdict.railwayEnv) console.log(`  platform         ${verdict.railwayEnv}`);
    console.log(`  destructive      NOT REQUESTED (SEED_OPERATION=${operation})`);
    console.log(
      `  would a reset be permitted here?  ${verdict.allowed ? 'yes' : 'NO'} — ${verdict.reason}`,
    );
    console.log('');
    require('./policy-status');
    break;
  }

  case 'backup': {
    /*
      A verified recovery point, taken by the platform itself.

      Railway's own volume backups need account-level credentials that a project token does
      not have, so this is the only backup the deployment pipeline can actually guarantee.
    */
    const b = takeBackup();
    const pruned = prune();
    console.log(`  backup written   ${b.name}`);
    console.log(`  size             ${(b.bytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  verified         yes (read back with pg_restore --list)`);
    console.log(
      `  recovery points  ${listBackups().length}${pruned.length ? ` (pruned ${pruned.length})` : ''}`,
    );
    console.log(
      `BACKUP_JSON ${JSON.stringify({ name: b.name, bytes: b.bytes, kept: listBackups().length })}`,
    );
    break;
  }

  case 'backups': {
    // Read-only. What could this environment actually be restored to, and how old is it?
    const all = listBackups();
    console.log(`  directory        ${BACKUP_DIR}`);
    console.log(`  recovery points  ${all.length}`);
    for (const b of all.slice(0, 20)) {
      const ageH = ((Date.now() - b.createdAt.getTime()) / 3_600_000).toFixed(1);
      console.log(`    ${b.name}  ${(b.bytes / 1024 / 1024).toFixed(2)} MB  ${ageH}h old`);
    }
    console.log(
      `BACKUPS_JSON ${JSON.stringify({ dir: BACKUP_DIR, count: all.length, newest: all[0]?.name ?? null })}`,
    );
    break;
  }

  case 'restore-drill': {
    /*
      Proof that the newest recovery point can actually be RESTORED, not merely parsed.

      Restores into a scratch database created for the purpose and dropped afterwards, so live
      data is never touched, and reports row counts — a restore that "succeeds" into empty
      tables is a failure that only counting catches.
    */
    const r = restoreDrill();
    console.log(`  restored         ${r.backup}`);
    console.log(`  tables           ${r.tables}`);
    for (const [t, n] of Object.entries(r.rows)) {
      console.log(`    ${t.padEnd(22)} ${n < 0 ? 'MISSING FROM RESTORE' : n}`);
    }
    console.log(`RESTORE_DRILL_JSON ${JSON.stringify(r)}`);
    break;
  }

  case 'india-cinema':
    // Additive and idempotent: existing rows are left alone, nothing is activated.
    require('./seed-india-cinema-policy');
    break;

  case 'full-reset': {
    /*
      Order matters here, and it is the whole point.

      The environment is judged FIRST, from environment variables alone, before
      `require('./seed')` — which constructs a PrismaClient the moment it is loaded. A guard
      living inside the seed has already opened a connection to the database it is deciding
      whether to destroy. This one refuses and exits with nothing connected.

      It is an allowlist: an environment must be NAMED as resettable. Production is not on it,
      and cannot be put on it through configuration.
    */
    assertDestructiveResetAllowed();

    if ((process.env.SEED_ALLOW_DESTRUCTIVE ?? '').toLowerCase() !== 'yes') {
      console.error(
        'Refusing to run full-reset: it empties every table in this database.\n' +
          'Set SEED_ALLOW_DESTRUCTIVE=yes as well if that is genuinely what you want.',
      );
      process.exit(1);
    }
    /*
      A verified recovery point BEFORE anything is emptied, every time, with no way to skip it.

      This is the single change that would have made the incident an inconvenience instead of a
      loss. There is no flag to bypass it: an operator who is about to destroy an environment is
      precisely the operator least able to judge whether they will want it back, and every
      "just this once" is how a database ends up with no way home.

      Failure to back up ABORTS the reset. "The backup failed but we carried on" is the
      sentence that precedes every unrecoverable incident.
    */
    console.log('  taking a recovery point before emptying anything...');
    try {
      const b = takeBackup();
      prune();
      console.log(
        `  recovery point   ${b.name} (${(b.bytes / 1024 / 1024).toFixed(2)} MB, verified)`,
      );
    } catch (e) {
      console.error(
        `
ABORTING: could not take a recovery point, so nothing has been touched.
  ${(e as Error).message}
`,
      );
      process.exit(1);
    }

    console.log('!! full-reset: every table in this database is about to be emptied.');
    require('./seed');
    break;
  }

  default:
    console.error(
      `Unknown SEED_OPERATION "${operation}". Expected one of: status, backups, backup, restore-drill, india-cinema, full-reset.`,
    );
    process.exit(1);
}
