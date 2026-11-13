import { PrismaClient, WebhookProcessingStatus } from '@prisma/client';
import type * as Redaction from '../src/payments/webhooks/payload-redaction';

/*
  The db-seed service runs this from the API image, which carries prisma/ and the COMPILED API
  (dist/) but not src/. Locally and under jest it is src/. Same module either way, so the
  backfill can never drift from what the receivers apply on write.
*/
function loadRedaction(): typeof Redaction {
  for (const path of [
    '../src/payments/webhooks/payload-redaction',
    '../dist/payments/webhooks/payload-redaction',
  ]) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(path) as typeof Redaction;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw e;
    }
  }
  throw new Error('payload-redaction module not found in src/ or dist/');
}
const { holdsPersonalData, redactProviderPayload } = loadRedaction();

/**
 * Remove the payer from payment webhook rows stored BEFORE redaction-on-write shipped.
 *
 * New Razorpay / Stripe deliveries are redacted as they are written (payload-redaction.ts). The
 * rows already in the table still hold the full provider event: payer email, phone, UPI address,
 * card last 4. This rewrites those payloads in place with the same redaction, so the processors,
 * reconciliation, refunds and disputes see exactly what a new row would hold.
 *
 * What it NEVER does:
 *   - delete a row (idempotency keys, payloadHash and processing history all stay)
 *   - touch a row that is still RECEIVED or PROCESSING (the processor owns it)
 *   - touch notification-provider rows (those are already minimised when written)
 *   - print a payload, an email or a phone number: it reports counts only
 *
 * DRY RUN BY DEFAULT. It writes only when WEBHOOK_REDACT_APPLY=true (or `--apply`). Running it
 * against production changes production rows and therefore needs the owner's approval.
 *
 *   SEED_OPERATION=redact-webhooks                              (counts only)
 *   SEED_OPERATION=redact-webhooks WEBHOOK_REDACT_APPLY=true    (rewrites)
 *   npx ts-node --transpile-only prisma/redact-webhook-payloads.ts [--apply]
 *
 * Restartable: an already-redacted row is skipped, so an interrupted run is simply run again.
 */
export const PAYMENT_PROVIDERS = ['razorpay', 'stripe'] as const;
const SETTLED: WebhookProcessingStatus[] = [
  WebhookProcessingStatus.PROCESSED,
  WebhookProcessingStatus.IGNORED,
  WebhookProcessingStatus.FAILED,
  WebhookProcessingStatus.DEAD_LETTER,
];
const BATCH = 200;

export interface RedactSummary {
  dryRun: boolean;
  scanned: number;
  holdingPersonalData: number;
  redacted: number;
  skippedChangedMeanwhile: number;
}

type Db = Pick<PrismaClient, 'webhookEvent'>;

export async function redactStoredWebhookPayloads(db: Db, apply: boolean): Promise<RedactSummary> {
  const s: RedactSummary = {
    dryRun: !apply,
    scanned: 0,
    holdingPersonalData: 0,
    redacted: 0,
    skippedChangedMeanwhile: 0,
  };
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.webhookEvent.findMany({
      where: { provider: { in: [...PAYMENT_PROVIDERS] }, processingStatus: { in: SETTLED } },
      select: { id: true, payload: true, processingStatus: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      s.scanned += 1;
      if (!holdsPersonalData(row.payload)) continue;
      s.holdingPersonalData += 1;
      if (!apply) continue;
      // Conditional on the status it was read with: a row a retry picked up in between is left
      // for the next run instead of being overwritten under the processor.
      const r = await db.webhookEvent.updateMany({
        where: { id: row.id, processingStatus: row.processingStatus },
        data: { payload: redactProviderPayload(row.payload) as object },
      });
      if (r.count === 1) s.redacted += 1;
      else s.skippedChangedMeanwhile += 1;
    }
  }
  return s;
}

if (require.main === module) {
  const apply =
    process.argv.includes('--apply') || (process.env.WEBHOOK_REDACT_APPLY ?? '').trim() === 'true';
  const prisma = new PrismaClient();
  redactStoredWebhookPayloads(prisma, apply)
    .then((s) => {
      console.log(`REDACT_WEBHOOKS_JSON ${JSON.stringify(s)}`);
      return prisma.$disconnect();
    })
    .catch(async (e) => {
      console.error(`redact-webhooks failed: ${(e as Error).message}`);
      await prisma.$disconnect();
      process.exit(1);
    });
}
