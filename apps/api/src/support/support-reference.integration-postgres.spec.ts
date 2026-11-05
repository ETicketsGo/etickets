import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FeedbackKind } from '@eticketsgo/shared-types';
import { SupportService } from './support.service';
import { assignSupportReference } from './support-reference';

/**
 * integration-real-postgres: readable support references against the migrated schema.
 *
 * What only a real database can show: that the counter hands out distinct, consecutive numbers
 * to concurrent requests; that the year restarts the sequence at the UTC boundary; that the
 * trigger numbers an insert that names no reference (the API before this change); and that
 * the migration's backfill numbers old rows per year, continues after numbers already used,
 * and assigns nothing when run again.
 *
 * Everything that is not a plain create runs in a transaction that is rolled back, so no
 * counter or row from it survives. Skips (never fabricates a pass) without a database.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../../.env', '../../../../../.env']) {
    try {
      const txt = readFileSync(resolve(__dirname, p), 'utf8');
      const m = txt.match(/^DATABASE_URL=(.*)$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

/** Thrown at the end of a transaction to roll it back once its assertions have run. */
class Rollback extends Error {}

/** The backfill statements, exactly as the migration runs them. */
function backfillStatements(): string[] {
  const sql = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261025120000_support_request_reference/migration.sql',
    ),
    'utf8',
  );
  const section = sql.split('-- BACKFILL BEGIN')[1].split('-- BACKFILL END')[0];
  return section
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const SEQ = (ref: string) => Number(ref.split('-')[3]);

describe('integration-real-postgres: readable support references', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  const suffix = `ref-${Date.now()}`;

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED -- no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED -- DB unavailable');
    }
  }, 60_000);

  afterAll(async () => {
    if (db && available) {
      await db.feedback.deleteMany({ where: { email: { contains: suffix } } });
    }
    await db?.$disconnect();
  });

  const maybe = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  /** Runs `fn` in a transaction and rolls it back, rethrowing anything but the rollback. */
  async function inRolledBackTx(fn: (tx: Tx) => Promise<void>) {
    await db!
      .$transaction(
        async (tx: Tx) => {
          await fn(tx);
          throw new Rollback();
        },
        { timeout: 30_000 },
      )
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
  }

  maybe('20 concurrent submissions get 20 distinct, consecutive references', async () => {
    const service = new SupportService(db as never);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        service.submit(undefined, {
          kind: FeedbackKind.GENERAL,
          email: `parallel-${i}-${suffix}@walk.eticketsgo.com`,
          message: `parallel ${i} ${suffix}`,
        }),
      ),
    );
    const refs = results.map((r) => r.reference!);
    expect(new Set(refs).size).toBe(20);
    expect(new Set(results.map((r) => r.id)).size).toBe(20);
    const year = new Date().getUTCFullYear();
    for (const ref of refs) expect(ref).toMatch(new RegExp(`^ETG-SUP-${year}-\\d{6,}$`));
    const seqs = refs.map(SEQ).sort((a, b) => a - b);
    expect(seqs[19] - seqs[0]).toBe(19);

    // Stored as returned, and the year in each matches the row's own createdAt (UTC).
    const stored = await db!.feedback.findMany({
      where: { id: { in: results.map((r) => r.id) } },
      select: { reference: true, createdAt: true },
    });
    for (const row of stored) {
      expect(row.reference!.split('-')[2]).toBe(String(row.createdAt.getUTCFullYear()));
    }
  });

  maybe('the reference is unique, and the database refuses any other shape', async () => {
    const service = new SupportService(db as never);
    const first = await service.submit(undefined, {
      kind: FeedbackKind.GENERAL,
      email: `unique-${suffix}@walk.eticketsgo.com`,
      message: `unique ${suffix}`,
    });
    await expect(
      db!.feedback.create({
        data: {
          kind: 'GENERAL',
          message: 'dup',
          email: `dup-${suffix}@walk.eticketsgo.com`,
          reference: first.reference,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      db!.feedback.create({
        data: {
          kind: 'GENERAL',
          message: 'bad',
          email: `bad-${suffix}@walk.eticketsgo.com`,
          reference: 'cmvncaxg10015uo2zxo94825e',
        },
      }),
    ).rejects.toThrow(/Feedback_reference_shape/);
  });

  maybe('the year restarts the sequence at the UTC boundary, by app and by trigger', async () => {
    await inRolledBackTx(async (tx) => {
      // Years nothing real is numbered in, so each starts at 1 inside this transaction.
      await tx.$executeRawUnsafe(
        `DELETE FROM "ReadableReferenceCounter" WHERE scope IN ('SUP-2098','SUP-2099')`,
      );
      expect(await assignSupportReference(tx, new Date('2098-12-31T23:59:59.999Z'))).toBe(
        'ETG-SUP-2098-000001',
      );
      expect(await assignSupportReference(tx, new Date('2099-01-01T00:00:00.000Z'))).toBe(
        'ETG-SUP-2099-000001',
      );
      // An insert that names no reference - the API before this change - is numbered by the
      // trigger from the same counter, by its own createdAt.
      const [old] = await tx.$queryRawUnsafe(
        `INSERT INTO "Feedback" (id, kind, message, status, "createdAt", "updatedAt")
         VALUES ('rollover-${suffix}', 'CONTACT', 'old api', 'OPEN', '2099-01-01 00:00:01', now())
         RETURNING reference`,
      );
      expect(old.reference).toBe('ETG-SUP-2099-000002');
      expect(await assignSupportReference(tx, new Date('2098-12-31T12:00:00Z'))).toBe(
        'ETG-SUP-2098-000002',
      );
    });
    // Rolled back: the counter rows for those years do not exist afterwards.
    const left = await db!.$queryRawUnsafe(
      `SELECT scope FROM "ReadableReferenceCounter" WHERE scope IN ('SUP-2098','SUP-2099')`,
    );
    expect(left).toEqual([]);
  });

  maybe(
    'the backfill numbers old rows per year in createdAt order, and is idempotent',
    async () => {
      const statements = backfillStatements();
      expect(statements).toHaveLength(2);

      await inRolledBackTx(async (tx) => {
        // Rows as they were before the column existed: inserted, then their reference removed.
        const rows: [string, string][] = [
          ['bf-2001-c', '2001-12-31 23:59:59.999'],
          ['bf-2001-a', '2001-03-01 10:00:00'],
          ['bf-2001-b', '2001-03-01 10:00:00'], // same instant as -a: the id breaks the tie
          ['bf-2002-a', '2002-01-01 00:00:00'],
          ['bf-2002-b', '2002-06-01 00:00:00'],
        ];
        for (const [id, at] of rows) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "Feedback" (id, kind, message, status, "createdAt", "updatedAt", email)
           VALUES ('${id}-${suffix}', 'CONTACT', 'old', 'OPEN', '${at}', now(), 'bf-${suffix}@walk.eticketsgo.com')`,
          );
        }
        await tx.$executeRawUnsafe(
          `UPDATE "Feedback" SET reference = NULL WHERE id LIKE 'bf-%-${suffix}'`,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM "Feedback" WHERE reference LIKE 'ETG-SUP-2001-%' OR reference LIKE 'ETG-SUP-2002-%'`,
        );
        // 2002 already handed out five numbers (a counter that ran ahead of the rows).
        await tx.$executeRawUnsafe(
          `DELETE FROM "ReadableReferenceCounter" WHERE scope IN ('SUP-2001','SUP-2002')`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "ReadableReferenceCounter" (scope, value, "updatedAt") VALUES ('SUP-2002', 5, now())`,
        );

        for (const sql of statements) await tx.$executeRawUnsafe(sql);

        const refs = async () =>
          Object.fromEntries(
            (
              (await tx.$queryRawUnsafe(
                `SELECT id, reference FROM "Feedback" WHERE id LIKE 'bf-%-${suffix}'`,
              )) as { id: string; reference: string }[]
            ).map((r) => [r.id.replace(`-${suffix}`, ''), r.reference]),
          );
        const counters = async () =>
          Object.fromEntries(
            (
              (await tx.$queryRawUnsafe(
                `SELECT scope, value FROM "ReadableReferenceCounter" WHERE scope IN ('SUP-2001','SUP-2002')`,
              )) as { scope: string; value: number }[]
            ).map((r) => [r.scope, r.value]),
          );

        const after = await refs();
        expect(after).toEqual({
          'bf-2001-a': 'ETG-SUP-2001-000001',
          'bf-2001-b': 'ETG-SUP-2001-000002',
          'bf-2001-c': 'ETG-SUP-2001-000003',
          'bf-2002-a': 'ETG-SUP-2002-000006',
          'bf-2002-b': 'ETG-SUP-2002-000007',
        });
        expect(await counters()).toEqual({ 'SUP-2001': 3, 'SUP-2002': 7 });

        // Run again: nothing is renumbered and no counter moves.
        const updated = await tx.$executeRawUnsafe(statements[0]);
        expect(updated).toBe(0);
        await tx.$executeRawUnsafe(statements[1]);
        expect(await refs()).toEqual(after);
        expect(await counters()).toEqual({ 'SUP-2001': 3, 'SUP-2002': 7 });

        // And the next request in 2002 continues after the backfill.
        expect(await assignSupportReference(tx, new Date('2002-07-01T00:00:00Z'))).toBe(
          'ETG-SUP-2002-000008',
        );
      });
    },
  );

  maybe(
    'the admin search finds a request by its reference, typed loosely, and by its id',
    async () => {
      const service = new SupportService(db as never);
      const created = await service.submit(undefined, {
        kind: FeedbackKind.CONTACT,
        email: `lookup-${suffix}@walk.eticketsgo.com`,
        message: `lookup ${suffix}`,
      });
      const ref = created.reference!;
      for (const q of [ref, ref.toLowerCase(), ref.replace(/-/g, ''), created.id]) {
        const res = await service.list({ page: 1, pageSize: 20, q });
        expect(res.data.map((r) => r.id)).toContain(created.id);
        const row = res.data.find((r) => r.id === created.id)!;
        expect(row.reference).toBe(ref);
      }
    },
  );
});
