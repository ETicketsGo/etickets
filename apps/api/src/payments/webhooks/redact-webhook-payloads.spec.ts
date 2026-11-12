import { redactStoredWebhookPayloads } from '../../../prisma/redact-webhook-payloads';
import { REDACTED } from './payload-redaction';

/** The one-off backfill: counts by default, rewrites only when told to, never deletes. */
function fakeDb(
  rows: Array<{ id: string; payload: unknown; processingStatus: string }>,
  raced = new Set<string>(),
) {
  const writes: Array<{ id: string; payload: unknown }> = [];
  const db = {
    webhookEvent: {
      findMany: jest.fn(async (args: { take: number; cursor?: { id: string }; where: unknown }) => {
        const start = args.cursor ? rows.findIndex((r) => r.id === args.cursor!.id) + 1 : 0;
        return rows.slice(start, start + args.take);
      }),
      updateMany: jest.fn(
        async ({ where, data }: { where: { id: string }; data: { payload: unknown } }) => {
          if (raced.has(where.id)) return { count: 0 };
          writes.push({ id: where.id, payload: data.payload });
          return { count: 1 };
        },
      ),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  return { db, writes };
}

const withPayer = (id: string) => ({
  id,
  processingStatus: 'PROCESSED',
  payload: { object: { payment: { entity: { id: `pay_${id}`, email: 'a@b.c', amount: 100 } } } },
});
const clean = (id: string) => ({
  id,
  processingStatus: 'PROCESSED',
  payload: { object: { payment: { entity: { id: `pay_${id}`, email: REDACTED } } } },
});

it('dry run reports and writes nothing', async () => {
  const { db, writes } = fakeDb([withPayer('1'), clean('2')]);
  const s = await redactStoredWebhookPayloads(db as never, false);
  expect(s).toEqual({
    dryRun: true,
    scanned: 2,
    holdingPersonalData: 1,
    redacted: 0,
    skippedChangedMeanwhile: 0,
  });
  expect(writes).toHaveLength(0);
});

it('apply rewrites only rows that still hold personal data, across batches, and deletes nothing', async () => {
  const rows = Array.from({ length: 450 }, (_, i) =>
    i % 3 === 0 ? clean(`r${i}`) : withPayer(`r${i}`),
  );
  const { db, writes } = fakeDb(rows);
  const s = await redactStoredWebhookPayloads(db as never, true);
  expect(s.scanned).toBe(450);
  expect(s.redacted).toBe(300);
  expect(writes.every((w) => JSON.stringify(w.payload).includes('[redacted]'))).toBe(true);
  expect(writes.some((w) => JSON.stringify(w.payload).includes('a@b.c'))).toBe(false);
  expect(db.webhookEvent.delete).not.toHaveBeenCalled();
  expect(db.webhookEvent.deleteMany).not.toHaveBeenCalled();
});

it('only reads settled payment-provider rows, and leaves a row the processor took meanwhile', async () => {
  const { db } = fakeDb([withPayer('x')], new Set(['x']));
  const s = await redactStoredWebhookPayloads(db as never, true);
  expect(s.skippedChangedMeanwhile).toBe(1);
  const where = db.webhookEvent.findMany.mock.calls[0][0].where as {
    provider: { in: string[] };
    processingStatus: { in: string[] };
  };
  expect(where.provider.in.sort()).toEqual(['razorpay', 'stripe']);
  expect(where.processingStatus.in).not.toContain('RECEIVED');
  expect(where.processingStatus.in).not.toContain('PROCESSING');
});
