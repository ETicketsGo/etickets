import { Inject, Injectable } from '@nestjs/common';
import { OBJECT_STORE, type ObjectStore, type StoredObject } from './object-store.interface';

/**
 * A row that may hold its own bytes, or may point at an object.
 *
 * Exactly one of the two is set — the database enforces it — and this shape is what every
 * caller passes in rather than reaching for one field and hoping.
 */
export interface StoredBytesRow {
  bytes: Buffer | Uint8Array | null;
  storageKey: string | null;
  contentType: string;
}

/**
 * Reading and writing binary objects, wherever they happen to be.
 *
 * ── WHY A READ TAKES THE ROW AND NOT A KEY ─────────────────────────────────────────
 * Because the answer depends on the row. A poster uploaded last week has its bytes in
 * Postgres; one uploaded after the switch has a key into R2; and during the backfill both
 * exist at once. A caller that had to know which would be a caller that gets it wrong on the
 * day the backfill is half done — which is every day for a while.
 *
 * So the rule lives here, once: bytes if the row has them, the object store if it has a key.
 * Nothing has to move for the switch to be safe, and the backfill can take as long as it likes.
 */
@Injectable()
export class ObjectStoreService {
  constructor(@Inject(OBJECT_STORE) private readonly store: ObjectStore) {}

  /** Which driver is active, for readiness and for logs. */
  get driver(): ObjectStore['name'] {
    return this.store.name;
  }

  /** Write an object and return the key the row should record. */
  async write(input: { key: string; body: Buffer; contentType: string }): Promise<string> {
    await this.store.put(input);
    return input.key;
  }

  /**
   * The bytes behind a row, from wherever they are.
   *
   * Returns null when a row points at an object the store does not have. That is a real
   * possibility — a bucket emptied by hand, a key written by a backfill that was rolled back —
   * and the caller turns it into a 404, which is the truth. Inventing a placeholder image here
   * would hide a data-loss incident behind a grey rectangle.
   */
  async read(row: StoredBytesRow): Promise<StoredObject | null> {
    if (row.bytes) {
      const body = Buffer.from(row.bytes);
      return { body, contentType: row.contentType, sizeBytes: body.length };
    }
    if (!row.storageKey) return null;
    return this.store.get(row.storageKey);
  }

  /**
   * A URL a browser can fetch this row's object from directly, or null.
   *
   * Null for anything still in Postgres and for any driver with no public base configured, and
   * the caller then serves the bytes itself. Every caller must handle null: it is the normal
   * answer today and stays the normal answer for private objects forever.
   */
  publicUrl(row: StoredBytesRow): string | null {
    return row.storageKey ? this.store.publicUrl(row.storageKey) : null;
  }

  /**
   * Forget an object.
   *
   * Never throws for an object that is not there. A delete that fails because the thing is
   * already gone would leave the row behind, which is the opposite of what was asked.
   */
  async remove(row: StoredBytesRow): Promise<void> {
    if (row.storageKey) await this.store.delete(row.storageKey);
  }

  health(): Promise<{ healthy: boolean; detail?: string }> {
    return this.store.health();
  }
}
