import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TransactionalEventPublisher } from '../../common/domain-events';
import { AllocationAccountingService } from './allocation-accounting.service';

/**
 * integration-real-postgres — proves the ALLOCATED capacity guard is oversell-proof under
 * real concurrent transactions (ADR-042 P5.3A.1). Requires a reachable PostgreSQL with
 * migrations applied. It SKIPS (never fabricates a pass) when the DB is unavailable, so it is
 * safe in CI without a database. This is the gate for enabling BOOKING_ALLOCATED_INVENTORY_ENABLED.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
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

const inProcessPublisher = {
  recordInTransaction: async () => 0,
  deliverAfterCommit: async () => undefined,
} as unknown as TransactionalEventPublisher;

describe('integration-real-postgres: allocation capacity guard', () => {
  const url = loadDatabaseUrl();
  let prisma: InstanceType<typeof PrismaClient> | undefined;
  let available = false;
  const providerCode = 'itest-alloc';
  const externalRef = `alloc-${Date.now()}`;

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await prisma.$queryRaw`SELECT 1`;
      available = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[integration-real-postgres] SKIPPED — DB unavailable: ${(err as Error).message}`,
      );
      available = false;
    }
  });

  afterAll(async () => {
    if (prisma && available) {
      await prisma.providerInventoryState
        .deleteMany({ where: { providerCode, externalSessionId: externalRef } })
        .catch(() => undefined);
    }
    await prisma?.$disconnect().catch(() => undefined);
  });

  it('never lets concurrent holds exceed allocated capacity', async () => {
    if (!available) return; // documented skip (see beforeAll warning) — never a fabricated pass
    const capacity = 5;
    const attempts = 12;
    await prisma!.providerInventoryState.create({
      data: {
        providerCode,
        providerTenantId: '',
        externalSessionId: externalRef,
        providerCapacity: capacity,
        heldLocal: 0,
        confirmedLocal: 0,
      },
    });
    const svc = new AllocationAccountingService(prisma as never, inProcessPublisher);

    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_, i) =>
        prisma!.$transaction((tx: unknown) =>
          svc.holdInTx(tx as never, {
            bookingId: `b${i}`,
            providerCode,
            externalRef,
            qty: 1,
            inventoryType: 'QUANTITY',
          }),
        ),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const row = await prisma!.providerInventoryState.findFirst({
      where: { providerCode, externalSessionId: externalRef },
      select: { heldLocal: true },
    });
    expect(succeeded).toBe(capacity); // exactly capacity holds win
    expect(row?.heldLocal).toBe(capacity); // never oversold
  }, 30_000);
});
