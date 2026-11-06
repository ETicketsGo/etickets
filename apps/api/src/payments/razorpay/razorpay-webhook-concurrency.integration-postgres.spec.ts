import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { RazorpayWebhookService } from './razorpay-webhook.service';
import { RazorpayPaymentProvider } from '../provider/razorpay-payment.provider';

/**
 * One Razorpay event delivered eight times AT ONCE, against the real unique index.
 *
 * This is what two (or more) API replicas see when a provider retries while the first copy is
 * still in flight: every copy reads "no row" and tries to insert. Exactly one row may exist,
 * exactly one copy may be processed, and no copy may fail - before the fix the losers threw the
 * unique-key error, which the API answered as a 500.
 */

jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { create: jest.fn() },
    accounts: { fetch: jest.fn() },
    transfers: { create: jest.fn(), reverse: jest.fn(), fetch: jest.fn() },
    payments: { fetch: jest.fn(), refund: jest.fn() },
  })),
);

function loadEnvValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  for (const p of ['../../../../.env', '../../../../../.env']) {
    try {
      const m = readFileSync(resolve(__dirname, p), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

const SECRET = `whsec-${randomBytes(8).toString('hex')}`;

function provider(): RazorpayPaymentProvider {
  const values: Record<string, string | boolean> = {
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: 'rzp_test_secret',
    RAZORPAY_WEBHOOK_SECRET: SECRET,
    RAZORPAY_ROUTE_ENABLED: false,
  };
  return new RazorpayPaymentProvider({
    get: (k: string) => values[k],
    getOrThrow: (k: string) => values[k],
  } as unknown as ConfigService);
}

describe('integration-real-postgres: concurrent duplicate webhook deliveries', () => {
  let db: PrismaClient | undefined;
  const eventId = `evt_conc_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

  beforeAll(async () => {
    const url = loadEnvValue('DATABASE_URL');
    if (!url) return;
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
      await client.$queryRaw`SELECT 1`;
      db = client;
    } catch {
      await client.$disconnect();
      console.warn('[integration-real-postgres] SKIPPED - PostgreSQL not reachable');
    }
  });

  afterAll(async () => {
    await db?.webhookEvent.deleteMany({
      where: { provider: 'razorpay', providerEventId: eventId },
    });
    await db?.$disconnect();
  });

  it('eight copies at once: one row, one processing, no failure', async () => {
    if (!db) return;
    const processed: string[] = [];
    // One service per "replica", all sharing the one database.
    const replicas = Array.from(
      { length: 8 },
      () =>
        new RazorpayWebhookService(
          db as never,
          { get: () => provider() } as never,
          { process: async (id: string) => void processed.push(id) } as never,
          { recordPaymentWebhook: () => undefined } as never,
        ),
    );
    const body = JSON.stringify({
      event: 'payment.captured',
      created_at: 1_700_000_000,
      account_id: 'acc_conc',
      payload: { payment: { entity: { id: `pay_${eventId}` } } },
    });
    const signature = createHmac('sha256', SECRET).update(body).digest('hex');

    const results = await Promise.allSettled(
      replicas.map((svc) => svc.ingest(body, signature, eventId)),
    );

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const values = results.map((r) => (r as PromiseFulfilledResult<{ duplicate: boolean }>).value);
    expect(values.filter((v) => !v.duplicate)).toHaveLength(1);
    const rows = await db.webhookEvent.findMany({
      where: { provider: 'razorpay', providerEventId: eventId },
    });
    expect(rows).toHaveLength(1);
    // Processing is fire-and-forget in ingest; give the one that was started a tick.
    await new Promise((r) => setTimeout(r, 50));
    expect(processed).toEqual([rows[0].id]);
  });
});
