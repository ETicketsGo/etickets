import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  ConsoleLogger,
  Module,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import twilio from 'twilio';
import {
  DeliveryState,
  NotificationType,
  SuppressionReason,
  WebhookProcessingStatus,
} from '@eticketsgo/shared-types';
import { PrismaService } from '../../../prisma/prisma.service';
import { MetricsService } from '../../../metrics/metrics.service';
import { AllExceptionsFilter } from '../../../common/all-exceptions.filter';
import { LoggingInterceptor } from '../../../common/logging.interceptor';
import { HttpObservationService } from '../../../common/http-observation.service';
import { HttpObservationMiddleware } from '../../../common/http-observation.middleware';
import { NotificationRateService } from '../../cost/notification-rate.service';
import { acquireSweepLock, type SweepLock } from '../../test-support/sweep-lock';
import { DeliveryRecorderService } from '../delivery-recorder.service';
import { SuppressionService } from '../suppression.service';
import { DeliveryWebhookController } from './delivery-webhook.controller';
import { DeliveryWebhookService } from './delivery-webhook.service';
import { ProviderEventReplayService } from './provider-event-replay.service';
import { SnsVerifier } from './sns-verifier';
import { SnsConfirmationService } from './sns-confirmation.service';

/**
 * integration-real-postgres — Twilio status callbacks, exactly as Twilio sends them.
 *
 * ── WHY OVER A REAL SOCKET ─────────────────────────────────────────────────────────
 * The SES webhook answered 500 to every genuine message for weeks while its unit tests passed,
 * because they handed the service an object and the broken step was producing that object from
 * the wire. So this suite speaks HTTP: a form-urlencoded body, the real body parser, the global
 * prefix, the request logger and the exception filter, and a signature computed by TWILIO'S OWN
 * SDK -- not by our verifier, which would only prove it agrees with itself.
 *
 * The signature is computed over the PUBLIC URL while the request arrives at 127.0.0.1, which is
 * the production situation behind a proxy and the reason PUBLIC_API_URL exists.
 *
 * ── WHY A REAL DATABASE ────────────────────────────────────────────────────────────
 * Replay protection is a unique index, correlation is a query by SID, and "held, not consumed"
 * is a status on a row. A stub proves none of it. Skips (never fabricates a pass) without one.
 */

function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../../../.env', '../../../../../../.env']) {
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

const PUBLIC_API_URL = 'https://api-qa.eticketsgo.com';
const ROUTE = '/api/notifications/webhooks/twilio';
const AUTH_TOKEN = randomBytes(16).toString('hex');
const ACCOUNT_SID = `AC${randomBytes(16).toString('hex')}`;
const MESSAGING_SERVICE_SID = `MG${randomBytes(16).toString('hex')}`;
const four = () => String(1000 + Math.floor(Math.random() * 9000));
const PHONE = `+1415555${four()}`;
const PHONE_EARLY_STOP = `+1650555${four()}`;
const SMS_BODY = 'Your ETicketsGo sign-in code is 481516. It expires in 10 minutes.';
const newSid = () => `SM${randomBytes(16).toString('hex')}`;

const holder: { db?: Client } = {};

@Module({
  controllers: [DeliveryWebhookController],
  providers: [
    DeliveryWebhookService,
    DeliveryRecorderService,
    SuppressionService,
    ProviderEventReplayService,
    HttpObservationService,
    HttpObservationMiddleware,
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: PrismaService, useFactory: () => holder.db },
    { provide: MetricsService, useValue: new MetricsService() },
    { provide: NotificationRateService, useValue: { estimate: async () => null } },
    {
      provide: ConfigService,
      useValue: {
        get: (key: string) =>
          (({ TWILIO_AUTH_TOKEN: AUTH_TOKEN, PUBLIC_API_URL }) as Record<string, string>)[key],
      },
    },
    { provide: SnsVerifier, useValue: { verify: async () => ({ ok: false, reason: 'unused' }) } },
    { provide: SnsConfirmationService, useValue: { capture: async () => undefined } },
  ],
})
class TwilioCallbackHttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // As AppModule binds it: the request log is written by this middleware and the interceptor.
    consumer.apply(HttpObservationMiddleware).forRoutes('{*path}');
  }
}

describe('integration-real-postgres: Twilio status callbacks over HTTP', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let recorder: DeliveryRecorderService;
  let replay: ProviderEventReplayService;

  /*
    Everything this process writes, captured by replacing the stream writers directly rather
    than through jest spies, so nothing in the jest configuration can restore them mid-suite.
  */
  const written: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);

  const sids: string[] = [];
  const suffix = `twilio-http-${Date.now()}`;
  let userId = '';

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
      // Writes provider delivery evidence; serialized with the suites that read it globally.
      sweepLock = await acquireSweepLock(url);
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    holder.db = db;
    const user = await db.user.create({
      data: {
        email: `callbacks+${suffix}@example.test`,
        passwordHash: 'x',
        fullName: 'Callback Test',
        roles: ['CUSTOMER'],
      },
    });
    userId = user.id;

    const capture = (chunk: unknown) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
      return true;
    };
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;

    const moduleRef = await Test.createTestingModule({
      imports: [TwilioCallbackHttpModule],
    }).compile();
    // Matches main.ts: raw body on, the global prefix applied, a real console logger.
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useLogger(new ConsoleLogger());
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    recorder = app.get(DeliveryRecorderService);
    replay = app.get(ProviderEventReplayService);
  }, 180_000);

  afterAll(async () => {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    if (app) await app.close();
    if (db && available) {
      await db.notification.deleteMany({ where: { userId } });
      await db.user.deleteMany({ where: { email: { contains: suffix } } });
      await db.webhookEvent.deleteMany({
        where: { OR: sids.map((sid) => ({ providerEventId: { startsWith: `${sid}:` } })) },
      });
      await db.suppressedDestination.deleteMany({
        where: {
          destinationHash: {
            in: [PHONE, PHONE_EARLY_STOP].map((p) => SuppressionService.hash('sms', p)),
          },
        },
      });
    }
    await sweepLock?.release();
    if (db) await db.$disconnect();
  }, 180_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      60_000,
    );

  /** The body Twilio posts to a Messaging Service's Delivery Status Callback. */
  const callback = (sid: string, status: string, extra: Record<string, string> = {}) => ({
    AccountSid: ACCOUNT_SID,
    ApiVersion: '2010-04-01',
    From: '+18445550100',
    MessageSid: sid,
    MessageStatus: status,
    MessagingServiceSid: MESSAGING_SERVICE_SID,
    SmsSid: sid,
    SmsStatus: status,
    To: PHONE,
    ...extra,
  });

  const sign = (
    params: Record<string, string>,
    signedUrl = `${PUBLIC_API_URL}${ROUTE}`,
    token = AUTH_TOKEN,
  ) => twilio.getExpectedTwilioSignature(token, signedUrl, params);

  async function post(params: Record<string, string>, signature: string | null = sign(params)) {
    const res = await fetch(`${base}${ROUTE}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(signature === null ? {} : { 'x-twilio-signature': signature }),
      },
      body: new URLSearchParams(params).toString(),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  }

  /** A text message as the dispatcher leaves it: an open attempt, accepted or not yet. */
  async function sms(opts: { accepted: boolean }) {
    const sid = newSid();
    sids.push(sid);
    const notification = await db!.notification.create({
      data: {
        type: NotificationType.SHOW_CANCELLED,
        userId,
        toEmail: `callbacks+${suffix}@example.test`,
        payload: { reference: sid },
        channel: 'sms',
        locale: 'en',
        status: 'SENT',
        sentAt: new Date(),
      },
    });
    const deliveryId = (await recorder.open({
      notificationId: notification.id,
      provider: 'twilio',
      channel: 'sms',
      attemptNumber: 1,
    }))!;
    if (opts.accepted) await recorder.accepted(deliveryId, 'twilio', sid);
    return { sid, deliveryId, notificationId: notification.id };
  }

  const delivery = (id: string) => db!.notificationDelivery.findUnique({ where: { id } });
  const ledger = (sid: string) =>
    db!.webhookEvent.findMany({
      where: { provider: 'notification:twilio', providerEventId: { startsWith: `${sid}:` } },
      orderBy: { createdAt: 'asc' },
    });
  const is2xx = (status: number) => status >= 200 && status < 300;

  async function sweepUntilSettled(sid: string) {
    for (let i = 0; i < 30; i += 1) {
      await replay.sweep();
      const rows = await ledger(sid);
      const open = rows.some((r: { processingStatus: string }) =>
        ['AWAITING_CORRELATION', 'PROCESSING', 'RECEIVED'].includes(r.processingStatus),
      );
      if (!open) return rows;
    }
    return ledger(sid);
  }

  let first: { sid: string; deliveryId: string };

  maybe(
    'accepts a correctly signed callback, correlates it by SID, and settles its row',
    async () => {
      first = await sms({ accepted: true });
      // `Body` is not part of a status callback; it is here to prove a body is never logged.
      const res = await post(callback(first.sid, 'sent', { Body: SMS_BODY }));

      expect(is2xx(res.status)).toBe(true);
      expect(res.json).toMatchObject({ received: true, duplicate: false });
      // `sent` is carrier hand-off, which ACCEPTED already says.
      expect((await delivery(first.deliveryId)).status).toBe(DeliveryState.ACCEPTED);
      // The bookkeeping defect: this row used to stay RECEIVED forever.
      const rows = await ledger(first.sid);
      expect(rows).toHaveLength(1);
      expect(rows[0].processingStatus).toBe(WebhookProcessingStatus.PROCESSED);
      expect(rows[0].processedAt).toBeTruthy();
    },
  );

  maybe('moves the message from sent to delivered', async () => {
    const res = await post(callback(first.sid, 'delivered'));
    expect(res.json).toMatchObject({ applied: 1, duplicate: false });
    const row = await delivery(first.deliveryId);
    expect(row.status).toBe(DeliveryState.DELIVERED);
    expect(row.providerStatus).toBe('delivered');
    expect(row.deliveredAt).toBeTruthy();
    for (const r of await ledger(first.sid)) {
      expect(r.processingStatus).toBe(WebhookProcessingStatus.PROCESSED);
    }
  });

  maybe('correlates by SID: a callback moves its own message and no other', async () => {
    const a = await sms({ accepted: true });
    const b = await sms({ accepted: true });
    await post(callback(b.sid, 'delivered'));
    expect((await delivery(b.deliveryId)).status).toBe(DeliveryState.DELIVERED);
    expect((await delivery(a.deliveryId)).status).toBe(DeliveryState.ACCEPTED);
  });

  maybe('applies a duplicate callback once', async () => {
    const before = await delivery(first.deliveryId);
    const res = await post(callback(first.sid, 'delivered'));

    expect(is2xx(res.status)).toBe(true);
    expect(res.json).toMatchObject({ applied: 0, duplicate: true });
    const rows = (await ledger(first.sid)).filter(
      (r: { providerEventId: string }) => r.providerEventId === `${first.sid}:delivered`,
    );
    expect(rows).toHaveLength(1);
    expect((await delivery(first.deliveryId)).deliveredAt).toEqual(before.deliveredAt);
  });

  maybe('never lets a late callback move a delivered message backwards', async () => {
    const c = await sms({ accepted: true });
    await post(callback(c.sid, 'delivered'));
    const deliveredAt = (await delivery(c.deliveryId)).deliveredAt;

    for (const late of ['sent', 'queued', 'sending']) {
      const res = await post(callback(c.sid, late));
      expect(is2xx(res.status)).toBe(true);
      expect(res.json).toMatchObject({ applied: 0 });
    }
    const row = await delivery(c.deliveryId);
    expect(row.status).toBe(DeliveryState.DELIVERED);
    expect(row.deliveredAt).toEqual(deliveredAt);
  });

  maybe('refuses a bad signature with 401 and writes nothing', async () => {
    const d = await sms({ accepted: true });
    const signedDelivered = sign(callback(d.sid, 'delivered'));

    const refusals = [
      // Signed as delivered, altered to failed: a forged suppression.
      await post(callback(d.sid, 'failed', { ErrorCode: '21610' }), signedDelivered),
      // Signed with somebody else's auth token.
      await post(
        callback(d.sid, 'delivered'),
        sign(callback(d.sid, 'delivered'), undefined, 'x'.repeat(32)),
      ),
      // Signed over the internal URL instead of the public one PUBLIC_API_URL names.
      await post(
        callback(d.sid, 'delivered'),
        sign(callback(d.sid, 'delivered'), `${base}${ROUTE}`),
      ),
      // No signature at all.
      await post(callback(d.sid, 'delivered'), null),
    ];
    for (const res of refusals) expect(res.status).toBe(401);
    expect(await ledger(d.sid)).toHaveLength(0);
    expect((await delivery(d.deliveryId)).status).toBe(DeliveryState.ACCEPTED);
  });

  maybe(
    'holds a callback that beats its SID, and applies it the moment the SID is written',
    async () => {
      const early = await sms({ accepted: false });
      const res = await post(callback(early.sid, 'delivered'));

      // Acknowledged at once -- nothing waits inside the request.
      expect(is2xx(res.status)).toBe(true);
      expect(res.json).toMatchObject({ applied: 0, duplicate: false });
      let rows = await ledger(early.sid);
      expect(rows[0].processingStatus).toBe(WebhookProcessingStatus.AWAITING_CORRELATION);
      expect((await delivery(early.deliveryId)).status).toBe(DeliveryState.ATTEMPTING);

      // A redelivery of the same event is still a duplicate: it must not be needed.
      expect((await post(callback(early.sid, 'delivered'))).json).toMatchObject({
        duplicate: true,
      });

      // The worker records the SID, then asks for anything that arrived early.
      await recorder.accepted(early.deliveryId, 'twilio', early.sid);
      expect(await replay.reapplyFor('twilio', early.sid)).toBe(1);

      expect((await delivery(early.deliveryId)).status).toBe(DeliveryState.DELIVERED);
      rows = await ledger(early.sid);
      expect(rows[0].processingStatus).toBe(WebhookProcessingStatus.PROCESSED);
    },
  );

  maybe(
    'applies an early STOP through the sweep, as an unsubscribe, without ever storing the number',
    async () => {
      const early = await sms({ accepted: false });
      await post(callback(early.sid, 'failed', { ErrorCode: '21610', To: PHONE_EARLY_STOP }));

      const [held] = await ledger(early.sid);
      expect(held.processingStatus).toBe(WebhookProcessingStatus.AWAITING_CORRELATION);
      // What the ledger keeps: a hash and a mask, never the number.
      expect(JSON.stringify(held.payload)).not.toContain(PHONE_EARLY_STOP.slice(2));

      // The SID is recorded WITHOUT the fast path, as if both sides looked at the same instant.
      await recorder.accepted(early.deliveryId, 'twilio', early.sid);
      const settled = await sweepUntilSettled(early.sid);
      expect(settled[0].processingStatus).toBe(WebhookProcessingStatus.PROCESSED);

      expect((await delivery(early.deliveryId)).status).toBe(DeliveryState.REJECTED);
      const suppression = await db!.suppressedDestination.findUnique({
        where: {
          channel_destinationHash: {
            channel: 'sms',
            destinationHash: SuppressionService.hash('sms', PHONE_EARLY_STOP),
          },
        },
      });
      expect(suppression?.reason).toBe(SuppressionReason.UNSUBSCRIBED);
    },
  );

  maybe(
    'records a STOP on a delivered-to message as an unsubscribe, not a provider block',
    async () => {
      const e = await sms({ accepted: true });
      const res = await post(callback(e.sid, 'failed', { ErrorCode: '21610' }));
      expect(res.json).toMatchObject({ applied: 1 });

      expect((await delivery(e.deliveryId)).status).toBe(DeliveryState.REJECTED);
      const suppression = await db!.suppressedDestination.findUnique({
        where: {
          channel_destinationHash: {
            channel: 'sms',
            destinationHash: SuppressionService.hash('sms', PHONE),
          },
        },
      });
      expect(suppression?.reason).toBe(SuppressionReason.UNSUBSCRIBED);
      const notification = await db!.notification.findUnique({ where: { id: e.notificationId } });
      expect(notification.status).toBe('FAILED');
    },
  );

  maybe('dead-letters a callback that never correlates within the window', async () => {
    const orphan = newSid();
    sids.push(orphan);
    await db!.webhookEvent.create({
      data: {
        provider: 'notification:twilio',
        providerEventId: `${orphan}:delivered`,
        eventType: 'delivered',
        payload: {
          providerMessageId: orphan,
          state: 'DELIVERED',
          providerStatus: 'delivered',
          failureCode: null,
        },
        processingStatus: WebhookProcessingStatus.AWAITING_CORRELATION,
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    const [row] = await sweepUntilSettled(orphan);
    expect(row.processingStatus).toBe(WebhookProcessingStatus.DEAD_LETTER);
    expect(row.errorMessage).toMatch(/correlation window/);
  });

  maybe('never writes the phone number, the auth token or a message body to the log', async () => {
    const text = written.join('');
    // The control: the request log IS being captured, so an absence below means something.
    expect(text).toContain('notifications/webhooks/twilio');
    for (const secret of [
      PHONE,
      PHONE.slice(2),
      PHONE_EARLY_STOP.slice(2),
      AUTH_TOKEN,
      SMS_BODY,
      '481516',
    ]) {
      expect({ leaked: text.includes(secret) }).toEqual({ leaked: false });
    }
  });
});
