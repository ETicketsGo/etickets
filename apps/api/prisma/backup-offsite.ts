/* eslint-disable no-console */
/**
 * An OPTIONAL copy of each verified recovery point, in storage that is not Railway.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * Every dump `backup.ts` takes lives on a volume of the same Railway project as the database it
 * protects. Losing the project, the account or the volume loses the data and every backup of it
 * together. This file puts one more copy somewhere that fails independently (S3 in ap-south-1 is
 * the expected choice; any S3-compatible store works through BACKUP_OFFSITE_ENDPOINT).
 *
 * ── THE RULES THIS FILE KEEPS ──────────────────────────────────────────────────────
 * 1. OFF unless BACKUP_OFFSITE_BUCKET is set. With it unset nothing here touches the network.
 * 2. It only ever runs AFTER the local dump verified, and it never touches the local file except
 *    to read it. A failed upload cannot delete, rename or invalidate the local recovery point.
 * 3. It never throws. The caller has a good local backup in hand; the upload is an addition, and
 *    "the extra copy failed" must not turn into "the backup run failed".
 * 4. It never deletes or overwrites remote objects. The key is unique per dump (the file name
 *    carries a timestamp) AND the request carries `If-None-Match: *`, so even a re-run cannot
 *    replace an object. Retention is the bucket's lifecycle rule, owned by the operator.
 * 5. Integrity is checked by the STORE, not by us: the SHA-256 of the file is sent as the
 *    object checksum, and S3 rejects the upload (BadDigest) if the bytes it received differ.
 *
 * The runtime image copies apps/api/prisma but NOT apps/api/src, so this file imports nothing
 * from '../src'. Its evidence-row constants are duplicated in src/ops/backup-freshness.ts and
 * pinned together by backup-offsite.spec.ts.
 */
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { recordOpsEvidence } from './backup';

/** MUST equal OFFSITE_BACKUP_EVIDENCE_ACTION in src/ops/backup-freshness.ts. */
export const OFFSITE_BACKUP_EVIDENCE_ACTION = 'BACKUP_OFFSITE_UPLOADED';

/** Stable code to grep for in the logs. */
export const OFFSITE_FAILED_CODE = 'BACKUP_OFFSITE_FAILED';

export type OffsiteStatus = 'disabled' | 'uploaded' | 'exists' | 'failed';

export interface OffsiteResult {
  status: OffsiteStatus;
  key: string | null;
  sha256: string | null;
  bytes: number | null;
  /** Short, secret-free reason when status is 'failed'. */
  error?: string;
}

export interface OffsiteConfig {
  bucket: string;
  region: string;
  /** Always ends without a trailing slash; empty means the bucket root. */
  prefix: string;
  endpoint: string | null;
  /** 'AES256' (default), 'aws:kms', or null when the operator opted out for a store without SSE. */
  sse: 'AES256' | 'aws:kms' | null;
  kmsKeyId: string | null;
}

/** Null means "not configured": the feature is off and nothing else in this file runs. */
export function offsiteConfig(env: NodeJS.ProcessEnv = process.env): OffsiteConfig | null {
  const bucket = env.BACKUP_OFFSITE_BUCKET?.trim();
  if (!bucket) return null;
  const kmsKeyId = env.BACKUP_OFFSITE_KMS_KEY_ID?.trim() || null;
  const sseSetting = (env.BACKUP_OFFSITE_SSE ?? '').trim().toLowerCase();
  let sse: OffsiteConfig['sse'] = 'AES256';
  if (sseSetting === 'none') sse = null;
  else if (kmsKeyId || sseSetting === 'aws:kms' || sseSetting === 'kms') sse = 'aws:kms';
  return {
    bucket,
    region: env.BACKUP_OFFSITE_REGION?.trim() || env.AWS_REGION?.trim() || 'ap-south-1',
    prefix: (env.BACKUP_OFFSITE_PREFIX ?? 'etg-db-backups').trim().replace(/^\/+|\/+$/g, ''),
    endpoint: env.BACKUP_OFFSITE_ENDPOINT?.trim() || null,
    sse,
    kmsKeyId: sse === 'aws:kms' ? kmsKeyId : null,
  };
}

/**
 * The object key. The dump's own name already carries the environment and an ISO timestamp, so
 * the key is unique per run; it is nested under the prefix by environment and UTC date so a
 * lifecycle rule or a human browsing the bucket can scope by either.
 */
export function offsiteKey(prefix: string, fileName: string): string {
  const name = basename(fileName);
  const m = /^etg-([a-z0-9_]+)-(\d{4}-\d{2}-\d{2})T/i.exec(name);
  const parts = [prefix, m ? m[1].toLowerCase() : 'unknown', m ? m[2] : 'undated', name];
  return parts.filter((p) => p !== '').join('/');
}

/** SHA-256 of a file, streamed so a large dump is never held in memory. */
export function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Never put a credential or a URL in a log line, whatever the SDK put in its message. */
function scrub(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/AKIA[0-9A-Z]{12,}/g, '[key-id]')
    .slice(0, 300);
}

export function makeClient(cfg: OffsiteConfig, env: NodeJS.ProcessEnv = process.env): S3Client {
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  return new S3Client({
    region: cfg.region,
    // The standard AWS_* variables of a WRITE-ONLY principal. Handed over directly when both are
    // set (no profile or metadata lookups in a container); otherwise the SDK's default chain
    // applies, so an attached IAM role works too. Neither value is ever logged.
    ...(accessKeyId && secretAccessKey
      ? {
          credentials: {
            accessKeyId,
            secretAccessKey,
            ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
          },
        }
      : {}),
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    maxAttempts: 1, // retries are ours, below, because each attempt needs a fresh stream
  });
}

interface SendClient {
  send(command: PutObjectCommand): Promise<unknown>;
}

const ATTEMPTS = 3;

/**
 * Upload one verified dump. Resolves with the outcome and NEVER rejects.
 *
 * `client` is injectable for tests. A `uploaded` outcome also leaves an evidence row in the
 * database so the API's freshness signal can report the offsite copy's age; `exists` (the
 * store refused to overwrite) deliberately does not, since nothing new reached the store.
 */
export async function uploadOffsite(
  file: { name: string; path: string },
  opts: { env?: NodeJS.ProcessEnv; client?: SendClient; retryDelayMs?: number } = {},
): Promise<OffsiteResult> {
  const cfg = offsiteConfig(opts.env ?? process.env);
  if (!cfg) return { status: 'disabled', key: null, sha256: null, bytes: null };

  let key: string | null = null;
  let sha256: string | null = null;
  let bytes: number | null = null;
  try {
    key = offsiteKey(cfg.prefix, file.name);
    bytes = statSync(file.path).size;
    sha256 = await sha256OfFile(file.path);
    const client = opts.client ?? makeClient(cfg, opts.env ?? process.env);

    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const body = createReadStream(file.path);
      // An error on a stream the SDK never got to read must not become an unhandled event.
      body.on('error', () => undefined);
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: cfg.bucket,
            Key: key,
            // A fresh stream per attempt: a consumed one cannot be resent.
            Body: body,
            ContentLength: bytes,
            ContentType: 'application/octet-stream',
            // The store recomputes SHA-256 over what it received and rejects a mismatch.
            ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
            // Never replace an existing object (the key is unique anyway; this is the backstop).
            IfNoneMatch: '*',
            Metadata: {
              sha256,
              'source-bytes': String(bytes),
              'source-name': basename(file.name),
            },
            ...(cfg.sse
              ? {
                  ServerSideEncryption: cfg.sse,
                  ...(cfg.kmsKeyId ? { SSEKMSKeyId: cfg.kmsKeyId } : {}),
                }
              : {}),
          }),
        );
        body.destroy();
        recordOpsEvidence(OFFSITE_BACKUP_EVIDENCE_ACTION, file.name, { key, sha256, bytes });
        return { status: 'uploaded', key, sha256, bytes };
      } catch (e) {
        body.destroy();
        const err = e as {
          name?: string;
          $metadata?: { httpStatusCode?: number };
          message?: string;
        };
        const http = err.$metadata?.httpStatusCode;
        if (http === 412 || err.name === 'PreconditionFailed') {
          // The object is already there. We did not replace it, and that is the point.
          return { status: 'exists', key, sha256, bytes };
        }
        lastError = scrub(
          `${err.name ?? 'Error'}${http ? ` (${http})` : ''}: ${err.message ?? ''}`,
        );
        // A rejected checksum, bad credentials or a missing bucket will not improve on retry.
        const permanent =
          http !== undefined && http >= 400 && http < 500 && http !== 408 && http !== 429;
        if (permanent || attempt === ATTEMPTS) break;
        await new Promise((r) => setTimeout(r, (opts.retryDelayMs ?? 2000) * attempt));
      }
    }
    return failed(key, sha256, bytes, lastError);
  } catch (e) {
    return failed(key, sha256, bytes, scrub((e as Error).message ?? String(e)));
  }
}

function failed(
  key: string | null,
  sha256: string | null,
  bytes: number | null,
  error: string,
): OffsiteResult {
  console.error(
    `ERROR ${OFFSITE_FAILED_CODE} the local backup is intact and verified; the off-platform copy was NOT made: ${error}`,
  );
  return { status: 'failed', key, sha256, bytes, error };
}
