/**
 * Is the newest VERIFIED backup recent enough?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Production went five days with no backup while every nightly run reported SUCCESS (see
 * `scheduled-backup.spec.ts`). A schedule that runs the wrong job looks exactly like one that
 * runs the right job, so the only honest signal is the age of the newest artifact that passed
 * verification - not whether a job ran.
 *
 * The `db-seed` service writes the dumps to its own volume, which the API cannot read. So the
 * backup run leaves a small evidence row in the database it just dumped (`recordOpsEvidence` in
 * `prisma/backup.ts`, an `AuditLog` row with action `BACKUP_VERIFIED`), and the API reads the age
 * of that row. Pure functions here: no I/O, unit-testable.
 */

/** Nightly cadence (24h) plus two hours of slack for a slow dump or a late cron tick. */
export const BACKUP_MAX_AGE_HOURS = 26;

/** AuditLog.action written by the backup run after `pg_restore --list` passed. */
export const BACKUP_EVIDENCE_ACTION = 'BACKUP_VERIFIED';
/** AuditLog.action written by a restore drill that restored real rows. */
export const RESTORE_DRILL_EVIDENCE_ACTION = 'RESTORE_DRILL_VERIFIED';
export const OPS_EVIDENCE_ENTITY = 'DatabaseBackup';

export type BackupFreshnessStatus =
  /** Newest verified backup is within the window. */
  | 'fresh'
  /** Newest verified backup is older than the window - FAILING. */
  | 'stale'
  /** The database holds no evidence of any verified backup - FAILING where a backup is required. */
  | 'never'
  /** The evidence could not be read (database error). Unknown is not healthy, but is not proof of staleness. */
  | 'unknown';

export interface BackupFreshness {
  status: BackupFreshnessStatus;
  /** ISO time of the newest verified backup, if any. */
  lastVerifiedAt: string | null;
  ageHours: number | null;
  maxAgeHours: number;
  /** Name of the newest dump file (a filename, never a secret). */
  lastBackupName: string | null;
  /** Newest successful restore drill (ISO), if any - informational. */
  lastRestoreDrillAt: string | null;
}

export function evaluateBackupFreshness(
  lastVerifiedAt: Date | null,
  now: Date,
  opts: {
    maxAgeHours?: number;
    lastBackupName?: string | null;
    lastRestoreDrillAt?: Date | null;
  } = {},
): BackupFreshness {
  const maxAgeHours = opts.maxAgeHours ?? BACKUP_MAX_AGE_HOURS;
  const base = {
    maxAgeHours,
    lastBackupName: opts.lastBackupName ?? null,
    lastRestoreDrillAt: opts.lastRestoreDrillAt?.toISOString() ?? null,
  };
  if (!lastVerifiedAt) {
    return { ...base, status: 'never', lastVerifiedAt: null, ageHours: null };
  }
  const ageHours = Math.max(0, (now.getTime() - lastVerifiedAt.getTime()) / 3_600_000);
  return {
    ...base,
    status: ageHours > maxAgeHours ? 'stale' : 'fresh',
    lastVerifiedAt: lastVerifiedAt.toISOString(),
    ageHours: Math.round(ageHours * 10) / 10,
  };
}

/**
 * Does this freshness fail the health check?
 *
 * `required` is true in PRODUCTION (or when BACKUP_FRESHNESS_REQUIRED=true): a missing or stale
 * backup there is an incident. Elsewhere it is reported but does not paint the whole platform red
 * - a laptop has no nightly job. 'unknown' never fails by itself, so a transient read error cannot
 * page anyone; the DB check already fails loudly when the database is actually down.
 */
export function backupFailsHealth(f: BackupFreshness, required: boolean): boolean {
  if (!required) return false;
  return f.status === 'stale' || f.status === 'never';
}
