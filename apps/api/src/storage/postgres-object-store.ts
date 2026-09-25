import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  ObjectKey,
  ObjectStore,
  PutObjectInput,
  StoredObject,
} from './object-store.interface';

/**
 * The database, which is where every object lives until R2 is configured.
 *
 * ── WHY THIS IS A REAL DRIVER AND NOT A STUB ───────────────────────────────────────
 * It is the default, and it is what every environment runs today. Writing it as a proper
 * driver rather than a special case means the switch to R2 changes one variable instead of
 * changing which code path runs, and it means the seam is exercised by the whole test suite
 * rather than only by whoever remembers to configure a bucket.
 *
 * ── WHY ITS OWN TABLE ──────────────────────────────────────────────────────────────
 * `EventImage` and `OrganizationImage` keep their own rows and their own bytes; this table is
 * only for objects written THROUGH the seam while Postgres is the active driver. Those two
 * tables are read directly by code that predates this module, and quietly moving their bytes
 * somewhere else would break those reads for no benefit — the backfill moves them to R2, which
 * is the move worth making.
 */
@Injectable()
export class PostgresObjectStore implements ObjectStore {
  readonly name = 'postgres' as const;

  constructor(private readonly prisma: PrismaService) {}

  async put(input: PutObjectInput): Promise<void> {
    await this.prisma.storedObject.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        bytes: input.body,
        contentType: input.contentType,
        sizeBytes: input.body.length,
      },
      // A content-addressed key means the same key always carries the same bytes, so an
      // upsert is a no-op rewrite rather than a change. It exists so a retried upload is
      // harmless instead of a unique-constraint error.
      update: { bytes: input.body, contentType: input.contentType, sizeBytes: input.body.length },
    });
  }

  async get(key: ObjectKey): Promise<StoredObject | null> {
    const row = await this.prisma.storedObject.findUnique({ where: { key } });
    if (!row) return null;
    return { body: Buffer.from(row.bytes), contentType: row.contentType, sizeBytes: row.sizeBytes };
  }

  async delete(key: ObjectKey): Promise<void> {
    await this.prisma.storedObject.deleteMany({ where: { key } });
  }

  /**
   * Always null: there is no address a browser could fetch this from.
   *
   * The caller serves the bytes through the API, which is exactly what happens today.
   */
  publicUrl(): string | null {
    return null;
  }

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { healthy: true };
    } catch {
      return { healthy: false, detail: 'The database is not reachable.' };
    }
  }
}
