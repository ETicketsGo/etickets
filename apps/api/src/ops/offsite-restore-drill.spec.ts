import { newestBackup } from '../../prisma/offsite-restore-drill';

describe('choosing what the off-platform drill restores', () => {
  const k = (env: string, ts: string, enc = true) => ({
    Key: `etg-db-backups/${env}/${ts.slice(0, 10)}/etg-${env}-${ts}.dump${enc ? '.enc' : ''}`,
  });

  it('takes the newest dump of the named environment, encrypted or not', () => {
    const objects = [
      k('production', '2026-11-10T02-00-01-000Z'),
      k('production', '2026-11-12T02-00-01-000Z', false),
      k('production', '2026-11-11T02-00-01-000Z'),
      k('qa', '2026-11-13T02-00-01-000Z'),
      { Key: 'etg-db-backups/production/2026-11-14/notes.txt' },
    ];
    expect(newestBackup(objects, 'production')).toBe(objects[1].Key);
    expect(newestBackup(objects, 'qa')).toBe(objects[3].Key);
  });

  it('finds nothing rather than a wrong environment', () => {
    expect(newestBackup([k('qa', '2026-11-13T02-00-01-000Z')], 'production')).toBeNull();
    expect(newestBackup([], 'production')).toBeNull();
  });
});
