import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationService } from '../notification.service';
import { NotificationPreferencesService } from '../notification-preferences.service';
import { MarketingConsentService } from '../marketing-consent.service';
import { DeliveryRecorderService } from './delivery-recorder.service';
import { SuppressionService } from './suppression.service';
import { NotificationOpsService } from './notification-ops.service';
import { acquireSweepLock, type SweepLock } from '../test-support/sweep-lock';

/**
 * integration-real-postgres -- a message that did not leave the platform is never SENT.
 *
 * -- WHAT QA SHOWED ----------------------------------------------------------------
 * 73 WhatsApp notifications said SENT, provider `none`, reason `no_destination`, while their
 * attempt rows said REJECTED -- two records about one message, both wrong. 412 pushes and
 * every logged email said SENT with provider `log`, and their attempts said ACCEPTED, so an
 * environment with a channel left on `log` reported messages delivered that went nowhere.
 * Retries were filed as first sends, and an operator resend of a sent message was not
 * recorded at all because it collided with the first attempt's number.
 *
 * Every assertion here reads the real rows the sweep wrote, through the real recorder.
 * Skips rather than fabricating a pass when no database is reachable.
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

describe('integration-real-postgres: delivery records tell the truth', () => {
  const url = loadDatabaseUrl();
  let db: PrismaClient | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  let deliver: jest.Mock;
  let notifications: NotificationService;
  let ops: NotificationOpsService;

  const suffix = `truth-${Date.now()}`;
  let userId = '';

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db.$queryRaw`SELECT 1`;
      available = true;
      // A global sweep: serialized against every other suite that runs one.
      sweepLock = await acquireSweepLock(url);
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }
    userId = (
      await db.user.create({
        data: {
          email: `ana+${suffix}@example.test`,
          passwordHash: 'x',
          fullName: 'Ana',
          roles: ['CUSTOMER'],
        },
      })
    ).id;
    deliver = jest.fn();
    const suppression = new SuppressionService(db as never);
    notifications = new NotificationService(
      db as never,
      { render: () => ({ subject: 'S', body: 'B' }) } as never,
      new NotificationPreferencesService(db as never) as never,
      {
        has: () => true,
        resolve: (c: string) => ({ key: c, deliver: (m: unknown) => deliver(c, m) }),
      } as never,
      new MarketingConsentService(db as never) as never,
      undefined,
      new DeliveryRecorderService(db as never, suppression),
      suppression,
    );
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
    await sweepLock?.release();
    await db.$disconnect();
  }, 180_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (!available) return;
      await fn();
    });

  /** One due notification, written the way the enqueue path writes it. */
  async function due(channel: string, tag: string) {
    return db!.notification.create({
      data: {
        type: NotificationType.BOOKING_CONFIRMED,
        userId,
        toEmail: `ana+${suffix}@example.test`,
        channel,
        locale: 'en',
        status: 'PENDING',
        scheduledFor: new Date(Date.now() - 1_000),
        bookingId: `${tag}-${suffix}`,
        payload: { bookingId: `${tag}-${suffix}` },
      },
    });
  }

  const attemptsOf = (notificationId: string) =>
    db!.notificationDelivery.findMany({
      where: { notificationId },
      orderBy: { attemptNumber: 'asc' },
    });

  maybe('a WhatsApp with nowhere to go is SKIPPED, and so is its attempt', async () => {
    deliver.mockReset();
    deliver.mockResolvedValue({ provider: 'none', skipped: true, reason: 'no_destination' });
    const n = await due('whatsapp', 'skip');

    await notifications.dispatchDue();

    const row = await db!.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(row.status).toBe('SKIPPED');
    expect(row.lastError).toBe('no_destination');
    expect(row.sentAt).toBeNull();
    const [attempt] = await attemptsOf(n.id);
    // Not REJECTED: no provider was asked, so no provider refused anything.
    expect(attempt.status).toBe('SKIPPED');
    expect(attempt.outcomeClass).toBe('NO_DESTINATION');
  });

  maybe('a log-mode email is LOGGED, never accepted, never priced', async () => {
    deliver.mockReset();
    deliver.mockResolvedValue({ provider: 'log' });
    const n = await due('email', 'log');

    await notifications.dispatchDue();

    const row = await db!.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(row.status).toBe('LOGGED');
    expect(row.provider).toBe('log');
    expect(row.lastError).toBe('log_mode_not_delivered');
    expect(row.sentAt).toBeNull();
    const [attempt] = await attemptsOf(n.id);
    expect(attempt.status).toBe('LOGGED');
    expect(attempt.outcomeClass).toBe('LOG_ONLY');
    // Certification reads `acceptedAt` as proof a provider worked. A log line is not that.
    expect(attempt.acceptedAt).toBeNull();
    expect(attempt.costSource).toBe('UNKNOWN');
  });

  maybe('a provider that took it is SENT, with its reference on the attempt', async () => {
    deliver.mockReset();
    deliver.mockResolvedValue({ provider: 'ses', providerMessageId: `ses-${suffix}` });
    const n = await due('email', 'ses');

    await notifications.dispatchDue();

    const row = await db!.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(row.status).toBe('SENT');
    expect(row.sentAt).toBeInstanceOf(Date);
    const [attempt] = await attemptsOf(n.id);
    expect(attempt.status).toBe('ACCEPTED');
    expect(attempt.providerMessageId).toBe(`ses-${suffix}`);
  });

  maybe('an automatic retry is filed as a RETRY, not as another first send', async () => {
    deliver.mockReset();
    deliver
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ provider: 'ses', providerMessageId: `retry-${suffix}` });
    const n = await due('email', 'retry');

    await notifications.dispatchDue();
    // The retry waits; bring it due rather than waiting a real minute.
    await db!.notification.update({
      where: { id: n.id },
      data: { scheduledFor: new Date(Date.now() - 1_000) },
    });
    await notifications.dispatchDue();

    const attempts = await attemptsOf(n.id);
    expect(attempts.map((a) => [a.attemptNumber, a.sendKind, a.status])).toEqual([
      [1, 'PRIMARY', 'FAILED'],
      [2, 'RETRY', 'ACCEPTED'],
    ]);
  });

  maybe('an operator resend of a sent message is recorded as a second attempt', async () => {
    deliver.mockReset();
    deliver
      .mockResolvedValueOnce({ provider: 'ses', providerMessageId: `first-${suffix}` })
      .mockResolvedValueOnce({ provider: 'ses', providerMessageId: `again-${suffix}` });
    const n = await due('email', 'resend');
    await notifications.dispatchDue();

    await ops.resend('operator', n.id);
    await notifications.dispatchDue();

    const attempts = await attemptsOf(n.id);
    // It used to ask for attempt 1 again, collide, and go out with nothing recorded -- so a
    // callback about the resend could never be matched.
    expect(attempts.map((a) => [a.attemptNumber, a.sendKind, a.providerMessageId])).toEqual([
      [1, 'PRIMARY', `first-${suffix}`],
      [2, 'MANUAL_RESEND', `again-${suffix}`],
    ]);
  });

  maybe('a skipped message can be resent without forcing it', async () => {
    deliver.mockReset();
    deliver.mockResolvedValue({ provider: 'none', skipped: true, reason: 'no_destination' });
    const n = await due('whatsapp', 'resend-skipped');
    await notifications.dispatchDue();

    // Nothing reached anybody, so this is the first copy, not a second one.
    await expect(ops.resend('operator', n.id)).resolves.toEqual({ requeued: true });
  });

  maybe('older rows that say SENT are read for what they were', async () => {
    /*
      Written exactly as the old sweep wrote them. Nothing rewrites history; the admin view
      reads every fact on the row and says what happened.
    */
    const bookingId = `legacy-${suffix}`;
    const skip = await db!.notification.create({
      data: {
        type: NotificationType.BOOKING_CONFIRMED,
        userId,
        channel: 'whatsapp',
        status: 'SENT',
        provider: 'none',
        lastError: 'no_destination',
        sentAt: new Date(),
        bookingId,
        payload: { bookingId },
      },
    });
    await db!.notificationDelivery.create({
      data: {
        notificationId: skip.id,
        provider: 'none',
        channel: 'whatsapp',
        attemptNumber: 1,
        status: 'REJECTED',
        outcomeClass: 'NO_DESTINATION',
        failureCode: 'no_destination',
      },
    });
    const logged = await db!.notification.create({
      data: {
        type: NotificationType.BOOKING_CONFIRMED,
        userId,
        toEmail: `ana+${suffix}@example.test`,
        channel: 'email',
        status: 'SENT',
        provider: 'log',
        sentAt: new Date(),
        bookingId,
        payload: { bookingId },
      },
    });
    await db!.notificationDelivery.create({
      data: {
        notificationId: logged.id,
        provider: 'log',
        channel: 'email',
        attemptNumber: 1,
        status: 'ACCEPTED',
        outcomeClass: 'PROVIDER_ACCEPTED',
        acceptedAt: new Date(),
      },
    });

    const rows = await ops.search({ bookingId });
    const byChannel = Object.fromEntries(rows.map((r) => [r.channel, r.delivery]));
    expect(byChannel.whatsapp).toMatchObject({ verdict: 'NOT_SENT', delivered: false });
    expect(byChannel.whatsapp.label).toBe(
      'Not sent, because there is no phone number on the account.',
    );
    expect(byChannel.email).toMatchObject({ verdict: 'LOG_ONLY', delivered: false });

    const detail = await ops.inspect(logged.id);
    expect(detail.delivery.verdict).toBe('LOG_ONLY');
    // The stored status is left as it was written.
    expect(detail.status).toBe('SENT');
  });
});
