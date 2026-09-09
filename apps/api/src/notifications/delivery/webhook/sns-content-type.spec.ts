import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createSign, createPrivateKey, type KeyObject } from 'node:crypto';
import {
  Module,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../prisma/prisma.service';
import { MetricsService } from '../../../metrics/metrics.service';
import { DeliveryRecorderService } from '../delivery-recorder.service';
import { DeliveryWebhookController } from './delivery-webhook.controller';
import { DeliveryWebhookService } from './delivery-webhook.service';
import { SnsVerifier, SNS_FETCH, type SnsEnvelope } from './sns-verifier';
import { SnsBodyMiddleware, applySnsBodyParser, SNS_WEBHOOK_ROUTE } from './sns-body.middleware';
import { SnsConfirmationService } from './sns-confirmation.service';
import { NotificationsModule } from '../../notifications.module';

/**
 * The content type Amazon actually posts.
 *
 * ── THE DEFECT THIS SUITE EXISTS FOR ───────────────────────────────────────────────
 * SNS delivers HTTPS notifications with `Content-Type: text/plain; charset=UTF-8`. It is a
 * JSON document sent under a text media type, and it has been that way for the life of the
 * service. Nest registers `express.json()`, which parses `application/json` and nothing else,
 * so under Express 5 the body of a genuine SNS request never reached the handler at all:
 * `req.body` stayed `undefined`, and `@Body()` handed the service nothing to verify.
 *
 * Every existing test passed. `sns-verifier.spec.ts` calls `verify()` with an object built in
 * the test file; the parser layer that would have produced that object in production is not
 * in the picture. So the endpoint was correct from the controller inwards and unreachable
 * from outside — and the first symptom would have been the SubscriptionConfirmation failing
 * in the AWS console, with no delivery events ever arriving and nothing in the logs to say
 * why.
 *
 * ── WHY THESE TESTS SPEAK HTTP ─────────────────────────────────────────────────────
 * A test that calls `service.ses({ body })` cannot see this bug, because constructing the
 * argument is precisely the step that was broken. The subject here is the wire: a real
 * server, a real socket, a real `Content-Type` header, and a real global prefix — because the
 * middleware is bound to a path and the prefix is part of that path.
 */

/** A throwaway key and a real self-signed certificate; see `sns-verifier.spec.ts`. */
function selfSigned(): { privateKey: KeyObject; certPem: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sns-ct-'));
  try {
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=sns-test',
    ]);
    return {
      privateKey: createPrivateKey(readFileSync(keyPath, 'utf8')),
      certPem: readFileSync(certPath, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let available = true;
let privateKey: KeyObject;
let certPem = '';
try {
  const generated = selfSigned();
  privateKey = generated.privateKey;
  certPem = generated.certPem;
} catch {
  available = false;
  // eslint-disable-next-line no-console
  console.warn('[sns-content-type] SKIPPED — openssl unavailable, cannot mint a test certificate');
}

const SECRET = 'path-secret-for-tests';
const TRUSTED_URL = 'https://sns.ap-south-2.amazonaws.com/SimpleNotificationService-abc.pem';

const FIELDS: Record<string, string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
  UnsubscribeConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
};

function signed(envelope: SnsEnvelope): SnsEnvelope {
  const fields = FIELDS[envelope.Type ?? ''];
  let canonical = '';
  for (const f of fields) {
    const v = (envelope as Record<string, unknown>)[f];
    if (v === undefined || v === null) continue;
    canonical += `${f}\n${String(v)}\n`;
  }
  const signer = createSign('RSA-SHA1');
  signer.update(canonical, 'utf8');
  return { ...envelope, Signature: signer.sign(privateKey, 'base64') };
}

/** A Notification whose SES payload carries nothing actionable, so no database is touched. */
function notification(): SnsEnvelope {
  return signed({
    Type: 'Notification',
    MessageId: 'msg-1',
    TopicArn: 'arn:aws:sns:ap-south-2:1234:eticketsgo-ses-events',
    Message: '{"eventType":"Send"}',
    Timestamp: '2026-09-08T10:00:00.000Z',
    SignatureVersion: '1',
    SigningCertURL: TRUSTED_URL,
  });
}

function confirmation(type: 'SubscriptionConfirmation' | 'UnsubscribeConfirmation'): SnsEnvelope {
  return signed({
    Type: type,
    MessageId: 'msg-confirm',
    TopicArn: 'arn:aws:sns:ap-south-2:1234:eticketsgo-ses-events',
    Message: 'You have chosen to subscribe to the topic.',
    SubscribeURL: 'https://sns.ap-south-2.amazonaws.com/?Action=ConfirmSubscription&Token=xyz',
    Token: 'xyz',
    Timestamp: '2026-09-08T10:00:00.000Z',
    SignatureVersion: '1',
    SigningCertURL: TRUSTED_URL,
  });
}

/**
 * The module under test.
 *
 * It binds the middleware through `applySnsBodyParser` — the SAME function the real
 * `NotificationsModule` calls — so the route string and the binding are shared rather than
 * restated here. A separate test asserts that `NotificationsModule` calls it.
 */
/** Mutable so a single test can unset the path secret without rebuilding the module. */
const state: {
  secret: string | undefined;
  fetchedCertUrls: string[];
  /** Every capture the webhook attempted. Empty is the assertion for an unverified message. */
  captured: { topicArn?: string; messageId?: string; subscribeUrl?: string }[];
} = {
  secret: undefined,
  fetchedCertUrls: [],
  captured: [],
};

@Module({
  controllers: [DeliveryWebhookController],
  providers: [
    DeliveryWebhookService,
    SnsVerifier,
    SnsBodyMiddleware,
    {
      provide: SNS_FETCH,
      useValue: (async (u: unknown) => {
        state.fetchedCertUrls.push(String(u));
        return { ok: true, text: async () => certPem };
      }) as unknown as typeof fetch,
    },
    {
      provide: ConfigService,
      useValue: { get: (key: string) => (key === 'SES_WEBHOOK_SECRET' ? state.secret : undefined) },
    },
    { provide: PrismaService, useValue: {} },
    { provide: DeliveryRecorderService, useValue: {} },
    { provide: MetricsService, useValue: { recordNotificationWebhook: jest.fn() } },
    {
      provide: SnsConfirmationService,
      useValue: {
        capture: async (input: Record<string, string | undefined>) => {
          state.captured.push(input);
        },
      },
    },
  ],
})
class WebhookTestModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    applySnsBodyParser(consumer);
  }
}

describe('the SES/SNS webhook over the wire', () => {
  let app: INestApplication;
  let url: string;
  const fetchedCertUrls = () => state.fetchedCertUrls;

  beforeEach(async () => {
    if (!available) return;
    state.fetchedCertUrls = [];
    state.captured = [];
    state.secret = SECRET;

    const moduleRef = await Test.createTestingModule({
      imports: [WebhookTestModule],
    }).compile();

    // Matches `main.ts`: raw body capture on, and the global prefix applied. The prefix is
    // load-bearing — middleware routes are resolved against it, so a middleware bound without
    // it would silently never run.
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}/api/notifications/webhooks/ses/${SECRET}`;
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  /** Posts exactly what Amazon posts: a JSON document under a text media type. */
  const post = (body: string, contentType = 'text/plain; charset=UTF-8') =>
    fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body });

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (!available) return;
      await fn();
    });

  maybe('accepts a signature-valid Notification sent as text/plain', async () => {
    const res = await post(JSON.stringify(notification()));
    expect(res.status).toBeLessThan(300);
    await expect(res.json()).resolves.toMatchObject({ received: true });
    // Proof the body was genuinely parsed: verification got far enough to fetch the cert.
    expect(fetchedCertUrls()).toEqual([TRUSTED_URL]);
  });

  maybe('accepts a SubscriptionConfirmation, and does not confirm it itself', async () => {
    const res = await post(JSON.stringify(confirmation('SubscriptionConfirmation')));
    expect(res.status).toBeLessThan(300);
    await expect(res.json()).resolves.toMatchObject({ received: true, applied: 0 });
    /*
      The SubscribeURL is on a trusted SNS host, so a naive implementation could have followed
      it and it would have looked fine. Only the certificate URL is ever fetched.
    */
    expect(fetchedCertUrls()).toEqual([TRUSTED_URL]);
  });

  maybe('accepts an UnsubscribeConfirmation without acting on it', async () => {
    const res = await post(JSON.stringify(confirmation('UnsubscribeConfirmation')));
    expect(res.status).toBeLessThan(300);
    await expect(res.json()).resolves.toMatchObject({ received: true, applied: 0 });
  });

  maybe('still accepts application/json, which the global parser handles', async () => {
    const res = await post(JSON.stringify(notification()), 'application/json');
    expect(res.status).toBeLessThan(300);
    expect(fetchedCertUrls()).toEqual([TRUSTED_URL]);
  });

  maybe('refuses a body tampered with after signing', async () => {
    const forged = { ...notification(), Message: '{"eventType":"Bounce"}' };
    const res = await post(JSON.stringify(forged));
    expect(res.status).toBe(401);
  });

  maybe('refuses a malformed JSON body', async () => {
    const res = await post('{"Type":"Notification"');
    expect(res.status).toBe(401);
    // Nothing unparseable may cause an outbound request.
    expect(fetchedCertUrls()).toEqual([]);
  });

  maybe('refuses an empty body rather than failing with a server error', async () => {
    const res = await post('');
    expect(res.status).toBe(401);
  });

  maybe('refuses everything when SES_WEBHOOK_SECRET is unset', async () => {
    state.secret = undefined;
    const res = await post(JSON.stringify(confirmation('SubscriptionConfirmation')));
    expect(res.status).toBe(401);
    // The path secret is checked first, so an unset secret costs no certificate fetch.
    expect(fetchedCertUrls()).toEqual([]);
  });

  maybe('refuses a body that parses to something other than an object', async () => {
    const res = await post('"just-a-string"');
    expect(res.status).toBe(401);
  });
  /*
    ── CAPTURE HAPPENS ONLY AFTER THE SIGNATURE IS PROVEN ──────────────────────────────
    The confirmation token is held so an operator can complete the manual step. That is only
    safe because the message has already been proven to come from Amazon. These three tests
    are the boundary: they go through the real HTTP path, the real body parser and the real
    verifier, and assert on whether anything was handed to the store at all.
  */
  maybe('captures a confirmation whose signature verifies', async () => {
    await post(JSON.stringify(confirmation('SubscriptionConfirmation')));
    expect(state.captured).toHaveLength(1);
    expect(state.captured[0]).toMatchObject({
      topicArn: 'arn:aws:sns:ap-south-2:1234:eticketsgo-ses-events',
      messageId: 'msg-confirm',
      subscribeUrl: 'https://sns.ap-south-2.amazonaws.com/?Action=ConfirmSubscription&Token=xyz',
    });
  });

  maybe('never captures a confirmation carrying no signature', async () => {
    const unsigned = { ...confirmation('SubscriptionConfirmation') };
    delete (unsigned as Record<string, unknown>).Signature;
    const res = await post(JSON.stringify(unsigned));
    expect(res.status).toBe(401);
    expect(state.captured).toEqual([]);
  });

  maybe('never captures a confirmation whose body was altered after signing', async () => {
    const tampered = {
      ...confirmation('SubscriptionConfirmation'),
      // The attacker's own topic. Signed for a different one, so verification must fail.
      TopicArn: 'arn:aws:sns:ap-south-2:9999:attacker-topic',
    };
    const res = await post(JSON.stringify(tampered));
    expect(res.status).toBe(401);
    expect(state.captured).toEqual([]);
  });

  maybe('never captures when the path secret is wrong, whatever the body says', async () => {
    state.secret = 'a-different-secret';
    const res = await post(JSON.stringify(confirmation('SubscriptionConfirmation')));
    expect(res.status).toBe(401);
    expect(state.captured).toEqual([]);
  });

  maybe('does not capture an UnsubscribeConfirmation, which would re-subscribe', async () => {
    const res = await post(JSON.stringify(confirmation('UnsubscribeConfirmation')));
    expect(res.status).toBeLessThan(300);
    expect(state.captured).toEqual([]);
  });
});

/**
 * The wiring, checked separately from the behaviour.
 *
 * ── WHY THIS IS ITS OWN SUITE ──────────────────────────────────────────────────────
 * The suite above proves the middleware works when it is bound. It builds its own module to
 * do that, so it would keep passing if somebody deleted `configure()` from the real
 * `NotificationsModule` — the exact regression that would put production back to answering
 * 500 to every message Amazon sends, with a green test run.
 *
 * So this asserts the two facts that suite cannot see: that the real module binds the parser,
 * and that the middleware is a provider Nest can actually construct. The second is not
 * theoretical on this codebase — `SnsVerifier` was added as an injectable with an
 * unresolvable constructor parameter and broke application boot while every unit test passed.
 */
describe('the real NotificationsModule', () => {
  it('binds the SNS body parser to the SES webhook route', () => {
    const applied: unknown[] = [];
    const routes: unknown[] = [];
    const consumer = {
      apply: (...middleware: unknown[]) => {
        applied.push(...middleware);
        return {
          forRoutes: (...r: unknown[]) => {
            routes.push(...r);
            return consumer;
          },
          exclude: () => consumer,
        };
      },
    } as unknown as MiddlewareConsumer;

    new NotificationsModule().configure(consumer);

    expect(applied).toContain(SnsBodyMiddleware);
    expect(routes).toContainEqual(SNS_WEBHOOK_ROUTE);
  });

  it('declares the middleware as a provider, so Nest can construct it at boot', () => {
    const providers = Reflect.getMetadata('providers', NotificationsModule) as unknown[];
    expect(providers).toContain(SnsBodyMiddleware);
  });
});
