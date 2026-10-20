import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { KeyObject } from 'node:crypto';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { SnsEnvelope } from './sns-verifier';
import {
  confirmSubscriptionResponse,
  mintSnsTestCertificate,
  signSnsEnvelope,
  snsSubscribeUrl,
} from '../../test-support/sns-signing';

/**
 * integration-real-postgres, WHOLE APP over HTTP: the SES webhook confirms an SNS subscription
 * itself, and only when every check holds (ADR-054).
 *
 * ── WHAT IS REAL AND WHAT IS NOT ───────────────────────────────────────────────────
 * Real: AppModule, the global prefix, the route-scoped text/plain body parser, the path
 * secret, the signature verifier, the topic allowlist, the SubscribeURL validator, Postgres,
 * the audit log and the request logger. Messages are signed with a locally minted key and a
 * real self-signed X.509 certificate, the way Amazon signs them.
 *
 * Replaced: the SNS HTTP client (the SNS_FETCH provider) -- the only thing that would leave
 * this machine. It serves the test certificate at the signing URL, answers
 * ConfirmSubscription like Amazon, and RECORDS every URL it is asked for. "Calls the
 * SubscribeURL exactly once" and "calls it zero times" are assertions on that record.
 *
 * ── TWO MODES ──────────────────────────────────────────────────────────────────────
 * LOCAL, and PRODUCTION. AppModule cannot boot with APP_ENV=PRODUCTION on a laptop (the boot
 * guards rightly demand live credentials and a secret store), so the PRODUCTION run boots the
 * same AppModule and hands the three webhook classes a ConfigService that answers
 * APP_ENV=PRODUCTION and delegates everything else to the real one. The webhook and the
 * confirmation code therefore see exactly what they would see in production.
 *
 * Skips (never fabricates a pass) without a database or without openssl.
 */

function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../../../../.env', '../../../../../.env']) {
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

const SUFFIX = `${Date.now()}`;
const SECRET = `sns-auto-confirm-path-secret-${SUFFIX}`;
const TOPIC_LOCAL = `arn:aws:sns:ap-south-1:668506406280:auto-confirm-local-${SUFFIX}`;
const TOPIC_PROD = `arn:aws:sns:ap-south-1:668506406280:auto-confirm-prod-${SUFFIX}`;
const NOT_ALLOWED = `arn:aws:sns:ap-south-1:999999999999:attacker-${SUFFIX}`;
const CERT_URL = 'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-test.pem';
const UNTRUSTED_CERT_URL =
  'https://sns.ap-south-1.amazonaws.com.evil.com/SimpleNotificationService-test.pem';

const minted = mintSnsTestCertificate();
let n = 0;
const token = () => `${SUFFIX}${(++n).toString().padStart(4, '0')}`.padEnd(64, 'c');

/** The stand-in for Amazon. Everything the app asks the network for lands in `requested`. */
const net = {
  requested: [] as string[],
  confirmCalls: () => net.requested.filter((u) => u.includes('Action=ConfirmSubscription')),
  mode: 'ok' as 'ok' | 'redirect',
};
const snsFetch = (async (input: unknown) => {
  const url = String(input);
  net.requested.push(url);
  if (url === CERT_URL) return new Response(minted?.certPem ?? '', { status: 200 });
  if (url.startsWith('https://sns.ap-south-1.amazonaws.com/?')) {
    if (net.mode === 'redirect') {
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    }
    const topic = new URL(url).searchParams.get('TopicArn') ?? '';
    return new Response(confirmSubscriptionResponse(topic), { status: 200 });
  }
  // Anything else is a request this design must never make.
  return new Response('unexpected', { status: 599 });
}) as unknown as typeof fetch;

describe.each(['LOCAL', 'PRODUCTION'] as const)(
  'integration-real-postgres: SNS auto-confirmation over HTTP, APP_ENV=%s',
  (mode) => {
    const url = loadDatabaseUrl();
    const TOPIC = mode === 'PRODUCTION' ? TOPIC_PROD : TOPIC_LOCAL;
    let db: Client | undefined;
    let app: INestApplication | undefined;
    let base = '';
    let available = false;
    const written: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    const tokensUsed: string[] = [];

    beforeAll(async () => {
      if (!url || !minted) {
        // eslint-disable-next-line no-console
        console.warn('[integration-real-postgres] SKIPPED -- no DATABASE_URL or no openssl');
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
      process.env.THROTTLE_LIMIT = '100000';
      process.env.AUTH_THROTTLE_LIMIT = '100000';
      process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-for-sns-auto-confirm-0123456789';
      process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-for-sns-auto-confirm-0123456789';
      process.env.QR_SIGNING_SECRET ??= 'test-qr-secret-for-sns-auto-confirm-0123456789';
      process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret-for-sns-auto-confirm-012345';
      process.env.SES_WEBHOOK_SECRET = SECRET;
      // Both modes' topics, set before AppModule is first imported (config is read then).
      process.env.SES_SNS_TOPIC_ARNS = `${TOPIC_LOCAL}, ${TOPIC_PROD}`;

      const { AppModule } = await import('../../../app.module');
      const { AllExceptionsFilter } = await import('../../../common/all-exceptions.filter');
      const { SNS_FETCH, SnsVerifier } = await import('./sns-verifier');
      const { SnsConfirmationService } = await import('./sns-confirmation.service');
      const { DeliveryWebhookService } = await import('./delivery-webhook.service');
      const { PrismaService } = await import('../../../prisma/prisma.service');
      const { AuditService } = await import('../../../audit/audit.service');
      const { MetricsService } = await import('../../../metrics/metrics.service');
      const { DeliveryRecorderService } = await import('../delivery-recorder.service');
      const { SuppressionService } = await import('../suppression.service');

      let builder = Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SNS_FETCH)
        .useValue(snsFetch);

      if (mode === 'PRODUCTION') {
        /** The real configuration, except that it says PRODUCTION. */
        const productionView = (real: ConfigService) =>
          ({
            get: (key: string, fallback?: unknown) =>
              key === 'APP_ENV' ? 'PRODUCTION' : real.get(key, fallback as never),
            getOrThrow: (key: string) => (key === 'APP_ENV' ? 'PRODUCTION' : real.getOrThrow(key)),
          }) as unknown as ConfigService;
        builder = builder
          .overrideProvider(SnsVerifier)
          .useFactory({
            factory: (real: ConfigService, f: typeof fetch) =>
              new SnsVerifier(f, productionView(real)),
            inject: [ConfigService, SNS_FETCH],
          })
          .overrideProvider(SnsConfirmationService)
          .useFactory({
            factory: (p: never, real: ConfigService, a: never, v: never, f: typeof fetch) =>
              new SnsConfirmationService(p, productionView(real), a, v, f),
            inject: [PrismaService, ConfigService, AuditService, SnsVerifier, SNS_FETCH],
          })
          .overrideProvider(DeliveryWebhookService)
          .useFactory({
            factory: (
              p: never,
              real: ConfigService,
              r: never,
              m: never,
              v: never,
              c: never,
              s: never,
            ) => new DeliveryWebhookService(p, productionView(real), r, m, v, c, s),
            inject: [
              PrismaService,
              ConfigService,
              DeliveryRecorderService,
              MetricsService,
              SnsVerifier,
              SnsConfirmationService,
              SuppressionService,
            ],
          });
      }

      const capture = (chunk: unknown) => {
        written.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString(),
        );
        return true;
      };
      process.stdout.write = capture as typeof process.stdout.write;
      process.stderr.write = capture as typeof process.stderr.write;

      const mod = await builder.compile();
      // As main.ts: raw body on, the global prefix applied, a real console logger.
      app = mod.createNestApplication({ rawBody: true });
      app.useLogger(new ConsoleLogger());
      app.setGlobalPrefix('api');
      app.useGlobalFilters(new AllExceptionsFilter());
      await app.listen(0, '127.0.0.1');
      base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

      // The webhook really is seeing the environment this run is named for.
      const seen = app.get(SnsConfirmationService) as unknown as { config: ConfigService };
      expect(seen.config.get('APP_ENV')).toBe(mode);
    }, 240_000);

    afterAll(async () => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      if (app) await app.close();
      if (db && available) {
        const rows = await db.snsPendingConfirmation.findMany({
          where: { topicArn: { in: [TOPIC, NOT_ALLOWED] } },
          select: { id: true },
        });
        await db.auditLog.deleteMany({
          where: { entityId: { in: rows.map((r: { id: string }) => r.id) } },
        });
        await db.snsPendingConfirmation.deleteMany({
          where: { topicArn: { in: [TOPIC, NOT_ALLOWED] } },
        });
      }
      if (db) await db.$disconnect();
    }, 120_000);

    beforeEach(() => {
      net.requested.length = 0;
      net.mode = 'ok';
    });

    const maybe = (name: string, fn: () => Promise<void>) =>
      it(
        name,
        async () => {
          if (!available) return;
          await fn();
        },
        60_000,
      );

    /** A SubscriptionConfirmation as Amazon would send it, signed with the test key. */
    function confirmation(over: Partial<SnsEnvelope> = {}, version: '1' | '2' = '1') {
      const t = over.Token ?? token();
      tokensUsed.push(t);
      const topic = over.TopicArn ?? TOPIC;
      return signSnsEnvelope(
        {
          Type: 'SubscriptionConfirmation',
          MessageId: `msg-${t.slice(0, 20)}`,
          TopicArn: topic,
          Token: t,
          SubscribeURL: snsSubscribeUrl(topic, t),
          Message: `You have chosen to subscribe to the topic ${topic}.`,
          Timestamp: '2026-10-20T10:00:00.000Z',
          SignatureVersion: version,
          SigningCertURL: CERT_URL,
          ...over,
        },
        minted!.privateKey as KeyObject,
      );
    }

    const post = (body: unknown, secret = SECRET, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/notifications/webhooks/ses/${secret}`, {
        method: 'POST',
        // Exactly what Amazon sends: JSON under a text media type.
        headers: { 'content-type': 'text/plain; charset=UTF-8', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    const rowFor = (topicArn: string) =>
      db!.snsPendingConfirmation.findMany({ where: { topicArn } });

    maybe('a valid confirmation calls the SubscribeURL exactly once and records it', async () => {
      const msg = confirmation();
      const res = await post(msg, SECRET, { 'x-amz-sns-message-type': 'SubscriptionConfirmation' });
      expect(res.status).toBeLessThan(300);
      await expect(res.json()).resolves.toMatchObject({ received: true, duplicate: false });

      expect(net.confirmCalls()).toEqual([new URL(msg.SubscribeURL!).toString()]);
      const rows = await rowFor(TOPIC);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'CONFIRMED', attemptCount: 1 });
      expect(rows[0].subscribeUrl).not.toContain(msg.Token);

      const audit = await db!.auditLog.findFirst({
        where: { entityId: rows[0].id, action: 'SNS_SUBSCRIPTION_CONFIRMED' },
      });
      expect(audit).not.toBeNull();
      expect(JSON.stringify(audit)).not.toContain(msg.Token);
    });

    maybe('a redelivery of the same confirmation is a no-op: still one request', async () => {
      const msg = confirmation();
      await post(msg);
      const again = await post(msg);
      expect(again.status).toBeLessThan(300);
      await expect(again.json()).resolves.toMatchObject({ duplicate: true });
      expect(net.confirmCalls()).toHaveLength(1);
    });

    maybe('a SignatureVersion 2 confirmation is confirmed too', async () => {
      const res = await post(confirmation({}, '2'));
      expect(res.status).toBeLessThan(300);
      expect(net.confirmCalls()).toHaveLength(1);
    });

    maybe('a topic that is not on the allowlist: 401, zero confirm calls', async () => {
      const res = await post(confirmation({ TopicArn: NOT_ALLOWED }));
      expect(res.status).toBe(401);
      expect(net.confirmCalls()).toHaveLength(0);
      expect(await rowFor(NOT_ALLOWED)).toHaveLength(0);
    });

    maybe('a SubscribeURL on another host: 401, zero confirm calls', async () => {
      const t = token();
      const res = await post(
        confirmation({
          Token: t,
          SubscribeURL: snsSubscribeUrl(TOPIC, t).replace('sns.ap-south-1.', 'sns.us-east-1.'),
        }),
      );
      expect(res.status).toBe(401);
      expect(net.requested.filter((u) => u !== CERT_URL)).toEqual([]);
    });

    maybe('a SubscribeURL naming another topic: 401, zero confirm calls', async () => {
      const t = token();
      const res = await post(
        confirmation({ Token: t, SubscribeURL: snsSubscribeUrl(NOT_ALLOWED, t) }),
      );
      expect(res.status).toBe(401);
      expect(net.confirmCalls()).toHaveLength(0);
    });

    maybe('a body altered after signing: 401, zero confirm calls', async () => {
      const msg = confirmation();
      const res = await post({ ...msg, Message: 'altered' });
      expect(res.status).toBe(401);
      expect(net.confirmCalls()).toHaveLength(0);
    });

    maybe('an untrusted certificate host: 401, and nothing at all is fetched', async () => {
      const res = await post(confirmation({ SigningCertURL: UNTRUSTED_CERT_URL }));
      expect(res.status).toBe(401);
      expect(net.requested).toEqual([]);
    });

    maybe('a wrong path secret: 401, and nothing at all is fetched', async () => {
      const res = await post(confirmation(), 'not-the-secret');
      expect(res.status).toBe(401);
      expect(net.requested).toEqual([]);
    });

    maybe('a header that claims Notification does not skip the signed type', async () => {
      // The header is unsigned. The body says SubscriptionConfirmation and is signed as one.
      const res = await post(confirmation(), SECRET, { 'x-amz-sns-message-type': 'Notification' });
      expect(res.status).toBeLessThan(300);
      expect(net.confirmCalls()).toHaveLength(1);
    });

    maybe('a redirect from the SubscribeURL is not followed: 502, not confirmed', async () => {
      net.mode = 'redirect';
      const msg = confirmation();
      const res = await post(msg);
      expect(res.status).toBe(502);
      // One request, to the validated URL; evil.example never requested.
      expect(net.requested.filter((u) => u !== CERT_URL)).toEqual([
        new URL(msg.SubscribeURL!).toString(),
      ]);
      // Recorded as a retryable failure, not as confirmed.
      expect(
        (await rowFor(TOPIC)).filter(
          (r: { status: string; lastFailure: string | null }) =>
            r.lastFailure === 'redirect_refused' && r.status === 'PENDING',
        ),
      ).toHaveLength(1);
    });

    maybe('an UnsubscribeConfirmation is acknowledged and never acted on', async () => {
      const t = token();
      const res = await post(
        signSnsEnvelope(
          {
            Type: 'UnsubscribeConfirmation',
            MessageId: `unsub-${t.slice(0, 20)}`,
            TopicArn: TOPIC,
            Token: t,
            SubscribeURL: snsSubscribeUrl(TOPIC, t),
            Message: 'You have chosen to deactivate subscription.',
            Timestamp: '2026-10-20T10:00:00.000Z',
            SignatureVersion: '1',
            SigningCertURL: CERT_URL,
          },
          minted!.privateKey as KeyObject,
        ),
      );
      expect(res.status).toBeLessThan(300);
      expect(net.confirmCalls()).toHaveLength(0);
    });

    maybe('delivery notifications are processed as before', async () => {
      const res = await post(
        signSnsEnvelope(
          {
            Type: 'Notification',
            MessageId: `note-${SUFFIX}-${mode}`,
            TopicArn: TOPIC,
            // An event type nothing acts on, so no notification rows are needed.
            Message: '{"eventType":"Send"}',
            Timestamp: '2026-10-20T10:00:00.000Z',
            SignatureVersion: '1',
            SigningCertURL: CERT_URL,
          },
          minted!.privateKey as KeyObject,
        ),
      );
      expect(res.status).toBeLessThan(300);
      await expect(res.json()).resolves.toMatchObject({ received: true, applied: 0 });
      expect(net.confirmCalls()).toHaveLength(0);
    });

    maybe('no token, and no ConfirmSubscription query, ever reached the log', async () => {
      const log = written.join('');
      expect(log).toContain('SNS subscription CONFIRMED automatically');
      expect(log).toContain('/api/notifications/webhooks/ses/[REDACTED]');
      expect(log).not.toContain(SECRET);
      for (const t of tokensUsed) expect(log).not.toContain(t);
      expect(log).not.toContain('Action=ConfirmSubscription');
    });
  },
);
