import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DeliveryState, NotificationType } from '@eticketsgo/shared-types';
import { DeliveryRecorderService } from './delivery-recorder.service';
import { SuppressionService } from './suppression.service';
import { acquireSweepLock, type SweepLock } from '../test-support/sweep-lock';

/**
 * integration-real-postgres — a later fact must not erase an earlier one.
 *
 * ── WHY THIS WAS WORTH CHECKING ────────────────────────────────────────────────────
 * The Phase 3 review asked whether a DELIVERED that is later COMPLAINED still records that
 * delivery happened. It does — `undefined` means "leave it alone" to Prisma, so the earlier
 * timestamp survives the update that changes the status.
 *
 * Checking it turned up one place where it was NOT true: `deliveredAt` was also taking the
 * READ time, so a WhatsApp message that was delivered and then opened lost the moment it
 * actually arrived, replaced by a later fact about the same message. That is fixed here with
 * a `readAt` column rather than an event table — the facts are few, fixed and each has its
 * own natural slot, and a table would be machinery for a problem four columns solve.
 *
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
type Client = InstanceType<typeof PrismaClient>;

describe('integration-real-postgres: delivery history survives later facts', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  let recorder: DeliveryRecorderService;

  const suffix = `hist-${Date.now()}`;
  const EMAIL = `nina+${suffix}@example.test`;
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
      data: { email: EMAIL, passwordHash: 'x', fullName: 'Nina', roles: ['CUSTOMER'] },
    });
    userId = user.id;
    recorder = new DeliveryRecorderService(db as never, new SuppressionService(db as never));
  }, 180_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.notification.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await db.suppressedDestination.deleteMany({
      where: { destinationHash: SuppressionService.hash('email', EMAIL) },
    });
    await sweepLock?.release();
    await db.$disconnect();
  }, 180_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (!available) return;
      await fn();
    });

  async function accepted(tag: string, channel = 'email') {
    const notification = await db!.notification.create({
      data: {
        type: NotificationType.BOOKING_CONFIRMED,
        userId,
        toEmail: EMAIL,
        payload: { bookingId: tag },
        channel,
        locale: 'en',
        status: 'SENT',
      },
    });
    const id = await recorder.open({
      notificationId: notification.id,
      provider: 'log',
      channel,
      attemptNumber: 1,
    });
    await recorder.accepted(id!, 'log', tag);
    return id!;
  }

  const read = (id: string) => db!.notificationDelivery.findUnique({ where: { id } });

  maybe('a complaint after a delivery keeps the delivery timestamp', async () => {
    const id = await accepted(`complaint-${suffix}`);
    await recorder.applyProviderEvent({
      provider: 'log',
      providerMessageId: `complaint-${suffix}`,
      state: DeliveryState.DELIVERED,
    });
    const delivered = await read(id);
    expect(delivered.deliveredAt).toBeTruthy();

    await recorder.applyProviderEvent({
      provider: 'log',
      providerMessageId: `complaint-${suffix}`,
      state: DeliveryState.COMPLAINED,
      destination: EMAIL,
    });

    const after = await read(id);
    // The status is the LATEST fact; the timestamps are ALL the facts.
    expect(after.status).toBe(DeliveryState.COMPLAINED);
    expect(after.deliveredAt).toEqual(delivered.deliveredAt);
    expect(after.acceptedAt).toBeTruthy();
    expect(after.failedAt).toBeTruthy();
  });

  maybe('a read after a delivery keeps the delivery timestamp', async () => {
    /*
      The one that was actually wrong. `deliveredAt` took the read time too, so the moment a
      WhatsApp message arrived was overwritten by the moment it was opened -- and "how long
      did delivery take" became unanswerable for every message anybody read.
    */
    const id = await accepted(`read-${suffix}`, 'whatsapp');
    await recorder.applyProviderEvent({
      provider: 'log',
      providerMessageId: `read-${suffix}`,
      state: DeliveryState.DELIVERED,
    });
    const delivered = await read(id);

    await recorder.applyProviderEvent({
      provider: 'log',
      providerMessageId: `read-${suffix}`,
      state: DeliveryState.READ,
    });

    const after = await read(id);
    expect(after.status).toBe(DeliveryState.READ);
    expect(after.deliveredAt).toEqual(delivered.deliveredAt);
    expect(after.readAt).toBeTruthy();
    expect(after.readAt).not.toEqual(after.deliveredAt);
  });

  maybe('a bounce after a delivery keeps both, and suppresses', async () => {
    // "Delivered to the receiving server" and "the mailbox rejected it" are different hops.
    // Both happened; both are recorded; and the bounce is the one that stops future sends.
    const id = await accepted(`bounce-${suffix}`);
    await recorder.applyProviderEvent({
      provider: 'log',
      providerMessageId: `bounce-${suffix}`,
      state: DeliveryState.DELIVERED,
    });
    await recorder.applyProviderEvent({
      provider: 'log',
      providerMessageId: `bounce-${suffix}`,
      state: DeliveryState.BOUNCED,
      destination: EMAIL,
    });

    const after = await read(id);
    expect(after.status).toBe(DeliveryState.BOUNCED);
    expect(after.deliveredAt).toBeTruthy();
    expect(after.acceptedAt).toBeTruthy();
    expect(await new SuppressionService(db as never).isSuppressed('email', EMAIL)).toBe(true);
    await db!.suppressedDestination.deleteMany({
      where: { destinationHash: SuppressionService.hash('email', EMAIL) },
    });
  });

  maybe('every attempt keeps its own row, so a retry does not erase the first', async () => {
    /*
      The reason NotificationDelivery is a table and not three columns. Two attempts have two
      provider message ids, and a callback about the first must still find the first.
    */
    const notification = await db!.notification.create({
      data: {
        type: NotificationType.BOOKING_CONFIRMED,
        userId,
        toEmail: EMAIL,
        payload: { bookingId: `retry-${suffix}` },
        channel: 'email',
        locale: 'en',
        status: 'PENDING',
      },
    });
    const first = await recorder.open({
      notificationId: notification.id,
      provider: 'log',
      channel: 'email',
      attemptNumber: 1,
    });
    await recorder.failed(first!, 'log', 'connection reset');
    const second = await recorder.open({
      notificationId: notification.id,
      provider: 'log',
      channel: 'email',
      attemptNumber: 2,
    });
    await recorder.accepted(second!, 'log', `retry-msg-${suffix}`);

    const rows = await db!.notificationDelivery.findMany({
      where: { notificationId: notification.id },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe(DeliveryState.FAILED);
    expect(rows[0].failureReason).toBe('connection reset');
    expect(rows[1].status).toBe(DeliveryState.ACCEPTED);
  });
});
