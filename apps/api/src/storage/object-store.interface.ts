/**
 * Where the platform's binary objects live.
 *
 * ── WHY A SEAM AND NOT JUST AN S3 CALL ─────────────────────────────────────────────
 * Event posters and organization pictures are in Postgres today, and that was the right
 * decision: Railway's filesystem is ephemeral, so a file written to disk vanishes at the next
 * release, and a 2 MB image that the browser already resized is something Postgres holds
 * without strain and backs up with everything else. `EventImage`'s own comment says where this
 * goes next — "when the catalogue outgrows that, this table is the one place to point at S3".
 *
 * It outgrows it in two ways, and neither is about storage cost. A database backup that is
 * mostly JPEGs is slow to take and slower to restore, which matters on the day it matters. And
 * every poster on a listing page is a query competing with a booking for a connection.
 *
 * So: one interface, two drivers, and a row that says which one holds its bytes. Nothing has to
 * move for the switch to be safe, because a row written before the switch still reads from
 * Postgres afterwards. See `ObjectStoreService` for how a read decides.
 *
 * ── WHY NOT A FILESYSTEM DRIVER ────────────────────────────────────────────────────
 * There is nowhere to put it. Every environment this platform runs in has an ephemeral disk,
 * and a driver that appears to work in development and silently loses files in QA is worse
 * than not having one.
 */

/** A stored object's address. Opaque to callers: only the driver interprets it. */
export type ObjectKey = string;

export interface StoredObject {
  body: Buffer;
  contentType: string;
  sizeBytes: number;
}

export interface PutObjectInput {
  key: ObjectKey;
  body: Buffer;
  contentType: string;
  /**
   * Cache lifetime for a public reader, in seconds.
   *
   * Safe to make long because every key this platform writes is content-addressed — the
   * object's own SHA-256 is in its key, so replacing a picture writes a DIFFERENT key and no
   * cache anywhere is holding a stale answer under the new address.
   */
  cacheSeconds?: number;
}

export const OBJECT_STORE = Symbol('OBJECT_STORE');

export interface ObjectStore {
  /** What this driver is, for readiness and for the row that records where bytes went. */
  readonly name: 'postgres' | 'r2';

  put(input: PutObjectInput): Promise<void>;
  get(key: ObjectKey): Promise<StoredObject | null>;
  delete(key: ObjectKey): Promise<void>;

  /**
   * A URL a browser can fetch directly, or null when the driver has none.
   *
   * Null is the normal answer for the Postgres driver and for a private bucket, and callers
   * must handle it by serving the bytes themselves. A driver never invents a URL it cannot
   * prove is reachable: a broken image is harder to diagnose than a slow one.
   */
  publicUrl(key: ObjectKey): string | null;

  /** Whether this driver can be reached right now. Never throws. */
  health(): Promise<{ healthy: boolean; detail?: string }>;
}
