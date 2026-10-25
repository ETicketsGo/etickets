import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { AllExceptionsFilter } from '../common/all-exceptions.filter';
import { EMAIL_TRANSPORT } from '../notifications/channels/transports/email.transport';

/**
 * integration-real-postgres, whole app over HTTP: a Contact form message is queued for the
 * support mailbox and acknowledged, and a mail provider that is down cannot fail the form.
 *
 * The defect (found from production, 2026-10-18): POST /support stored a Feedback row and
 * nothing else. The owner wrote in from https://www.eticketsgo.com/contact; the message sat
 * OPEN in the admin console, support@eticketsgo.com received nothing, and the sender heard
 * nothing.
 *
 * The provider here THROWS on every send. The request must still answer 201, because the API
 * only writes outbox rows and the worker is the only thing that talks to a provider. Nothing
 * here runs the dispatcher: a sweep would touch every due row in a shared database.
 *
 * Skips (never fabricates a pass) without a database.
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

describe('integration-real-postgres: a support form message is mailed through the outbox', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let available = false;

  const suffix = `sm1-${Date.now()}`;
  // Never sent: no worker runs here, and every row is deleted afterwards.
  const inbox = `inbox-${suffix}@walk.eticketsgo.com`;
  const sender = `sender-${suffix}@walk.eticketsgo.com`;
  const providerSend = jest.fn().mockRejectedValue(new Error('SES is down'));
  const savedEnv = { ...process.env };

  async function post(body: unknown) {
    const res = await fetch(`${base}/api/support`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json().catch(() => null);
    return { status: res.status, data: json?.data ?? json };
  }

  const rowsFor = (feedbackId: string) =>
    db!.notification.findMany({
      where: {
        type: { in: ['SUPPORT_REQUEST_RECEIVED', 'SUPPORT_REQUEST_ACKNOWLEDGED'] },
        // The id rides in the payload for tracing; `reference` is the readable ETG-SUP-... one.
        payload: { path: ['feedbackId'], equals: feedbackId },
      },
      orderBy: { type: 'asc' },
    });

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
      return;
    }
    process.env.DATABASE_URL = url;
    process.env.APP_ENV = 'LOCAL';
    process.env.SUPPORT_INBOX_EMAIL = inbox;
    process.env.ADMIN_WEB_URL = 'https://admin.walk.eticketsgo.com';
    process.env.THROTTLE_LIMIT = '5000';
    process.env.AUTH_THROTTLE_LIMIT = '5000';

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_TRANSPORT)
      .useValue({ name: 'ses', send: providerSend })
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    if (db && available) {
      const feedback = await db.feedback.findMany({
        where: { email: { contains: suffix } },
        select: { id: true },
      });
      for (const { id } of feedback) {
        await db.notification.deleteMany({
          where: { payload: { path: ['feedbackId'], equals: id } },
        });
      }
      await db.feedback.deleteMany({ where: { email: { contains: suffix } } });
      await db.$disconnect();
    }
    if (app) await app.close();
    process.env = savedEnv;
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  maybe('POST /support answers 201 and queues the inbox copy and the acknowledgement', async () => {
    const r = await post({
      kind: 'CONTACT',
      email: sender,
      name: 'Walk Sender',
      locale: 'fr-CA',
      subject: '[Support] Website enquiry',
      message: 'From: Walk Sender\n\nI was charged twice.',
    });
    // The provider throws on every call, and the form does not care.
    expect(r.status).toBe(201);
    expect(providerSend).not.toHaveBeenCalled();
    // The id is kept, and the readable reference is added beside it.
    expect(r.data.id).toEqual(expect.any(String));
    expect(r.data.reference).toMatch(/^ETG-SUP-\d{4}-\d{6,}$/);

    const rows = await rowsFor(r.data.id);
    expect(rows.map((n: { type: string }) => n.type)).toEqual([
      'SUPPORT_REQUEST_RECEIVED',
      'SUPPORT_REQUEST_ACKNOWLEDGED',
    ]);
    const [copy, ack] = rows;

    expect(copy).toMatchObject({
      toEmail: inbox,
      channel: 'email',
      locale: 'en',
      status: 'PENDING',
    });
    expect(copy.userId).toBeNull();
    expect(copy.payload).toMatchObject({
      replyTo: sender,
      senderName: 'Walk Sender',
      kind: 'CONTACT',
      topic: '[Support] Website enquiry',
      message: 'From: Walk Sender\n\nI was charged twice.',
      reference: r.data.reference,
      link: `https://admin.walk.eticketsgo.com/admin/support?q=${r.data.reference}`,
    });

    expect(ack).toMatchObject({
      toEmail: sender,
      channel: 'email',
      locale: 'fr-CA',
      status: 'PENDING',
    });
    expect(ack.payload).toEqual({
      reference: r.data.reference,
      feedbackId: r.data.id,
      email: sender,
      replyTo: inbox,
    });
    // Keyed, so nothing that re-runs the enqueue can write a second copy.
    expect(copy.dedupeKey).toBeTruthy();
    expect(ack.dedupeKey).toBeTruthy();
  });

  maybe('the same message sent twice is one submission and one pair of mails', async () => {
    const body = {
      kind: 'BUG',
      email: sender,
      subject: 'Map does not load',
      message: `Seat map is blank (${suffix})`,
    };
    const first = await post(body);
    const second = await post(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.data.id).toBe(first.data.id);
    expect(second.data.reference).toBe(first.data.reference);
    expect(await rowsFor(first.data.id)).toHaveLength(2);
    expect(await db!.feedback.count({ where: { message: body.message } })).toBe(1);
  });

  maybe('a satisfaction rating is stored and mailed to nobody', async () => {
    const r = await post({ kind: 'CSAT', email: sender, rating: 5, message: 'Great' });
    expect(r.status).toBe(201);
    expect(await rowsFor(r.data.id)).toHaveLength(0);
  });

  maybe('an address that could inject a header is refused by validation', async () => {
    const r = await post({
      kind: 'CONTACT',
      email: `${sender}\r\nBcc: victim@gmail.com`,
      message: 'Hello',
    });
    expect(r.status).toBe(400);
  });
});
