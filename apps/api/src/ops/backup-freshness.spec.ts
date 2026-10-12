import {
  BACKUP_EVIDENCE_ACTION,
  BACKUP_MAX_AGE_HOURS,
  OPS_EVIDENCE_ENTITY,
  RESTORE_DRILL_EVIDENCE_ACTION,
  backupFailsHealth,
  evaluateBackupFreshness,
} from './backup-freshness';
import * as writer from '../../prisma/backup';

const NOW = new Date('2026-10-12T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('evaluateBackupFreshness', () => {
  it('is fresh inside the window and reports the age', () => {
    const f = evaluateBackupFreshness(hoursAgo(10), NOW, { lastBackupName: 'etg-x.dump' });
    expect(f.status).toBe('fresh');
    expect(f.ageHours).toBe(10);
    expect(f.lastBackupName).toBe('etg-x.dump');
  });

  it('is fresh at exactly the limit and stale just past it (26h)', () => {
    expect(evaluateBackupFreshness(hoursAgo(BACKUP_MAX_AGE_HOURS), NOW).status).toBe('fresh');
    expect(evaluateBackupFreshness(hoursAgo(BACKUP_MAX_AGE_HOURS + 0.1), NOW).status).toBe('stale');
  });

  it('is stale for the five-day gap production actually had', () => {
    const f = evaluateBackupFreshness(hoursAgo(144), NOW);
    expect(f.status).toBe('stale');
    expect(f.ageHours).toBe(144);
  });

  it('is never when no verified backup was ever recorded', () => {
    const f = evaluateBackupFreshness(null, NOW);
    expect(f.status).toBe('never');
    expect(f.lastVerifiedAt).toBeNull();
  });

  it('honours a custom window and clock skew into the future', () => {
    expect(evaluateBackupFreshness(hoursAgo(3), NOW, { maxAgeHours: 2 }).status).toBe('stale');
    expect(evaluateBackupFreshness(hoursAgo(-1), NOW).ageHours).toBe(0);
  });
});

describe('backupFailsHealth', () => {
  const stale = evaluateBackupFreshness(hoursAgo(100), NOW);
  const never = evaluateBackupFreshness(null, NOW);
  const fresh = evaluateBackupFreshness(hoursAgo(1), NOW);
  const unknown = { ...never, status: 'unknown' as const };

  it('fails stale and never only where a backup is required', () => {
    expect(backupFailsHealth(stale, true)).toBe(true);
    expect(backupFailsHealth(never, true)).toBe(true);
    expect(backupFailsHealth(stale, false)).toBe(false);
    expect(backupFailsHealth(never, false)).toBe(false);
  });

  it('never fails on fresh or on an unreadable signal', () => {
    expect(backupFailsHealth(fresh, true)).toBe(false);
    expect(backupFailsHealth(unknown, true)).toBe(false);
  });
});

describe('writer and reader agree on the evidence row', () => {
  // prisma/backup.ts cannot import from src/ (the runtime image has no src/), so the identifiers
  // are duplicated there. If they drift, the nightly backup would write rows the API never reads.
  it('uses identical action and entity names', () => {
    expect(writer.BACKUP_EVIDENCE_ACTION).toBe(BACKUP_EVIDENCE_ACTION);
    expect(writer.RESTORE_DRILL_EVIDENCE_ACTION).toBe(RESTORE_DRILL_EVIDENCE_ACTION);
    expect(writer.OPS_EVIDENCE_ENTITY).toBe(OPS_EVIDENCE_ENTITY);
  });
});
