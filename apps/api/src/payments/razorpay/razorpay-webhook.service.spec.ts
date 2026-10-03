import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { RazorpayWebhookService } from './razorpay-webhook.service';
import { RazorpayPaymentProvider } from './../provider/razorpay-payment.provider';

/**
 * The webhook INGESTION boundary — what reaches the database, and what must not.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────
 * Signature rejection was proven at the adapter (`verifySignedEnvelope`), and event handling was
 * proven at the processor. The step between them - ingestion - had no spec, while Stripe's did.
 * That is the step that decides whether an unauthenticated payload can leave a row behind, and
 * whether a redelivery is processed twice.
 *
 * ── REAL VERIFICATION, STUBBED STORAGE ─────────────────────────────────────────────────
 * The adapter is the real `RazorpayPaymentProvider`, so the HMAC check is genuine rather than a
 * double that always agrees. Prisma is a stub, because what is under test is WHICH writes happen
 * and in what order, not PostgreSQL.
 *
 * This proves our boundary. It is NOT evidence of how Razorpay signs or redelivers anything.
 */

jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { create: jest.fn() },
    accounts: { fetch: jest.fn() },
    transfers: { create: jest.fn(), reverse: jest.fn(), fetch: jest.fn() },
    payments: { fetch: jest.fn(), refund: jest.fn() },
  })),
);

const WEBHOOK_SECRET = 'test-razorpay-webhook-secret';

function makeProvider(): RazorpayPaymentProvider {
  const values: Record<string, string | boolean> = {
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: 'rzp_test_secret',
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RAZORPAY_ROUTE_ENABLED: false,
  };
  return new RazorpayPaymentProvider({
    get: (k: string) => values[k],
    getOrThrow: (k: string) => values[k],
  } as unknown as ConfigService);
}

type Row = Record<string, unknown> & { id: string; processingStatus: string };

function makeService(existing: Row | null = null) {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const prisma = {
    webhookEvent: {
      findUnique: jest.fn(async () => existing),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'we_new', ...data };
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updated.push(data);
        return { id: existing?.id ?? 'we_upd', ...data };
      }),
    },
  };
  const processed: string[] = [];
  const processor = {
    process: jest.fn(async (id: string) => {
      processed.push(id);
    }),
  };
  const service = new RazorpayWebhookService(
    prisma as never,
    { get: () => makeProvider() } as never,
    processor as never,
    { recordPaymentWebhook: jest.fn() } as never,
  );
  return { service, prisma, created, updated, processed, processor };
}

const BODY = JSON.stringify({
  event: 'payment.captured',
  created_at: 1_700_000_000,
  account_id: 'acc_x',
  payload: { payment: { entity: { id: 'pay_1' } } },
});
const sign = (raw: string) => createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');

describe('an unverified payload never reaches the database', () => {
  it('refuses a bad signature and writes NOTHING', async () => {
    /*
      Fail closed. Verification happens before any persistence, so a forged payload cannot even
      leave a row claiming it arrived - which would otherwise be a way to have us store, and
      later retry, something nobody authenticated.
    */
    const { service, prisma, processed } = makeService();

    await expect(service.ingest(BODY, 'not-the-signature', 'evt_1')).rejects.toThrow(/signature/i);

    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.update).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
    expect(processed).toEqual([]);
  });

  it('refuses an empty signature', async () => {
    const { service, prisma } = makeService();
    await expect(service.ingest(BODY, '', 'evt_1')).rejects.toThrow(/signature/i);
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('refuses a signature for a DIFFERENT body', async () => {
    // The signature must bind to these exact bytes, or a replay could carry any payload.
    const { service, prisma } = makeService();
    const other = JSON.stringify({ event: 'payment.captured', payload: {} });
    await expect(service.ingest(BODY, sign(other), 'evt_1')).rejects.toThrow(/signature/i);
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });
});

describe('a verified payload is stored once and handed on', () => {
  it('records it RECEIVED and starts processing', async () => {
    const { service, created, processed } = makeService();

    const result = await service.ingest(BODY, sign(BODY), 'evt_1');

    expect(result).toEqual({ received: true, duplicate: false });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      provider: 'razorpay',
      providerEventId: 'evt_1',
      eventType: 'payment.captured',
      processingStatus: 'RECEIVED',
    });
    expect(processed).toEqual(['we_new']);
  });

  it('falls back to a payload hash when the provider sends no event id', async () => {
    /*
      Dedup must not depend on a header the provider may omit. Two deliveries of identical bytes
      then still collapse onto one identity rather than being stored as two unrelated events.
    */
    const { service, created } = makeService();
    await service.ingest(BODY, sign(BODY), undefined);

    const id = created[0].providerEventId as string;
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(created[0].payloadHash).toBe(id);
  });

  it('ignores a blank event-id header rather than storing it as an identity', async () => {
    const { service, created } = makeService();
    await service.ingest(BODY, sign(BODY), '   ');
    expect(created[0].providerEventId).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('redelivery cannot be processed twice', () => {
  it.each(['PROCESSED', 'PROCESSING'])(
    'reports a duplicate and does not reprocess when the first is %s',
    async (status) => {
      /*
        Providers redeliver. Reprocessing a captured payment would issue tickets twice and
        reprocessing a refund would deduct an organizer twice, so the claim is on the stored
        row's state rather than on hoping delivery is unique.
      */
      const { service, prisma, processed } = makeService({
        id: 'we_old',
        processingStatus: status,
      });

      const result = await service.ingest(BODY, sign(BODY), 'evt_1');

      expect(result).toEqual({ received: true, duplicate: true });
      expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
      expect(prisma.webhookEvent.update).not.toHaveBeenCalled();
      expect(processed).toEqual([]);
    },
  );

  it.each(['RECEIVED', 'FAILED'])(
    'retries an unfinished delivery in place rather than duplicating it when it is %s',
    async (status) => {
      // Not finished, so it may be retried - but it must reuse the row, not create a second.
      const { service, prisma, updated, processed } = makeService({
        id: 'we_old',
        processingStatus: status,
      });

      const result = await service.ingest(BODY, sign(BODY), 'evt_1');

      expect(result).toEqual({ received: true, duplicate: false });
      expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({ processingStatus: 'RECEIVED' });
      expect(processed).toEqual(['we_old']);
    },
  );
});

describe('ingestion survives a processor that fails', () => {
  it('still reports the event as received', async () => {
    /*
      The row is committed before processing starts, so a processing failure must not turn into
      a non-2xx. A provider that is told "not received" will redeliver, and the event is already
      durable - the sweep is what retries it.
    */
    const h = makeService();
    h.processor.process.mockRejectedValueOnce(new Error('processor down'));

    const result = await h.service.ingest(BODY, sign(BODY), 'evt_1');

    expect(result).toEqual({ received: true, duplicate: false });
    expect(h.created).toHaveLength(1);
  });
});
