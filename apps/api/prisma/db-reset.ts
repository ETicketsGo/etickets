/* eslint-disable no-console */
/**
 * `prisma migrate reset --force`, with the guard the raw command does not have.
 *
 * ── WHY THIS WRAPPER EXISTS ────────────────────────────────────────────────────────
 * `db:reset` was a bare `prisma migrate reset --force`. It DROPS the schema, recreates it and
 * reseeds — and it asked nothing about where it was pointed. Anyone with a production
 * DATABASE_URL in their shell was one npm script away from losing the company's records, and
 * `--force` exists precisely to remove the confirmation prompt that would otherwise have
 * caught it.
 *
 * The seed had the same hole and it emptied QA. Fixing one and leaving the other would be
 * fixing the incident rather than the class of incident.
 *
 * The environment allowlist is the same one the seed uses, so there is one answer to "may this
 * process destroy data" rather than two that can drift apart.
 */
import { execFileSync } from 'node:child_process';
import { assertDestructiveResetAllowed } from './destructive-guard';
import { BACKUP_DIR, takeBackup } from './backup';
import { existsSync } from 'node:fs';

assertDestructiveResetAllowed();

/*
  A recovery point first, where one is possible.

  On a developer machine there is usually no volume mounted and no pg_dump, and refusing to
  reset a local database over that would just teach people to bypass this script. So it is
  attempted, reported honestly either way, and only REQUIRED where a backup directory actually
  exists — which is the deployed case, and the case that matters.
*/
if (existsSync(BACKUP_DIR)) {
  try {
    const b = takeBackup();
    console.log(
      `  recovery point   ${b.name} (${(b.bytes / 1024 / 1024).toFixed(2)} MB, verified)`,
    );
  } catch (e) {
    console.error(`\nABORTING: ${BACKUP_DIR} exists but no recovery point could be taken.`);
    console.error(`  ${(e as Error).message}\n`);
    process.exit(1);
  }
} else {
  console.log(`  no backup directory at ${BACKUP_DIR}; proceeding without a recovery point.`);
}

console.log('!! prisma migrate reset: dropping and recreating this database.');
execFileSync('npx', ['prisma', 'migrate', 'reset', '--force'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
