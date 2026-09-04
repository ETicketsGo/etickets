/* eslint-disable no-console */
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
  case 'status':
    // Read-only. Prints rows per region per status, and every regulatory document with
    // whether its text has actually been reviewed.
    require('./policy-status');
    break;

  case 'india-cinema':
    // Additive and idempotent: existing rows are left alone, nothing is activated.
    require('./seed-india-cinema-policy');
    break;

  case 'full-reset': {
    if ((process.env.SEED_ALLOW_DESTRUCTIVE ?? '').toLowerCase() !== 'yes') {
      console.error(
        'Refusing to run full-reset: it empties every table in this database.\n' +
          'Set SEED_ALLOW_DESTRUCTIVE=yes as well if that is genuinely what you want.',
      );
      process.exit(1);
    }
    console.log('!! full-reset: every table in this database is about to be emptied.');
    require('./seed');
    break;
  }

  default:
    console.error(
      `Unknown SEED_OPERATION "${operation}". Expected one of: status, india-cinema, full-reset.`,
    );
    process.exit(1);
}
