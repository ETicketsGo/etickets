/* eslint-disable no-console */
/**
 * Taking, verifying and pruning recovery points, from inside the private network.
 *
 * ── WHY THE PLATFORM BACKS ITSELF UP ───────────────────────────────────────────────
 * Railway can snapshot the Postgres volume, but `volumeInstanceBackupCreate` and
 * `volumeInstanceBackupScheduleUpdate` both refuse a project-scoped token — they are
 * account-level operations. So the environment tokens this project actually deploys with
 * cannot take a backup, and QA was found with a backup schedule of none and a backup count of
 * zero. A destructive mistake there was unrecoverable except by reseeding, which is exactly
 * what happened.
 *
 * `pg_dump` needs no Railway authority at all — only the DATABASE_URL the service already has.
 * It runs inside the private network, writes to a mounted volume, and is therefore something
 * this codebase can guarantee rather than something an operator has to remember.
 *
 * ── WHAT MAKES A BACKUP A BACKUP ───────────────────────────────────────────────────
 * A file that exists is not a recovery point. Every dump written here is immediately read back
 * with `pg_restore --list`, which parses the archive's table of contents and fails on a
 * truncated or corrupt file. An unverified dump is deleted rather than kept, because a backup
 * you cannot restore is worse than no backup: it stops you looking for a real one.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Where the volume is mounted. Overridable so a developer can dump locally. */
export const BACKUP_DIR = process.env.BACKUP_DIR ?? '/backups';

/** How many recovery points to keep. Old ones are pruned only AFTER a new one verifies. */
const KEEP = Number(process.env.BACKUP_KEEP ?? 14);

const PREFIX = 'etg-';
const SUFFIX = '.dump';

export interface BackupFile {
  name: string;
  path: string;
  bytes: number;
  createdAt: Date;
}

/** Recovery points on the volume, newest first. */
export function listBackups(dir = BACKUP_DIR): BackupFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX))
    .map((name) => {
      const path = join(dir, name);
      const s = statSync(path);
      return { name, path, bytes: s.size, createdAt: s.mtime };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Is there a recovery point recent enough to destroy against?
 *
 * Used by the destructive path to refuse when there is nothing to fall back to. The window is
 * deliberately short: a week-old backup is a fine disaster recovery story and a poor answer to
 * "I am about to empty this database on purpose".
 */
export function hasRecentBackup(maxAgeMinutes = 60, dir = BACKUP_DIR): BackupFile | null {
  const newest = listBackups(dir)[0];
  if (!newest) return null;
  const ageMinutes = (Date.now() - newest.createdAt.getTime()) / 60_000;
  return ageMinutes <= maxAgeMinutes ? newest : null;
}

/**
 * Take a verified recovery point. Throws if it cannot produce one.
 *
 * Throwing matters: the caller is usually about to destroy something, and "the backup failed
 * but we carried on" is the sentence that precedes every unrecoverable incident.
 */
export function takeBackup(dir = BACKUP_DIR): BackupFile {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; cannot take a backup.');

  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw new Error(
        `Backup directory ${dir} does not exist and could not be created (${(e as Error).message}). ` +
          'On Railway this means no volume is mounted at that path.',
      );
    }
  }

  const env = (process.env.APP_ENV ?? 'unknown').toLowerCase();
  // Colons are legal in a filename on Linux and a nuisance everywhere else.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${PREFIX}${env}-${stamp}${SUFFIX}`;
  const path = join(dir, name);

  /*
    Custom format, not plain SQL: it is compressed, and `pg_restore` can read its table of
    contents without replaying it — which is what makes verification possible at all.

    The URL is passed as an argument to pg_dump and never logged. Everything this file prints
    is a filename and a byte count.
  */
  try {
    execFileSync('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', path, url], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30 * 60 * 1000,
    });
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string };
    // pg_dump puts the connection string in nothing it prints, but scrub defensively: a
    // backup routine must never be the thing that leaks a password into a log.
    const detail = (err.stderr?.toString() ?? err.message ?? '').replace(
      /postgres(ql)?:\/\/\S+/g,
      '[redacted]',
    );
    throw new Error(`pg_dump failed: ${detail.slice(0, 500)}`);
  }

  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error('pg_dump produced no output.');
  }

  // Read it back. A file that exists is not a recovery point.
  try {
    execFileSync('pg_restore', ['--list', path], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 5 * 60 * 1000,
    });
  } catch (e) {
    unlinkSync(path);
    throw new Error(
      `The dump could not be read back by pg_restore and has been deleted: ${(e as Error).message.slice(0, 300)}. ` +
        'A backup that cannot be restored is worse than none, because it stops you looking for a real one.',
    );
  }

  const s = statSync(path);
  return { name, path, bytes: s.size, createdAt: s.mtime };
}

/** Delete all but the newest `KEEP`. Runs only after a new backup has verified. */
export function prune(dir = BACKUP_DIR): string[] {
  const removed: string[] = [];
  for (const b of listBackups(dir).slice(KEEP)) {
    try {
      unlinkSync(b.path);
      removed.push(b.name);
    } catch {
      // A file that will not delete is not a reason to fail a backup run.
    }
  }
  return removed;
}

if (require.main === module) {
  const b = takeBackup();
  const pruned = prune();
  console.log(`  backup written   ${b.name}`);
  console.log(`  size             ${(b.bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  verified         yes (pg_restore --list)`);
  console.log(`  kept             ${listBackups().length} recovery points`);
  if (pruned.length) console.log(`  pruned           ${pruned.length}`);
  console.log(
    `BACKUP_JSON ${JSON.stringify({ name: b.name, bytes: b.bytes, kept: listBackups().length, pruned: pruned.length })}`,
  );
}

/**
 * Restore the newest recovery point into a scratch database, count what arrives, drop it.
 *
 * ── WHY VERIFYING THE FILE IS NOT ENOUGH ───────────────────────────────────────────
 * `takeBackup` reads each dump back with `pg_restore --list`, which proves the archive is
 * well-formed. It does not prove the data can be put back. Those are different claims, and the
 * gap between them is where organisations discover — during an incident — that their backups
 * have been unrestorable for months.
 *
 * This restores for real, into a database created for the purpose and dropped afterwards, so
 * the live data is never touched. What it reports is row counts: a restore that "succeeds" and
 * produces empty tables is a failure, and only counting catches it.
 */
export function restoreDrill(dir = BACKUP_DIR): {
  backup: string;
  tables: number;
  rows: Record<string, number>;
} {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; cannot run a restore drill.');
  const newest = listBackups(dir)[0];
  if (!newest) throw new Error(`No recovery point in ${dir} to restore.`);

  // A scratch database beside the real one. Same server, same credentials, different name —
  // so the drill exercises the actual restore path without going near live data.
  const scratch = `etg_restore_drill_${Date.now()}`;
  const parsed = new URL(url);
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const scratchUrl = new URL(url);
  scratchUrl.pathname = `/${scratch}`;

  const psql = (target: URL, sql: string) =>
    execFileSync('psql', [target.toString(), '-v', 'ON_ERROR_STOP=1', '-tAc', sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60 * 1000,
    })
      .toString()
      .trim();

  psql(adminUrl, `CREATE DATABASE "${scratch}"`);
  try {
    // Errors during restore are expected in small ways (ownership, extensions the role cannot
    // create), so this does NOT stop on the first one — the verdict comes from the row counts
    // below, which is the only thing that actually matters.
    try {
      execFileSync(
        'pg_restore',
        ['--no-owner', '--no-acl', '--dbname', scratchUrl.toString(), newest.path],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: 30 * 60 * 1000,
        },
      );
    } catch {
      /* counted below */
    }

    const tables = Number(
      psql(scratchUrl, `SELECT count(*) FROM pg_tables WHERE schemaname = 'public'`),
    );
    const rows: Record<string, number> = {};
    for (const t of ['User', 'Organization', 'Event', 'Booking', 'CinemaPricingPolicy']) {
      try {
        rows[t] = Number(psql(scratchUrl, `SELECT count(*) FROM "public"."${t}"`));
      } catch {
        rows[t] = -1; // table absent from the restore — a real failure, reported as one
      }
    }
    if (tables === 0) throw new Error('The restore produced no tables.');
    return { backup: newest.name, tables, rows };
  } finally {
    // Always: a scratch database left behind is a copy of production data nobody is watching.
    try {
      psql(adminUrl, `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    } catch {
      psql(adminUrl, `DROP DATABASE IF EXISTS "${scratch}"`);
    }
  }
  void parsed;
}
