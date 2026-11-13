/* eslint-disable no-console */
/**
 * Prove the OFF-PLATFORM copy restores, from a machine that is not Railway.
 *
 * The in-Railway `restore-drill` proves the volume's dumps restore. It cannot prove the disaster
 * case the off-platform copy exists for: Railway (project, account, region) gone. This runs
 * anywhere with Node, the Postgres 16 client tools and READ-ONLY bucket credentials, e.g. the
 * owner's laptop or a CI job:
 *
 *   1. finds the newest object for the environment under the prefix
 *   2. downloads it and checks its SHA-256 against what the uploader recorded
 *   3. decrypts it with BACKUP_OFFSITE_ENCRYPTION_KEY (the copy in the password manager)
 *   4. `pg_restore --list` (the archive is readable and complete)
 *   5. optionally restores into RESTORE_DRILL_DATABASE_URL and counts rows in the core tables.
 *      That database must be EMPTY: the drill refuses one that already holds tables, so it can
 *      never be pointed at a live database by mistake.
 *   6. deletes every temporary file, decrypted dump included, whatever happened
 *
 * Prints counts and timings only. Never a row, never a URL, never a key.
 *
 *   BACKUP_OFFSITE_BUCKET=... BACKUP_OFFSITE_ENDPOINT=... AWS_ACCESS_KEY_ID=<read-only> \
 *   AWS_SECRET_ACCESS_KEY=... BACKUP_OFFSITE_ENCRYPTION_KEY=... DRILL_ENV=production \
 *   [RESTORE_DRILL_DATABASE_URL=postgresql://.../empty_scratch] \
 *   npx ts-node --transpile-only prisma/offsite-restore-drill.ts
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { makeClient, offsiteConfig } from './backup-offsite';
import { decryptFile, parseBackupKey } from './backup-crypto';

/** Tables whose row counts show the restore carried real data, not just a schema. */
export const CORE_TABLES = [
  'User',
  'Organization',
  'Event',
  'Booking',
  'Payment',
  'Refund',
  'Ticket',
];

export interface ListedObject {
  Key?: string;
  LastModified?: Date;
}

/** The newest dump object for an environment (encrypted or not), by the timestamp in its name. */
export function newestBackup(objects: ListedObject[], env: string): string | null {
  const re = new RegExp(`/etg-${env}-(\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z)\\.dump(\\.enc)?$`, 'i');
  const hits = objects
    .map((o) => ({ key: o.Key ?? '', m: re.exec(o.Key ?? '') }))
    .filter((x) => x.m)
    .sort((a, b) => (a.m![1] < b.m![1] ? 1 : a.m![1] > b.m![1] ? -1 : 0));
  return hits[0]?.key ?? null;
}

const sha256 = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });

async function listAll(client: S3Client, bucket: string, prefix: string): Promise<ListedObject[]> {
  const out: ListedObject[] = [];
  let token: string | undefined;
  do {
    const r = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    out.push(...(r.Contents ?? []));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export async function offsiteRestoreDrill(env: NodeJS.ProcessEnv = process.env) {
  const cfg = offsiteConfig(env);
  if (!cfg) throw new Error('BACKUP_OFFSITE_BUCKET is not set');
  const drillEnv = (env.DRILL_ENV ?? 'production').trim().toLowerCase();
  const key = parseBackupKey(env.BACKUP_OFFSITE_ENCRYPTION_KEY);
  const target = env.RESTORE_DRILL_DATABASE_URL?.trim() || null;
  const t0 = Date.now();
  const client = makeClient(cfg, env);
  const work = mkdtempSync(join(tmpdir(), 'etg-offsite-drill-'));
  try {
    const objects = await listAll(client, cfg.bucket, `${cfg.prefix}/${drillEnv}/`);
    const objectKey = newestBackup(objects, drillEnv);
    if (!objectKey) throw new Error(`no backup objects for ${drillEnv} under the prefix`);

    const got = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: objectKey }));
    const downloaded = join(work, 'download');
    await pipeline(got.Body as Readable, createWriteStream(downloaded, { mode: 0o600 }));
    const expected = got.Metadata?.sha256;
    const actual = await sha256(downloaded);
    if (expected && expected !== actual)
      throw new Error('downloaded bytes do not match the recorded SHA-256');

    let dump = downloaded;
    const encrypted = objectKey.endsWith('.enc');
    if (encrypted) {
      if (!key)
        throw new Error('the backup is encrypted and BACKUP_OFFSITE_ENCRYPTION_KEY is not set');
      dump = join(work, 'restored.dump');
      await decryptFile(downloaded, dump, key);
      const source = got.Metadata?.['source-sha256'];
      if (source && source !== (await sha256(dump))) {
        throw new Error('decrypted dump does not match the source SHA-256 recorded at upload');
      }
    }

    const toc = execFileSync('pg_restore', ['--list', dump], { maxBuffer: 256 << 20 }).toString();
    const tocEntries = toc.split('\n').filter((l) => /^\d+;/.test(l)).length;

    let rows: Record<string, number> | null = null;
    if (target) {
      const psql = (sql: string) =>
        execFileSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', target, '-c', sql])
          .toString()
          .trim();
      const existing = Number(
        psql(`select count(*) from information_schema.tables where table_schema = 'public'`),
      );
      if (existing > 0) {
        throw new Error(
          `refusing: the restore target already holds ${existing} tables; give an EMPTY database`,
        );
      }
      execFileSync('pg_restore', [
        '--no-owner',
        '--no-privileges',
        '--exit-on-error',
        '-d',
        target,
        dump,
      ]);
      rows = {};
      for (const t of CORE_TABLES) rows[t] = Number(psql(`select count(*) from "${t}"`));
    }

    const result = {
      ok: true,
      object: objectKey.split('/').slice(-1)[0],
      encrypted,
      bytes: statSync(downloaded).size,
      tocEntries,
      restoredRows: rows,
      seconds: Math.round((Date.now() - t0) / 1000),
    };
    console.log(`OFFSITE_RESTORE_DRILL_JSON ${JSON.stringify(result)}`);
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (require.main === module) {
  offsiteRestoreDrill().catch((e) => {
    console.error(
      `offsite restore drill FAILED: ${(e as Error).message.replace(/https?:\/\/\S+/g, '[url]')}`,
    );
    process.exit(1);
  });
}
