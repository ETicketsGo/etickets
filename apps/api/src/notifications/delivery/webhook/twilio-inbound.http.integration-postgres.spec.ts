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
import { SuppressionReason, WebhookProcessingStatus } from '@eticketsgo/shared-types';
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
import { DeliveryWebhookController, EMPTY_TWIML } from './delivery-webhook.controller';
import { DeliveryWebhookService } from './delivery-webhook.service';
import { ProviderEventReplayService } from './provider-event-replay.service';
import { SnsVerifier } from './sns-verifier';
import { SnsConfirmationService } from './sns-confirmation.service';

/**
 * integration-real-postgres — STOP, START and HELP, exactly as Twilio reports them.
 *
 * ── THE DEFECT THIS SUITE CLOSES ───────────────────────────────────────────────────
 * A STOP was recorded locally as UNSUBSCRIBED, and scheduled messages then refused to text the
 * number. The only thing that could lift it was Twilio later ACCEPTING a send -- which the local
 * suppression itself prevented. A customer who texted START stayed suppressed here while Twilio
 * would have delivered to them.
 *
 * With Advanced Opt-Out, Twilio reports each keyword to the Messaging Service's incoming-message
 * webhook as `OptOutType`. This suite drives that webhook over a real socket, with the real body
 * parser, request logger and exception filter, signatures computed by Twilio's own SDK over the
 * public URL, and a real database -- because "a redelivered STOP cannot undo a later START" is a
 * unique index, not a promise.
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
const ROUTE = '/api/notifications/webhooks/twilio/inbound';
const AUTH_TOKEN = randomBytes(16).toString('hex');
const ACCOUNT_SID = `AC${randomBytes(16).toString('hex')}`;
const MESSAGING_SERVICE_SID = `MG${randomBytes(16).toString('hex')}`;
const four = () => String(1000 + Math.floor(Math.random() * 9000));
const phone = (area: string) => `+1${area}555${four()}`;
/** Written by a customer; must never reach a log or the database. */
const PRIVATE_BODY = `Stop texting me please, this is Priya-${four()}`;
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
class TwilioInboundHttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpObservationMiddleware).forRoutes('{*path}');
  }
}

describe('integration-real-postgres: Twilio STOP/START/HELP over HTTP', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  let app: INestApplication | undefined;
  let base = '';
  let suppression: SuppressionService;
  let replay: ProviderEventReplayService;

  const written: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const phones: string[] = [];
  const sids: string[] = [];

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
      sweepLock = await acquireSweepLock(url);
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    holder.db = db;

    const capture = (chunk: unknown) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
      return true;
    };
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;

    const moduleRef = await Test.createTestingModule({
      imports: [TwilioInboundHttpModule],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useLogger(new ConsoleLogger());
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    suppression = app.get(SuppressionService);
    replay = app.get(ProviderEventReplayService);
  }, 180_000);

  afterAll(async () => {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    if (app) await app.close();
    if (db && available) {
      await db.webhookEvent.deleteMany({
        where: { provider: 'notification:twilio-inbound', providerEventId: { in: sids } },
      });
      await db.suppressedDestination.deleteMany({
        where: { destinationHash: { in: phones.map((p) => SuppressionService.hash('sms', p)) } },
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

  const newPhone = (area: string) => {
    const p = phone(area);
    phones.push(p);
    return p;
  };

  /** The body Twilio posts to a Messaging Service's incoming-message webhook. */
  const inbound = (from: string, extra: Record<string, string> = {}) => {
    const sid = extra.MessageSid ?? newSid();
    if (!sids.includes(sid)) sids.push(sid);
    return {
      AccountSid: ACCOUNT_SID,
      ApiVersion: '2010-04-01',
      Body: PRIVATE_BODY,
      From: from,
      FromCountry: 'US',
      MessageSid: sid,
      MessagingServiceSid: MESSAGING_SERVICE_SID,
      NumMedia: '0',
      NumSegments: '1',
      SmsMessageSid: sid,
      SmsSid: sid,
      SmsStatus: 'received',
      To: '+18445550100',
      ToCountry: 'US',
      ...extra,
    };
  };

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
    return {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      text: await res.text(),
    };
  }

  const row = (p: string) =>
    db!.suppressedDestination.findUnique({
      where: {
        channel_destinationHash: {
          channel: 'sms',
          destinationHash: SuppressionService.hash('sms', p),
        },
      },
    });
  const ledger = (sid: string) =>
    db!.webhookEvent.findUnique({
      where: {
        provider_providerEventId: { provider: 'notification:twilio-inbound', providerEventId: sid },
      },
    });

  maybe(
    'STOP suppresses the number, and answers with empty TwiML so nothing is sent twice',
    async () => {
      const p = newPhone('415');
      const body = inbound(p, { OptOutType: 'STOP' });
      const res = await post(body);

      expect(res.status).toBe(200);
      expect(res.contentType).toMatch(/text\/xml/);
      expect(res.text).toBe(EMPTY_TWIML);
      expect(await suppression.isSuppressed('sms', p)).toBe(true);
      expect((await row(p))?.reason).toBe(SuppressionReason.UNSUBSCRIBED);

      const event = await ledger(body.MessageSid);
      expect(event?.processingStatus).toBe(WebhookProcessingStatus.PROCESSED);
      // Kept: what Twilio decided and a hash. Not kept: the number, or what they wrote.
      const stored = JSON.stringify(event?.payload);
      expect(stored).not.toContain(p.slice(2));
      expect(stored).not.toContain('Priya');
    },
  );

  maybe(
    'START lifts an opt-out that scheduled sends had been refusing on — the sticky case',
    async () => {
      // Exactly the state a 21610 refusal or callback leaves behind.
      const p = newPhone('628');
      await suppression.suppress({
        channel: 'sms',
        destination: p,
        reason: SuppressionReason.UNSUBSCRIBED,
        provider: 'twilio',
      });
      expect(await suppression.isSuppressed('sms', p)).toBe(true);

      const res = await post(inbound(p, { OptOutType: 'START' }));

      expect(res.status).toBe(200);
      expect(await suppression.isSuppressed('sms', p)).toBe(false);
      // Lifted, never deleted, and attributed to the keyword rather than to a send.
      expect(await row(p)).toMatchObject({ liftedBy: 'provider:twilio:start' });
    },
  );

  maybe('START never lifts a suppression that is not an opt-out', async () => {
    const p = newPhone('718');
    await suppression.suppress({
      channel: 'sms',
      destination: p,
      reason: SuppressionReason.BLOCKED_BY_PROVIDER,
      provider: 'twilio',
    });
    await post(inbound(p, { OptOutType: 'START' }));
    expect(await suppression.isSuppressed('sms', p)).toBe(true);
  });

  maybe('HELP changes nothing, whichever state the number is in', async () => {
    const opted = newPhone('312');
    const clear = newPhone('213');
    await suppression.suppress({
      channel: 'sms',
      destination: opted,
      reason: SuppressionReason.UNSUBSCRIBED,
    });

    const help = inbound(opted, { OptOutType: 'HELP' });
    expect((await post(help)).text).toBe(EMPTY_TWIML);
    await post(inbound(clear, { OptOutType: 'HELP' }));

    expect(await suppression.isSuppressed('sms', opted)).toBe(true);
    expect(await suppression.isSuppressed('sms', clear)).toBe(false);
    expect(await row(clear)).toBeNull();
    expect((await ledger(help.MessageSid))?.processingStatus).toBe(
      WebhookProcessingStatus.PROCESSED,
    );
  });

  maybe('refuses a bad signature with 401, and neither writes nor changes anything', async () => {
    const p = newPhone('646');
    await suppression.suppress({
      channel: 'sms',
      destination: p,
      reason: SuppressionReason.UNSUBSCRIBED,
    });

    const start = inbound(p, { OptOutType: 'START' });
    const signedAsStop = sign({ ...start, OptOutType: 'STOP' });
    const refusals = [
      // A forged START: signed as a STOP, altered to lift the suppression.
      await post(start, signedAsStop),
      await post(start, sign(start, undefined, 'x'.repeat(32))),
      // Signed over the internal URL rather than the public one Twilio calls.
      await post(start, sign(start, `${base}${ROUTE}`)),
      await post(start, null),
    ];
    for (const res of refusals) expect(res.status).toBe(401);
    expect(await ledger(start.MessageSid)).toBeNull();
    expect(await suppression.isSuppressed('sms', p)).toBe(true);
  });

  maybe(
    'a redelivered STOP is a duplicate, and cannot undo a START that came after it',
    async () => {
      const p = newPhone('917');
      const stop = inbound(p, { OptOutType: 'STOP' });
      await post(stop);
      expect(await suppression.isSuppressed('sms', p)).toBe(true);

      await post(inbound(p, { OptOutType: 'START' }));
      expect(await suppression.isSuppressed('sms', p)).toBe(false);

      // The same STOP again, as a provider retry would send it.
      const again = await post(stop);
      expect(again.status).toBe(200);
      expect(await suppression.isSuppressed('sms', p)).toBe(false);
      expect(
        await db!.webhookEvent.count({
          where: { provider: 'notification:twilio-inbound', providerEventId: stop.MessageSid },
        }),
      ).toBe(1);
    },
  );

  maybe('a second STOP after a START suppresses again', async () => {
    const p = newPhone('305');
    await post(inbound(p, { OptOutType: 'STOP' }));
    await post(inbound(p, { OptOutType: 'START' }));
    await post(inbound(p, { OptOutType: 'STOP' }));
    expect(await suppression.isSuppressed('sms', p)).toBe(true);
  });

  maybe(
    'ignores a message Twilio did not classify, even one that reads like a keyword',
    async () => {
      // Advanced Opt-Out off, or an ordinary reply. Twilio is the authority on keywords.
      const p = newPhone('702');
      const reply = inbound(p, { Body: 'STOP' });
      const res = await post(reply);
      expect(res.status).toBe(200);
      expect(res.text).toBe(EMPTY_TWIML);
      expect(await ledger(reply.MessageSid)).toBeNull();
      expect(await row(p)).toBeNull();
    },
  );

  maybe('re-applies a keyword a crashed process claimed but never applied', async () => {
    const p = newPhone('404');
    const sid = newSid();
    sids.push(sid);
    const created = await db!.webhookEvent.create({
      data: {
        provider: 'notification:twilio-inbound',
        providerEventId: sid,
        eventType: 'STOP',
        payload: {
          kind: 'opt_out',
          optOutType: 'STOP',
          destinationRef: SuppressionService.reference(p, ['sms']),
        },
        processingStatus: WebhookProcessingStatus.RECEIVED,
      },
    });
    await db!
      .$executeRaw`UPDATE "WebhookEvent" SET "createdAt" = now() - interval '1 hour', "updatedAt" = now() - interval '1 hour' WHERE id = ${created.id}`;

    for (let i = 0; i < 30 && (await ledger(sid))?.processingStatus !== 'PROCESSED'; i += 1) {
      await replay.sweep();
    }
    expect((await ledger(sid))?.processingStatus).toBe(WebhookProcessingStatus.PROCESSED);
    expect(await suppression.isSuppressed('sms', p)).toBe(true);
  });

  maybe(
    'does not re-apply a stale STOP when a later START for that number already went through',
    async () => {
      const p = newPhone('503');
      const staleSid = newSid();
      sids.push(staleSid);
      const stale = await db!.webhookEvent.create({
        data: {
          provider: 'notification:twilio-inbound',
          providerEventId: staleSid,
          eventType: 'STOP',
          payload: {
            kind: 'opt_out',
            optOutType: 'STOP',
            destinationRef: SuppressionService.reference(p, ['sms']),
          },
          processingStatus: WebhookProcessingStatus.RECEIVED,
        },
      });
      await db!
        .$executeRaw`UPDATE "WebhookEvent" SET "createdAt" = now() - interval '2 hours', "updatedAt" = now() - interval '2 hours' WHERE id = ${stale.id}`;
      // The START that followed it, applied normally.
      await post(inbound(p, { OptOutType: 'START' }));

      for (
        let i = 0;
        i < 30 && (await ledger(staleSid))?.processingStatus !== 'PROCESSED';
        i += 1
      ) {
        await replay.sweep();
      }
      expect((await ledger(staleSid))?.processingStatus).toBe(WebhookProcessingStatus.PROCESSED);
      expect(await suppression.isSuppressed('sms', p)).toBe(false);
    },
  );

  maybe(
    'never writes a phone number, the auth token or what a customer wrote to the log',
    async () => {
      const text = written.join('');
      expect(text).toContain('notifications/webhooks/twilio/inbound');
      for (const secret of [...phones.map((p) => p.slice(2)), AUTH_TOKEN, 'Priya']) {
        expect({ secret: secret.slice(0, 4), leaked: text.includes(secret) }).toEqual({
          secret: secret.slice(0, 4),
          leaked: false,
        });
      }
    },
  );
});
