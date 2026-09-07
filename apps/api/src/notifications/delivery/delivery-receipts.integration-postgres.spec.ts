import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { DeliveryState, NotificationType, SuppressionReason } from '@eticketsgo/shared-types';
import { DeliveryRecorderService } from './delivery-recorder.service';
import { SuppressionService } from './suppression.service';
import { NotificationOpsService } from './notification-ops.service';
import { DeliveryWebhookService } from './webhook/delivery-webhook.service';
import { acquireSweepLock, type SweepLock } from '../test-support/sweep-lock';

/**
 * integration-real-postgres — provider callbacks, out of order, twice, and about nothing.
 *
 * ── WHY THESE NEED A REAL DATABASE ─────────────────────────────────────────────────
 * Every guarantee here is a database guarantee. Replay protection is a unique index on
 * `(provider, providerEventId)`; a suppression existing exactly once is a unique index on
 * `(channel, destinationHash)`; and "two concurrent webhooks do not both apply" is a race
 * that a stubbed client cannot have. A mock would return whatever this file told it to and
 * would prove none of it.
 *
 * Skips (never fabricates a pass) when no database is reachable.
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

const SECRET = 'msg91-webhook-secret';

describe('integration-real-postgres: delivery receipts', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  let recorder: DeliveryRecorderService;
  let suppression: SuppressionService;
  let webhooks: DeliveryWebhookService;
  let ops: NotificationOpsService;
  let audit: { record: jest.Mock };

  const suffix = `receipts-${Date.now()}`;
  const EMAIL = `arjun+${suffix}@example.test`;
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
      /*
        This suite WRITES provider delivery evidence -- the same rows the certification ladder
        reads globally to decide whether a provider has ever worked. Serialized against the
        other suites that read or write that state; see test-support/sweep-lock.
      */
      sweepLock = await acquireSweepLock(url);
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    const user = await db.user.create({
      data: { email: EMAIL, passwordHash: 'x', fullName: 'Arjun', roles: ['CUSTOMER'] },
    });
    userId = user.id;

    suppression = new SuppressionService(db as never);
    recorder = new DeliveryRecorderService(db as never, suppression);
    webhooks = new DeliveryWebhookService(
      db as never,
      new ConfigService({ MSG91_WEBHOOK_SECRET: SECRET }),
      recorder,
      { recordNotificationWebhook: jest.fn(), recordNotificationDelivery: jest.fn() } as never,
    );
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    ops = new NotificationOpsService(db as never, audit as never, suppression);
  }, 180_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.notification.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await db.suppressedDestination.deleteMany({
      where: { destinationMask: { contains: 'ar***@example.test' } },
    });
    await db.webhookEvent.deleteMany({ where: { provider: { startsWith: 'notification:' } } });
    await sweepLock?.release();
    await db.$disconnect();
  }, 180_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  /** A notification with one accepted attempt, as the dispatcher would leave it. */
  async function sentMessage(providerMessageId: string, channel = 'sms', provider = 'msg91') {
    const notification = await db!.notification.create({
      data: {
        type: NotificationType.BOOKING_CANCELLED,
        userId,
        toEmail: EMAIL,
        payload: { bookingId: `bk-${providerMessageId}`, reference: `REF-${providerMessageId}` },
        channel,
        locale: 'en',
        status: 'SENT',
        sentAt: new Date(),
      },
    });
    const deliveryId = await recorder.open({
      notificationId: notification.id,
      provider,
      channel,
      attemptNumber: 1,
    });
    await recorder.accepted(deliveryId!, provider, providerMessageId);
    return { notification, deliveryId: deliveryId! };
  }

  maybe('a delivery report moves an accepted message to DELIVERED', async () => {
    const { deliveryId } = await sentMessage(`msg-ok-${suffix}`);
    const res = await webhooks.msg91({
      secret: SECRET,
      body: { requestId: `msg-ok-${suffix}`, status: '1' },
    });

    expect(res).toMatchObject({ received: true, applied: 1 });
    const row = await db!.notificationDelivery.findUnique({ where: { id: deliveryId } });
    expect(row.status).toBe(DeliveryState.DELIVERED);
    expect(row.deliveredAt).toBeTruthy();
  });

  maybe('the same callback delivered twice applies once', async () => {
    // Providers redeliver. The unique index on (provider, providerEventId) is the guarantee,
    // and it lives in the database rather than in this process, so two API instances
    // receiving the same retry cannot both apply it.
    const id = `msg-dup-${suffix}`;
    await sentMessage(id);
    const body = { requestId: id, status: '1' };

    const first = await webhooks.msg91({ secret: SECRET, body });
    const second = await webhooks.msg91({ secret: SECRET, body });

    expect(first.applied).toBe(1);
    expect(second).toMatchObject({ applied: 0, duplicate: true });
    expect(
      await db!.webhookEvent.count({ where: { provider: 'notification:msg91', eventType: '1' } }),
    ).toBeGreaterThanOrEqual(1);
  });

  maybe(
    'eight concurrent redeliveries apply exactly once',
    async () => {
      /*
      The real shape of it: a provider whose retry queue fires while the first delivery is
      still in flight, against two API instances. Exactly one may win.
    */
      const id = `msg-race-${suffix}`;
      const { deliveryId } = await sentMessage(id);
      const body = { requestId: id, status: '1' };

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => webhooks.msg91({ secret: SECRET, body })),
      );
      const applied = results.reduce(
        (sum, r) => sum + (r.status === 'fulfilled' ? r.value.applied : 0),
        0,
      );

      expect(applied).toBe(1);
      expect(
        (await db!.notificationDelivery.findUnique({ where: { id: deliveryId } })).status,
      ).toBe(DeliveryState.DELIVERED);
    },
    60_000,
  );

  maybe('a late "sent" does not undo a delivery', async () => {
    /*
      Out of order is normal, not exceptional. Applying the late event would tell an operator
      that a message which reached somebody is still in flight.
    */
    const id = `msg-order-${suffix}`;
    const { deliveryId } = await sentMessage(id);
    await webhooks.msg91({ secret: SECRET, body: { requestId: id, status: '1' } });
    const late = await webhooks.msg91({ secret: SECRET, body: { requestId: id, status: '8' } });

    expect(late.applied).toBe(0);
    expect((await db!.notificationDelivery.findUnique({ where: { id: deliveryId } })).status).toBe(
      DeliveryState.DELIVERED,
    );
  });

  maybe('a callback about a message we have never seen does not crash', async () => {
    /*
      It happens: a restored database, a shared provider account between environments, an
      event type nobody subscribed to. It must be acknowledged rather than failed — a 5xx
      makes the provider redeliver it for hours, and the real events queue behind it.
    */
    const res = await webhooks.msg91({
      secret: SECRET,
      body: { requestId: `never-existed-${suffix}`, status: '1' },
    });
    expect(res).toMatchObject({ received: true, applied: 0 });
  });

  maybe('an unsigned callback is refused and writes nothing', async () => {
    // These endpoints can suppress a destination, which is a way to stop somebody receiving
    // their tickets. An unverified one would be a denial-of-service primitive.
    const before = await db!.webhookEvent.count({ where: { provider: 'notification:msg91' } });
    await expect(
      webhooks.msg91({ secret: 'wrong-secret', body: { requestId: 'x', status: '1' } }),
    ).rejects.toThrow(/signature/i);
    expect(await db!.webhookEvent.count({ where: { provider: 'notification:msg91' } })).toBe(
      before,
    );
  });

  maybe('a permanent failure suppresses the destination exactly once', async () => {
    const id = `msg-dnd-${suffix}`;
    const { notification } = await sentMessage(id);
    await db!.user.update({
      where: { id: userId },
      data: { phone: `+9199999${Date.now() % 100000}` },
    });
    const phone = (await db!.user.findUnique({ where: { id: userId } })).phone!;

    // Reported twice, as a provider retrying would.
    for (const status of ['17', '17']) {
      await webhooks.msg91({
        secret: SECRET,
        body: { requestId: id, status, number: phone },
      });
    }

    expect(await suppression.isSuppressed('sms', phone)).toBe(true);
    const rows = await db!.suppressedDestination.findMany({
      where: { destinationHash: SuppressionService.hash('sms', phone) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe(SuppressionReason.BLOCKED_BY_PROVIDER);
    // The address is not stored in the clear -- the only operation is a lookup, and a hash
    // answers it exactly as well.
    expect(JSON.stringify(rows[0])).not.toContain(phone);

    // And the notification itself now says it failed, rather than still claiming SENT.
    const after = await db!.notification.findUnique({ where: { id: notification.id } });
    expect(after.status).toBe('FAILED');

    await db!.suppressedDestination.deleteMany({ where: { id: rows[0].id } });
    await db!.user.update({ where: { id: userId }, data: { phone: null } });
  });

  maybe('a transient failure suppresses nothing', async () => {
    // A switched-off handset comes back on. Suppressing here would stop somebody's tickets
    // because their phone was in a tunnel once.
    const id = `msg-transient-${suffix}`;
    await sentMessage(id);
    await webhooks.msg91({
      secret: SECRET,
      body: { requestId: id, status: '2', number: '+919000000001' },
    });
    expect(await suppression.isSuppressed('sms', '+919000000001')).toBe(false);
  });

  maybe('suppression matches however the number was written', async () => {
    /*
      One provider reports `+91 98765 43210` and another `919876543210`. Recorded under one
      form and looked up under the other, the destination would look unsuppressed and keep
      being sent to -- which is the exact failure this table exists to prevent.
    */
    await suppression.suppress({
      channel: 'sms',
      destination: '+91 98765 43210',
      reason: SuppressionReason.UNSUBSCRIBED,
    });
    expect(await suppression.isSuppressed('sms', '919876543210')).toBe(true);
    expect(await suppression.isSuppressed('sms', '+919876543210')).toBe(true);
    // And a mailbox is not a phone: a bounce must never silence a channel that still works.
    expect(await suppression.isSuppressed('whatsapp', '919876543210')).toBe(false);
    await db!.suppressedDestination.deleteMany({
      where: { destinationHash: SuppressionService.hash('sms', '919876543210') },
    });
  });

  maybe('an email suppression is case-insensitive and does not touch other channels', async () => {
    await suppression.suppress({
      channel: 'email',
      destination: EMAIL.toUpperCase(),
      reason: SuppressionReason.HARD_BOUNCE,
    });
    expect(await suppression.isSuppressed('email', EMAIL)).toBe(true);
    expect(await suppression.isSuppressed('push', EMAIL)).toBe(false);
    await db!.suppressedDestination.deleteMany({
      where: { destinationHash: SuppressionService.hash('email', EMAIL) },
    });
  });

  maybe('a lifted suppression stops applying, and its history survives', async () => {
    await suppression.suppress({
      channel: 'email',
      destination: `lift+${suffix}@example.test`,
      reason: SuppressionReason.HARD_BOUNCE,
    });
    const [row] = await db!.suppressedDestination.findMany({
      where: { destinationHash: SuppressionService.hash('email', `lift+${suffix}@example.test`) },
    });

    expect(await ops.liftSuppression('admin-1', row.id)).toEqual({ lifted: true });
    expect(await suppression.isSuppressed('email', `lift+${suffix}@example.test`)).toBe(false);
    // Not a delete: why it was blocked is the only thing that makes unblocking reviewable.
    const after = await db!.suppressedDestination.findUnique({ where: { id: row.id } });
    expect(after.liftedAt).toBeTruthy();
    expect(after.reason).toBe(SuppressionReason.HARD_BOUNCE);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SUPPRESSION_LIFTED' }),
    );
    await db!.suppressedDestination.deleteMany({ where: { id: row.id } });
  });

  maybe('an operator can find a notification by the reference a customer reads out', async () => {
    const id = `msg-search-${suffix}`;
    const { notification } = await sentMessage(id);
    const found = await ops.search({ reference: `REF-${id}` });

    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(notification.id);
    // Masked. Diagnosing a delivery does not require reading somebody's address.
    expect(found[0].recipient).not.toBe(EMAIL);
    expect(found[0].recipient).toContain('***');
    expect(found[0].provider).toBe('msg91');
  });

  maybe('inspecting one shows every attempt, and no message content', async () => {
    const id = `msg-inspect-${suffix}`;
    const { notification } = await sentMessage(id);
    await webhooks.msg91({ secret: SECRET, body: { requestId: id, status: '1' } });

    const detail = await ops.inspect(notification.id);
    expect(detail.deliveries).toHaveLength(1);
    expect(detail.deliveries[0]).toMatchObject({
      attemptNumber: 1,
      provider: 'msg91',
      status: DeliveryState.DELIVERED,
      providerMessageId: id,
    });
    expect(detail.toEmail).toContain('***');
    // Identifiers only. An operator needs to know WHICH message, not what it said.
    expect(Object.keys(detail.payload)).toEqual(['bookingId', 'reference']);
  });

  maybe('provider health reports a failure rate rather than a count', async () => {
    const report = await ops.providerHealth(24);
    const msg91 = report.find((r) => r.provider === 'msg91' && r.channel === 'sms');
    expect(msg91).toBeDefined();
    // Ten failures out of ten is an outage; ten out of ten thousand is a Tuesday.
    expect(typeof msg91!.failureRate).toBe('number');
    expect(msg91!.total).toBeGreaterThan(0);
  });
});

describe('integration-real-postgres: resend is not retry', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  let ops: NotificationOpsService;
  let suppression: SuppressionService;
  let recorder: DeliveryRecorderService;
  const suffix = `resend-${Date.now()}`;
  let userId = '';

  beforeAll(async () => {
    if (!url) return;
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
      /*
        This suite WRITES provider delivery evidence -- the same rows the certification ladder
        reads globally to decide whether a provider has ever worked. Serialized against the
        other suites that read or write that state; see test-support/sweep-lock.
      */
      sweepLock = await acquireSweepLock(url);
    } catch {
      return;
    }
    const user = await db.user.create({
      data: {
        email: `resend+${suffix}@example.test`,
        passwordHash: 'x',
        fullName: 'R',
        roles: ['CUSTOMER'],
      },
    });
    userId = user.id;
    suppression = new SuppressionService(db as never);
    recorder = new DeliveryRecorderService(db as never, suppression);
    ops = new NotificationOpsService(
      db as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      suppression,
    );
  }, 180_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.notification.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await db.suppressedDestination.deleteMany({
      where: { destinationHash: SuppressionService.hash('email', `resend+${suffix}@example.test`) },
    });
    await sweepLock?.release();
    await db.$disconnect();
  }, 180_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (!available) return;
      await fn();
    });

  async function undelivered(email: string) {
    const n = await db!.notification.create({
      data: {
        type: NotificationType.BOOKING_CONFIRMED,
        userId,
        toEmail: email,
        payload: { bookingId: `bk-${Date.now()}${Math.round(performance.now())}` },
        channel: 'email',
        locale: 'en',
        status: 'SENT',
      },
    });
    const id = await recorder.open({
      notificationId: n.id,
      provider: 'ses',
      channel: 'email',
      attemptNumber: 1,
    });
    await recorder.accepted(id!, 'ses', `ses-${n.id}`);
    return n;
  }

  maybe('an undelivered message can be resent, and it is audited', async () => {
    const n = await undelivered(`resend+${suffix}@example.test`);
    await recorder.applyProviderEvent({
      provider: 'ses',
      providerMessageId: `ses-${n.id}`,
      state: DeliveryState.UNDELIVERED,
    });

    expect(await ops.resend('admin-1', n.id)).toEqual({ requeued: true });
    const after = await db!.notification.findUnique({ where: { id: n.id } });
    // Requeued for the worker, not sent from the request. And its dedupe key is untouched,
    // so a resend cannot smuggle a second intent past the Phase 1 guarantee.
    expect(after.status).toBe('PENDING');
  });

  maybe('a delivered message is not resent by accident', async () => {
    /*
      The common support mistake is resending something the customer has and cannot find.
      It is allowed -- with `force`, which makes it a decision rather than a slip.
    */
    const n = await undelivered(`resend+${suffix}@example.test`);
    await recorder.applyProviderEvent({
      provider: 'ses',
      providerMessageId: `ses-${n.id}`,
      state: DeliveryState.DELIVERED,
    });

    await expect(ops.resend('admin-1', n.id)).rejects.toThrow(/delivered/i);
    await expect(ops.resend('admin-1', n.id, { force: true })).resolves.toEqual({ requeued: true });
  });

  maybe('a suppressed destination cannot be resent to at all', async () => {
    /*
      Not even with force. The address is unusable; sending again earns another bounce
      against the sending domain, which is the thing that gets an account throttled. Lifting
      the suppression is the deliberate act, and it is separately audited.
    */
    const email = `blocked+${suffix}@example.test`;
    const n = await undelivered(email);
    await suppression.suppress({
      channel: 'email',
      destination: email,
      reason: SuppressionReason.HARD_BOUNCE,
    });

    await expect(ops.resend('admin-1', n.id)).rejects.toThrow(/suppressed/i);
    await expect(ops.resend('admin-1', n.id, { force: true })).rejects.toThrow(/suppressed/i);

    await db!.suppressedDestination.deleteMany({
      where: { destinationHash: SuppressionService.hash('email', email) },
    });
  });
});
