import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { isPublicKey, PRIVATE_PREFIX, PUBLIC_PREFIX } from './object-keys';
import type {
  ObjectKey,
  ObjectStore,
  PutObjectInput,
  StoredObject,
} from './object-store.interface';

/**
 * Cloudflare R2, through the S3 API.
 *
 * ── WHY R2 AND NOT S3 ──────────────────────────────────────────────────────────────
 * Egress is the whole cost of an image service. A poster is written once and read on every
 * listing page, every share and every ticket; S3 charges roughly $0.09/GB for those reads and
 * R2 charges nothing. Storage is the small number and it is cheaper too. The API is S3's
 * either way — this file would serve AWS by changing an endpoint — so the choice is reversible
 * and was made on the bill rather than on the vendor.
 *
 * ── WHY TWO BUCKETS ────────────────────────────────────────────────────────────────
 * R2 grants public access per BUCKET, not per prefix. A single bucket therefore has to be
 * either wholly public or wholly private, and the one thing that must never happen here is an
 * organizer's identity document sitting behind a guessable public URL. So `public/` and
 * `private/` keys go to different buckets, and this driver refuses a key whose prefix does not
 * match the bucket it was about to write to. Both buckets live in one R2 account, which is
 * what "one place" means operationally: one dashboard, one bill, one set of credentials.
 */
@Injectable()
export class R2ObjectStore implements ObjectStore {
  readonly name = 'r2' as const;
  private readonly logger = new Logger(R2ObjectStore.name);
  private readonly client: S3Client;
  private readonly publicBucket: string;
  private readonly privateBucket: string;
  private readonly publicBaseUrl: string | null;

  constructor(config: ConfigService) {
    const accountId = config.getOrThrow<string>('R2_ACCOUNT_ID');
    this.publicBucket = config.getOrThrow<string>('R2_PUBLIC_BUCKET');
    this.privateBucket = config.getOrThrow<string>('R2_PRIVATE_BUCKET');
    /*
      The public base URL is optional and its absence is not an error.

      Without it the API serves the bytes itself, which is correct and merely slower. With it
      the API can hand out a CDN address and stop proxying images entirely. Making it required
      would mean no R2 at all until a custom domain is wired up, which is the wrong order:
      getting the bytes out of the database is the urgent half.
    */
    const base = (config.get<string>('R2_PUBLIC_BASE_URL') ?? '').trim();
    this.publicBaseUrl = base ? base.replace(/\/+$/, '') : null;

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.getOrThrow<string>('R2_ACCESS_KEY_ID'),
        secretAccessKey: config.getOrThrow<string>('R2_SECRET_ACCESS_KEY'),
      },
    });
  }

  /**
   * Which bucket a key belongs in, refusing the mismatch rather than guessing.
   *
   * This is the check that stops a private document reaching a public bucket. It is here, at
   * the last moment before the network call, because that is the one place every write must
   * pass through — a check at the call site can be forgotten by the next call site.
   */
  private bucketFor(key: ObjectKey): string {
    if (isPublicKey(key)) return this.publicBucket;
    if (key.startsWith(PRIVATE_PREFIX)) return this.privateBucket;
    throw new Error(
      `Object key must start with "${PUBLIC_PREFIX}" or "${PRIVATE_PREFIX}" so its visibility ` +
        `is explicit; got ${JSON.stringify(key)}. See object-keys.ts.`,
    );
  }

  async put(input: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketFor(input.key),
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        // Long, because the key contains the content hash: different bytes are a different
        // key, so nothing cached under this one can ever be stale.
        CacheControl: `public, max-age=${input.cacheSeconds ?? 31_536_000}, immutable`,
      }),
    );
  }

  async get(key: ObjectKey): Promise<StoredObject | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketFor(key), Key: key }),
      );
      if (!res.Body) return null;
      const body = Buffer.from(await res.Body.transformToByteArray());
      return {
        body,
        contentType: res.ContentType ?? 'application/octet-stream',
        sizeBytes: body.length,
      };
    } catch (error) {
      // A missing object is an answer, not a failure: the caller decides whether a gap is a
      // 404 or a fall back to the bytes still held in Postgres.
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: ObjectKey): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketFor(key), Key: key }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  publicUrl(key: ObjectKey): string | null {
    // Only ever for the public bucket, and only when a reachable base is configured. A URL
    // built for a private key would be a link to a 403 at best.
    if (!this.publicBaseUrl || !isPublicKey(key)) return null;
    return `${this.publicBaseUrl}/${key}`;
  }

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      await Promise.all([
        this.client.send(new HeadBucketCommand({ Bucket: this.publicBucket })),
        this.client.send(new HeadBucketCommand({ Bucket: this.privateBucket })),
      ]);
      return { healthy: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`R2 health check failed: ${detail}`);
      // Never the credentials, never the account id — this string reaches an admin screen.
      return { healthy: false, detail: 'R2 buckets are not reachable with the configured keys.' };
    }
  }
}

/** S3 says "not found" in more than one way depending on the operation. */
function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NoSuchKey' ||
    e?.name === 'NotFound' ||
    e?.Code === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404
  );
}
