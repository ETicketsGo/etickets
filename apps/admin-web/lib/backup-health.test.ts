import { describe, expect, it } from 'vitest';
import { backupHealthView } from './backup-health';

const fmt = (iso: string) => iso.slice(0, 16);
const base = {
  lastVerifiedAt: null,
  ageHours: null,
  maxAgeHours: 26,
  lastBackupName: null,
  lastRestoreDrillAt: null,
};

describe('backupHealthView', () => {
  it('shows no tile for an older API that sends no backup field', () => {
    expect(backupHealthView(undefined, fmt)).toBeNull();
  });

  it('does not claim "no backups" when only the evidence row is missing', () => {
    // QA and PROD: nightly dumps verified, but db-seed runs code that writes no evidence row.
    const v = backupHealthView({ ...base, status: 'never' }, fmt)!;
    expect(v.label).toBe('No evidence');
    expect(v.tone).toBe('warning');
    expect(v.detail).not.toMatch(/no backup (has|was) (ever )?been taken/i);
    expect(v.note).toMatch(/db-seed logs/);
  });

  it('names the newest verified dump and its age when fresh', () => {
    const v = backupHealthView(
      {
        ...base,
        status: 'fresh',
        lastVerifiedAt: '2026-10-14T02:01:13.000Z',
        ageHours: 2.4,
        lastBackupName: 'etg-qa-2026-10-14T02-01-13-267Z.dump',
      },
      fmt,
    )!;
    expect(v.tone).toBe('success');
    expect(v.detail).toContain('etg-qa-2026-10-14T02-01-13-267Z.dump');
    expect(v.detail).toContain('2 hours ago');
    expect(v.note).toBe('No restore drill recorded.');
  });

  it('marks a stale backup as an error and says the window', () => {
    const v = backupHealthView(
      { ...base, status: 'stale', lastVerifiedAt: '2026-10-10T02:00:00.000Z', ageHours: 96 },
      fmt,
    )!;
    expect(v.tone).toBe('error');
    expect(v.note).toMatch(/Older than 26 hours/);
  });

  it('keeps an unreadable record neutral', () => {
    expect(backupHealthView({ ...base, status: 'unknown' }, fmt)!.tone).toBe('neutral');
  });
});
