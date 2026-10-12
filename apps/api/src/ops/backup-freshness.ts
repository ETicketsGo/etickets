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
/**
 * AuditLog.action written after the OPTIONAL off-platform copy of a dump was accepted by the store
 * (prisma/backup-offsite.ts). Duplicated there on purpose; backup-offsite.spec.ts pins the pair.
 */
export const OFFSITE_BACKUP_EVIDENCE_ACTION = 'BACKUP_OFFSITE_UPLOADED';

export type BackupFreshnessStatus =
  /** Newest verified backup is within the window. */
  | 'fresh'
  /** Newest verified backup is older than the window - FAILING. */
  | 'stale'
  /** The database holds no evidence of any verified backup - FAILING where a backup is required. */
  | 'never'
  /** The evidence could not be read (database error). Unknown is not healthy, but is not proof of staleness. */
  | 'unknown';

/**
 * Freshness of the off-platform copy. Present on BackupFreshness ONLY when the operator configured
 * one (BACKUP_OFFSITE_BUCKET); with it unset the field is absent and nothing else changes.
 */
export interface OffsiteFreshness {
  status: BackupFreshnessStatus;
  lastUploadedAt: string | null;
  ageHours: number | null;
  maxAgeHours: number;
  /** Object key of the newest accepted upload (a path, never a secret). */
  lastKey: string | null;
}

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
  /** Only when an off-platform copy is configured. */
  offsite?: OffsiteFreshness;
}

export function evaluateOffsiteFreshness(
  lastUploadedAt: Date | null,
  now: Date,
  opts: { maxAgeHours?: number; lastKey?: string | null } = {},
): OffsiteFreshness {
  const maxAgeHours = opts.maxAgeHours ?? BACKUP_MAX_AGE_HOURS;
  const lastKey = opts.lastKey ?? null;
  if (!lastUploadedAt) {
    return { status: 'never', lastUploadedAt: null, ageHours: null, maxAgeHours, lastKey };
  }
  const ageHours = Math.max(0, (now.getTime() - lastUploadedAt.getTime()) / 3_600_000);
  return {
    status: ageHours > maxAgeHours ? 'stale' : 'fresh',
    lastUploadedAt: lastUploadedAt.toISOString(),
    ageHours: Math.round(ageHours * 10) / 10,
    maxAgeHours,
    lastKey,
  };
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
  if (offsiteFailsHealth(f, required)) return true;
  if (!required) return false;
  return f.status === 'stale' || f.status === 'never';
}

/**
 * Does a CONFIGURED off-platform copy fail the health check?
 *
 * Configuring one is an explicit promise, so a stale copy degrades health in every environment
 * that configured it. 'never' only fails where backups are required: right after the operator
 * sets the variables there is no upload until the next nightly run, and that grace must not page
 * anyone in QA. An unreadable row ('unknown') never fails, as for the local backup. Unset means
 * no `offsite` field, and this returns false: behaviour without the feature is unchanged.
 */
export function offsiteFailsHealth(f: BackupFreshness, required: boolean): boolean {
  if (!f.offsite) return false;
  return f.offsite.status === 'stale' || (required && f.offsite.status === 'never');
}
