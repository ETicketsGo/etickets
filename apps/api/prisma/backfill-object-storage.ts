import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { R2ObjectStore } from '../src/storage/r2-object-store';
import { eventImageKey, organizationImageKey } from '../src/storage/object-keys';

/**
 * Move the images that are still in the database into the object store.
 *
 * ── WHY THIS IS A SEPARATE SCRIPT AND NOT A MIGRATION ──────────────────────────────
 * A migration runs inside a deploy, with the release waiting on it. This copies every poster
 * on the platform over a network to another provider — minutes at best, and an unbounded
 * amount of time on the day the network is bad. A deploy that hangs on it is an outage, and a
 * migration that half-fails is a migration nobody can safely re-run.
 *
 * So it runs on its own, whenever somebody chooses, and it is safe to stop and restart: every
 * row it has already moved is skipped, because a moved row has a key and no bytes. Nothing is
 * broken while it is half done — the row decides where its bytes are, so a page renders some
 * images from the database and some from the bucket without noticing.
 *
 * ── WHY IT COPIES BEFORE IT CLEARS ─────────────────────────────────────────────────
 * The object is written first, read back to prove it arrived, and only then does the row stop
 * holding the bytes. An interruption between the two leaves a duplicate, which costs a few
 * kilobytes; the other order would lose the only copy of somebody's poster.
 *
 *   SEED_OPERATION=backfill-objects   (through the db-seed service, inside the network)
 *   npx ts-node --transpile-only prisma/backfill-object-storage.ts --limit 100
 *
 * Reads no secrets it prints. `--dry-run` reports what it would move and writes nothing.
 */
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  const raw = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
})();

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  // The real driver, from the real environment. Deliberately not the seam's factory: this
  // script has no business running against the Postgres driver, where it would copy rows onto
  // themselves.
  const config = new ConfigService(process.env);
  if ((process.env.OBJECT_STORE_DRIVER ?? 'postgres') !== 'r2') {
    throw new Error(
      'Nothing to do: OBJECT_STORE_DRIVER is not r2, so objects already live in the database. ' +
        'Configure R2 first — see docs/guides/OBJECT-STORAGE.md.',
    );
  }
  const store = new R2ObjectStore(config);

  const health = await store.health();
  if (!health.healthy) {
    // Checked before a single row is touched. Discovering the bucket is unreachable halfway
    // through is how a backfill ends up with a hundred rows pointing at nothing.
    throw new Error(`R2 is not reachable, so nothing was moved. ${health.detail ?? ''}`.trim());
  }

  let moved = 0;
  let skipped = 0;

  try {
    const events = await prisma.eventImage.findMany({
      where: { storageKey: null },
      select: { id: true, eventId: true, bytes: true, contentType: true, sha256: true },
      take: LIMIT,
    });
    for (const row of events) {
      if (!row.bytes) {
        skipped += 1;
        continue;
      }
      const key = eventImageKey({
        eventId: row.eventId,
        sha256: row.sha256,
        contentType: row.contentType,
      });
      if (DRY_RUN) {
        console.log(`  would move event image ${row.id} -> ${key}`);
        moved += 1;
        continue;
      }
      await moveOne(
        store,
        prisma,
        'eventImage',
        row.id,
        key,
        Buffer.from(row.bytes),
        row.contentType,
      );
      moved += 1;
    }

    const orgs = await prisma.organizationImage.findMany({
      where: { storageKey: null },
      select: {
        id: true,
        organizationId: true,
        kind: true,
        bytes: true,
        contentType: true,
        sha256: true,
      },
      take: LIMIT,
    });
    for (const row of orgs) {
      if (!row.bytes) {
        skipped += 1;
        continue;
      }
      const key = organizationImageKey({
        organizationId: row.organizationId,
        kind: row.kind,
        sha256: row.sha256,
        contentType: row.contentType,
      });
      if (DRY_RUN) {
        console.log(`  would move organization image ${row.id} -> ${key}`);
        moved += 1;
        continue;
      }
      await moveOne(
        store,
        prisma,
        'organizationImage',
        row.id,
        key,
        Buffer.from(row.bytes),
        row.contentType,
      );
      moved += 1;
    }

    const remaining =
      (await prisma.eventImage.count({ where: { storageKey: null } })) +
      (await prisma.organizationImage.count({ where: { storageKey: null } }));

    console.log(
      `\n${DRY_RUN ? 'Would move' : 'Moved'} ${moved} object(s); ${skipped} skipped; ` +
        `${remaining} still in the database.`,
    );
    if (remaining > 0 && !DRY_RUN) {
      console.log(`Run it again to continue — it picks up where it left off.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * One object, copied and then verified before the row lets go of its bytes.
 *
 * The read-back is not paranoia about R2: it is the difference between "the API accepted the
 * write" and "the bytes are retrievable at that key", and only the second one justifies
 * deleting the copy we already have.
 */
async function moveOne(
  store: R2ObjectStore,
  prisma: PrismaClient,
  table: 'eventImage' | 'organizationImage',
  id: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await store.put({ key, body, contentType });

  const readBack = await store.get(key);
  if (!readBack || readBack.sizeBytes !== body.length) {
    throw new Error(
      `Wrote ${key} but could not read it back at the same size, so ${table} ${id} was left ` +
        `holding its bytes. Nothing was lost; fix the bucket and run this again.`,
    );
  }

  // Both fields in one update, so the row can never be momentarily holding neither — the
  // database's own CHECK constraint would refuse that anyway, which is the point of having it.
  await (prisma[table] as { update: (args: unknown) => Promise<unknown> }).update({
    where: { id },
    data: { storageKey: key, bytes: null },
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
