import { mkdtempSync, rmSync, writeFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasRecentBackup, listBackups, prune } from '../../prisma/backup';

/**
 * Recovery-point bookkeeping.
 *
 * ── WHY THE RETENTION RULES MATTER AS MUCH AS THE DUMP ─────────────────────────────
 * `takeBackup` is a pg_dump call and is proved by using it. What can quietly go wrong is
 * everything around it: pruning that deletes the newest instead of the oldest, an age check
 * that reads a stale file as fresh, a listing that ignores a file because of its name. Each of
 * those turns "we have backups" into "we thought we had backups", which is the state QA was
 * actually in — a backup count of zero that nobody had looked at.
 */
let dir: string;

const write = (name: string, ageMinutes = 0, bytes = 100) => {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes));
  const when = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(path, when, when);
  return path;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'etg-backup-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('listing recovery points', () => {
  it('returns them newest first', () => {
    write('etg-qa-old.dump', 300);
    write('etg-qa-new.dump', 1);
    write('etg-qa-middle.dump', 60);
    expect(listBackups(dir).map((b) => b.name)).toEqual([
      'etg-qa-new.dump',
      'etg-qa-middle.dump',
      'etg-qa-old.dump',
    ]);
  });

  it('ignores files that are not dumps', () => {
    write('etg-qa-real.dump');
    write('notes.txt');
    write('etg-qa-partial.dump.tmp');
    expect(listBackups(dir).map((b) => b.name)).toEqual(['etg-qa-real.dump']);
  });

  it('reports an empty directory rather than throwing', () => {
    expect(listBackups(dir)).toEqual([]);
  });

  it('reports a directory that does not exist as empty, not as an error', () => {
    // The destructive path asks this question before deciding whether to proceed. Throwing
    // here would be indistinguishable from a crash, and a crash is not a "no".
    expect(listBackups(join(dir, 'nope'))).toEqual([]);
  });
});

describe('is there something recent enough to destroy against', () => {
  it('accepts a backup inside the window', () => {
    write('etg-qa-fresh.dump', 5);
    expect(hasRecentBackup(60, dir)?.name).toBe('etg-qa-fresh.dump');
  });

  it('REFUSES a backup older than the window', () => {
    // A week-old backup is a fine disaster-recovery story and a poor answer to "I am about to
    // empty this database on purpose".
    write('etg-qa-stale.dump', 60 * 24 * 7);
    expect(hasRecentBackup(60, dir)).toBeNull();
  });

  it('refuses when there is nothing at all', () => {
    expect(hasRecentBackup(60, dir)).toBeNull();
  });

  it('judges by the NEWEST, not by whichever it happens to read first', () => {
    write('etg-qa-ancient.dump', 60 * 24 * 30);
    write('etg-qa-fresh.dump', 2);
    expect(hasRecentBackup(60, dir)?.name).toBe('etg-qa-fresh.dump');
  });
});

describe('pruning', () => {
  it('keeps the newest and deletes the oldest', () => {
    // Backwards pruning is the failure that leaves you holding only backups too old to want.
    for (let i = 0; i < 20; i++) write(`etg-qa-${String(i).padStart(2, '0')}.dump`, i * 60);
    const removed = prune(dir);
    const left = listBackups(dir).map((b) => b.name);
    expect(left).toHaveLength(14);
    expect(left[0]).toBe('etg-qa-00.dump');
    expect(removed).toHaveLength(6);
    expect(removed).toContain('etg-qa-19.dump');
    expect(removed).not.toContain('etg-qa-00.dump');
  });

  it('does nothing when there are fewer than the retention count', () => {
    write('etg-qa-a.dump', 10);
    write('etg-qa-b.dump', 20);
    expect(prune(dir)).toEqual([]);
    expect(listBackups(dir)).toHaveLength(2);
  });

  it('leaves files it does not recognise alone', () => {
    for (let i = 0; i < 20; i++) write(`etg-qa-${String(i).padStart(2, '0')}.dump`, i * 60);
    write('do-not-delete-me.txt');
    prune(dir);
    expect(readdirSync(dir)).toContain('do-not-delete-me.txt');
  });
});
