import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DeliveryState,
  NotificationType,
  SuppressionReason,
  WebhookProcessingStatus,
} from '@eticketsgo/shared-types';
import { acquireSweepLock, type SweepLock } from '../../test-support/sweep-lock';
import { DeliveryRecorderService } from '../delivery-recorder.service';
import { SuppressionService } from '../suppression.service';
import { DeliveryWebhookService } from './delivery-webhook.service';
import { ProviderEventReplayService } from './provider-event-replay.service';

/**
 * integration-real-postgres — the callback ledger, SES included, and the opt-out lifecycle.
 *
 * The bookkeeping fix and the early-callback mechanism live in code every provider shares, and
 * SES is the one provider already certified. So SES goes through the same checks: its events
 * still apply, a hard bounce still suppresses exactly as before, and its ledger rows now settle
 * instead of staying RECEIVED.
 *
 * The opt-out cases pin the two rules that are new and easy to get wrong in opposite
 * directions: a person who opts back in must be textable again, and a person who opts out a
 * second time must not stay lifted -- while no other suppression reason changes behaviour.
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

const SECRET = 'ses-path-secret-for-tests';

describe('integration-real-postgres: callback ledger, SES regression and opt-out lifecycle', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  let suppression: SuppressionService;
  let recorder: DeliveryRecorderService;
  let replay: ProviderEventReplayService;
  let webhooks: DeliveryWebhookService;

  const suffix = `ledger-${Date.now()}`;
  const EMAIL = `ledger+${suffix}@example.test`;
  const BOUNCED = `bounced+${suffix}@example.test`;
  const PHONE = `+1212555${String(1000 + Math.floor(Math.random() * 9000))}`;
  const messageIds: string[] = [];
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
      sweepLock = await acquireSweepLock(url);
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    const user = await db.user.create({
      data: { email: EMAIL, passwordHash: 'x', fullName: 'Ledger Test', roles: ['CUSTOMER'] },
    });
    userId = user.id;
    suppression = new SuppressionService(db as never);
    recorder = new DeliveryRecorderService(db as never, suppression);
    replay = new ProviderEventReplayService(db as never, recorder);
    webhooks = new DeliveryWebhookService(
      db as never,
      { get: (k: string) => (k === 'SES_WEBHOOK_SECRET' ? SECRET : undefined) } as never,
      recorder,
      { recordNotificationWebhook: jest.fn(), recordNotificationDelivery: jest.fn() } as never,
      // The SNS signature is proven by the SES suites; here it is taken as verified.
      { verify: async () => ({ ok: true }) } as never,
    );
  }, 180_000);

  afterAll(async () => {
    if (db && available) {
      await db.notification.deleteMany({ where: { userId } });
      await db.user.deleteMany({ where: { email: { contains: suffix } } });
      await db.webhookEvent.deleteMany({
        where: { OR: messageIds.map((id) => ({ providerEventId: { startsWith: `${id}:` } })) },
      });
      await db.suppressedDestination.deleteMany({
        where: {
          destinationHash: {
            in: [
              SuppressionService.hash('email', BOUNCED),
              SuppressionService.hash('email', EMAIL),
              SuppressionService.hash('sms', PHONE),
            ],
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

  async function email(opts: { accepted: boolean }) {
    const messageId = `0100${randomBytes(12).toString('hex')}-000000`;
    messageIds.push(messageId);
    const notification = await db!.notification.create({
      data: {
        type: NotificationType.BOOKING_CONFIRMED,
        userId,
        toEmail: EMAIL,
        payload: { reference: messageId },
        channel: 'email',
        locale: 'en',
        status: 'SENT',
        sentAt: new Date(),
      },
    });
    const deliveryId = (await recorder.open({
      notificationId: notification.id,
      provider: 'ses',
      channel: 'email',
      attemptNumber: 1,
    }))!;
    if (opts.accepted) await recorder.accepted(deliveryId, 'ses', messageId);
    return { messageId, deliveryId };
  }

  const ses = (event: Record<string, unknown>) =>
    webhooks.ses({
      secret: SECRET,
      headers: { 'x-amz-sns-message-type': 'Notification' },
      body: { Type: 'Notification', Message: JSON.stringify(event) },
    });

  const ledger = (messageId: string) =>
    db!.webhookEvent.findMany({
      where: { provider: 'notification:ses', providerEventId: { startsWith: `${messageId}:` } },
    });
  const delivery = (id: string) => db!.notificationDelivery.findUnique({ where: { id } });

  describe('SES, through the shared ledger', () => {
    maybe('a delivery still applies, and its row now settles PROCESSED', async () => {
      const { messageId, deliveryId } = await email({ accepted: true });
      const at = new Date().toISOString();
      const res = await ses({
        eventType: 'Delivery',
        mail: { messageId, timestamp: at, destination: [EMAIL] },
        delivery: { timestamp: at },
      });
      expect(res).toMatchObject({ applied: 1 });
      expect((await delivery(deliveryId)).status).toBe(DeliveryState.DELIVERED);
      const [row] = await ledger(messageId);
      expect(row.processingStatus).toBe(WebhookProcessingStatus.PROCESSED);
    });

    maybe(
      'a permanent bounce suppresses the address as a hard bounce, exactly as before',
      async () => {
        const { messageId, deliveryId } = await email({ accepted: true });
        const at = new Date().toISOString();
        await ses({
          eventType: 'Bounce',
          mail: { messageId, timestamp: at, destination: [BOUNCED] },
          bounce: {
            bounceType: 'Permanent',
            timestamp: at,
            bouncedRecipients: [
              { emailAddress: BOUNCED, diagnosticCode: 'smtp; 550 5.1.1 unknown' },
            ],
          },
        });
        expect((await delivery(deliveryId)).status).toBe(DeliveryState.BOUNCED);
        const row = await db!.suppressedDestination.findUnique({
          where: {
            channel_destinationHash: {
              channel: 'email',
              destinationHash: SuppressionService.hash('email', BOUNCED),
            },
          },
        });
        expect(row).toMatchObject({
          reason: SuppressionReason.HARD_BOUNCE,
          destinationMask: SuppressionService.mask('email', BOUNCED),
          provider: 'ses',
        });
      },
    );

    maybe(
      'an SES event that beats its message id is held, then applied when the id is written',
      async () => {
        const { messageId, deliveryId } = await email({ accepted: false });
        const at = new Date().toISOString();
        const res = await ses({
          eventType: 'Delivery',
          mail: { messageId, timestamp: at, destination: [EMAIL] },
          delivery: { timestamp: at },
        });
        expect(res).toMatchObject({ applied: 0, duplicate: false });
        expect((await ledger(messageId))[0].processingStatus).toBe(
          WebhookProcessingStatus.AWAITING_CORRELATION,
        );

        await recorder.accepted(deliveryId, 'ses', messageId);
        expect(await replay.reapplyFor('ses', messageId)).toBe(1);
        expect((await delivery(deliveryId)).status).toBe(DeliveryState.DELIVERED);
        expect((await ledger(messageId))[0].processingStatus).toBe(
          WebhookProcessingStatus.PROCESSED,
        );
      },
    );
  });

  describe('the opt-out lifecycle', () => {
    maybe('an accepted send lifts an opt-out, and the next STOP re-arms it', async () => {
      await suppression.suppress({
        channel: 'sms',
        destination: PHONE,
        reason: SuppressionReason.UNSUBSCRIBED,
        provider: 'twilio',
      });
      expect(await suppression.isSuppressed('sms', PHONE)).toBe(true);

      expect(await suppression.liftProviderOptOut('sms', PHONE, 'twilio', 'accepted')).toBe(true);
      expect(await suppression.isSuppressed('sms', PHONE)).toBe(false);
      const lifted = await db!.suppressedDestination.findUnique({
        where: {
          channel_destinationHash: {
            channel: 'sms',
            destinationHash: SuppressionService.hash('sms', PHONE),
          },
        },
      });
      // Audited, never deleted.
      expect(lifted).toMatchObject({
        liftedBy: 'provider:twilio:accepted',
        reason: SuppressionReason.UNSUBSCRIBED,
      });

      await suppression.suppress({
        channel: 'sms',
        destination: PHONE,
        reason: SuppressionReason.UNSUBSCRIBED,
        provider: 'twilio',
      });
      expect(await suppression.isSuppressed('sms', PHONE)).toBe(true);
    });

    maybe('an accepted send never lifts a block that is not an opt-out', async () => {
      const hash = SuppressionService.hash('sms', PHONE);
      await db!.suppressedDestination.update({
        where: { channel_destinationHash: { channel: 'sms', destinationHash: hash } },
        data: { reason: SuppressionReason.BLOCKED_BY_PROVIDER },
      });
      expect(await suppression.liftProviderOptOut('sms', PHONE, 'twilio', 'accepted')).toBe(false);
      expect(await suppression.isSuppressed('sms', PHONE)).toBe(true);
    });

    maybe(
      'a lifted hard bounce is not re-armed: every other reason keeps its behaviour',
      async () => {
        await suppression.suppress({
          channel: 'email',
          destination: EMAIL,
          reason: SuppressionReason.HARD_BOUNCE,
        });
        const row = await db!.suppressedDestination.findUnique({
          where: {
            channel_destinationHash: {
              channel: 'email',
              destinationHash: SuppressionService.hash('email', EMAIL),
            },
          },
        });
        await suppression.lift(row.id, 'operator-1');
        await suppression.suppress({
          channel: 'email',
          destination: EMAIL,
          reason: SuppressionReason.HARD_BOUNCE,
        });
        expect(await suppression.isSuppressed('email', EMAIL)).toBe(false);
      },
    );
  });
});
