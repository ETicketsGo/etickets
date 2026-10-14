import type { BadgeTone, OpsBackupFreshness } from '@eticketsgo/web-kit';

/**
 * What the Operations page says about database backups, from the `backup` field that
 * GET /admin/ops/health already returns. Wording only: whether health is degraded is the API's.
 *
 * ── WHY "NEVER" IS NOT WRITTEN AS "NO BACKUPS" ─────────────────────────────────────
 * The API cannot see the backup volume. It reads a BACKUP_VERIFIED row that the nightly db-seed
 * job writes after `pg_restore --list` passes - and only db-seed code from d3287f8 (2026-10-11)
 * on writes it. QA and PROD db-seed ran older code, so they took and verified a dump every night
 * while this field said "never". Telling an operator "no backup has ever been taken" would send
 * them after the wrong problem; the honest sentence is that no evidence is recorded, and where to
 * look instead. docs/deployment/RAILWAY_BACKUP_RECOVERY.md section 12 has the deploy steps that
 * make the row appear.
 */
export interface BackupHealthView {
  label: string;
  tone: BadgeTone;
  /** One line under the label: when, and which file. */
  detail: string;
  /** Present when the operator has something to check. */
  note: string | null;
}

const hours = (h: number | null) =>
  h == null ? '' : h < 1 ? 'less than an hour ago' : `${Math.round(h)} hours ago`;

export function backupHealthView(
  b: OpsBackupFreshness | undefined,
  formatTime: (iso: string) => string,
): BackupHealthView | null {
  // An older API sends no `backup` field; then the page shows no tile rather than a guess.
  if (!b) return null;
  const drill = b.lastRestoreDrillAt
    ? `Last restore drill ${formatTime(b.lastRestoreDrillAt)}.`
    : 'No restore drill recorded.';
  switch (b.status) {
    case 'fresh':
    case 'stale': {
      const when = b.lastVerifiedAt ? `${formatTime(b.lastVerifiedAt)} (${hours(b.ageHours)})` : '';
      return {
        label: b.status === 'fresh' ? 'Fresh' : 'Stale',
        tone: b.status === 'fresh' ? 'success' : 'error',
        detail: `Last verified backup ${when}${b.lastBackupName ? `: ${b.lastBackupName}` : ''}.`,
        note:
          b.status === 'stale'
            ? `Older than ${b.maxAgeHours} hours. Check the db-seed logs for last night's run. ${drill}`
            : drill,
      };
    }
    case 'never':
      return {
        label: 'No evidence',
        tone: 'warning',
        detail: 'No verified backup is recorded in the database.',
        note:
          'The nightly backup job records each verified backup here only from the 2026-10-11 release (commit d3287f8) on. ' +
          'An older job can still be taking backups that this page cannot see: check the db-seed ' +
          'logs for "backup written" and "verified yes".',
      };
    default:
      return {
        label: 'Unknown',
        tone: 'neutral',
        detail: 'The backup record could not be read.',
        note: null,
      };
  }
}
