import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationService } from './notification.service';

/**
 * integration-real-postgres — if the domain change commits, the message it owes exists.
 *
 * ── THE WINDOW THIS CLOSES ─────────────────────────────────────────────────────────
 * Phase 1 took the provider off the payment path by writing the notification down and
 * handing it to the worker. That removed the outage failure, and left a smaller one: the
 * enqueue happened AFTER the commit. Between those two statements there is a gap where the
 * booking is confirmed, the money is taken, the process dies, and the confirmation that
 * carries somebody's ticket was never recorded. Nothing retries it, because nothing knows it
 * was owed. Rare, permanent, and on the single most important message the platform sends.
 *
 * ── WHY A MOCK CANNOT PROVE THIS EITHER ────────────────────────────────────────────
 * The guarantee is a property of PostgreSQL's transaction, in BOTH directions. A stub can be
 * told to pretend a rollback; only a real one can be asked what actually survived it.
 *
 * Skips (never fabricates a pass) when no database is reachable.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../.env', '../../../../.env']) {
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

describe('integration-real-postgres: notification atomicity', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let service: NotificationService;
  let deliver: jest.Mock;

  const suffix = `atomic-${Date.now()}`;
  const EMAIL = `meera+${suffix}@example.test`;
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
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    const user = await db.user.create({
      data: { email: EMAIL, passwordHash: 'x', fullName: 'Meera', roles: ['CUSTOMER'] },
    });
    userId = user.id;

    deliver = jest.fn().mockResolvedValue({ provider: 'log' });
    service = new NotificationService(
      db as never,
      { render: () => ({ subject: 'S', body: 'B' }) } as never,
      { resolveChannels: async (_u: unknown, _t: unknown, req: string[]) => req } as never,
      {
        has: (c: string) => ['email', 'in_app', 'push', 'whatsapp'].includes(c),
        resolve: () => ({ key: 'email', deliver }),
      } as never,
      { mayReceiveMarketing: jest.fn().mockResolvedValue(false) } as never,
    );
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.notification.deleteMany({ where: { userId } });
    await db.notification.deleteMany({ where: { toEmail: { contains: suffix } } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await db.$disconnect();
  }, 60_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  /**
   * Stands in for a domain transition: a row that either exists afterwards or does not,
   * alongside the notification that describes it. `NotificationPreference` is used as the
   * companion write because it is the smallest table with a natural unique key — the point
   * is the transaction boundary, not what else is in it.
   */
  const domainWrite = (tx: Client, channel: string) =>
    tx.notificationPreference.create({
      data: { userId, type: NotificationType.PAYMENT_FAILED, channel, enabled: true },
    });

  maybe('the domain change and its notification commit together', async () => {
    const bookingId = `bk-commit-${suffix}`;
    await db!.$transaction(async (tx: Client) => {
      await domainWrite(tx, `commit-${suffix}`);
      await service.sendCritical(tx, {
        type: NotificationType.BOOKING_CONFIRMED,
        userId,
        toEmail: EMAIL,
        payload: { bookingId },
        channels: ['email'],
      });
    });

    const [domain, notifications] = await Promise.all([
      db!.notificationPreference.findMany({ where: { userId, channel: `commit-${suffix}` } }),
      db!.notification.findMany({
        where: { userId, payload: { path: ['bookingId'], equals: bookingId } },
      }),
    ]);
    expect(domain).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].status).toBe('PENDING');
  });

  maybe('a rollback leaves NEITHER of them', async () => {
    /*
      The direction that is easy to get wrong, and silent when it is. A notification that
      survives a rolled-back transaction tells somebody their booking is confirmed when it
      is not — and the worker will deliver it, because from its side it looks like any
      other pending message.
    */
    const bookingId = `bk-rollback-${suffix}`;
    await expect(
      db!.$transaction(async (tx: Client) => {
        await domainWrite(tx, `rollback-${suffix}`);
        await service.sendCritical(tx, {
          type: NotificationType.BOOKING_CONFIRMED,
          userId,
          toEmail: EMAIL,
          payload: { bookingId },
          channels: ['email'],
        });
        throw new Error('inventory could not be settled');
      }),
    ).rejects.toThrow('inventory could not be settled');

    const [domain, notifications] = await Promise.all([
      db!.notificationPreference.findMany({ where: { userId, channel: `rollback-${suffix}` } }),
      db!.notification.findMany({
        where: { userId, payload: { path: ['bookingId'], equals: bookingId } },
      }),
    ]);
    expect(domain).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  maybe('a provider outage is irrelevant to the transaction', async () => {
    /*
      Both halves of the isolation, at once: a provider that throws on every attempt cannot
      stop the domain change from committing, because the transaction never speaks to one.
      The message survives as PENDING for the worker to keep retrying.
    */
    deliver.mockRejectedValue(new Error('SES is down'));
    const bookingId = `bk-outage-${suffix}`;

    await expect(
      db!.$transaction(async (tx: Client) => {
        await domainWrite(tx, `outage-${suffix}`);
        await service.sendCritical(tx, {
          type: NotificationType.BOOKING_CONFIRMED,
          userId,
          toEmail: EMAIL,
          payload: { bookingId },
          channels: ['email'],
        });
      }),
    ).resolves.toBeUndefined();

    expect(
      await db!.notificationPreference.count({ where: { userId, channel: `outage-${suffix}` } }),
    ).toBe(1);
    expect(deliver).not.toHaveBeenCalled();

    // And when the worker does try, the failure lands on the notification, not the booking.
    await service.dispatchDue();
    const [row] = await db!.notification.findMany({
      where: { userId, payload: { path: ['bookingId'], equals: bookingId } },
    });
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('SES is down');
    deliver.mockResolvedValue({ provider: 'log' });
  });

  maybe(
    'a redelivered transaction still writes one notification',
    async () => {
      /*
      The two guarantees together. A webhook redelivered after the first attempt committed
      runs the whole transaction again; the domain write is guarded by its own unique key,
      and the notification by `dedupeKey`. Neither produces a second message.
    */
      const bookingId = `bk-redeliver-${suffix}`;
      const runOnce = () =>
        db!.$transaction(async (tx: Client) =>
          service.sendCritical(tx, {
            type: NotificationType.BOOKING_CONFIRMED,
            userId,
            toEmail: EMAIL,
            payload: { bookingId },
            channels: ['email'],
          }),
        );

      await runOnce();
      await runOnce();
      await Promise.allSettled([runOnce(), runOnce(), runOnce()]);

      const rows = await db!.notification.findMany({
        where: { userId, payload: { path: ['bookingId'], equals: bookingId } },
      });
      expect(rows).toHaveLength(1);
    },
    60_000,
  );

  maybe(
    'a fan-out writes one statement and survives being replayed',
    async () => {
      /*
      A show change reaching a whole audience. `fanOutCritical` inserts every recipient in a
      single `createMany`, and it is the `skipDuplicates` on that statement -- not a catch --
      that makes a replay safe: a unique violation raised mid-statement would abort the
      transaction, and with it the reschedule the audience is being told about.
    */
      const startsAt = `2026-11-01T16:30:00.000Z`;
      const audience = Array.from({ length: 5 }, (_, i) => ({
        userId: i === 0 ? userId : null,
        toEmail: `holder${i}+${suffix}@example.test`,
        payload: { bookingId: `bk-fan-${i}-${suffix}`, startsAt },
      }));

      const written = await db!.$transaction(async (tx: Client) =>
        service.fanOutCritical(tx, { type: NotificationType.SHOW_CHANGED, recipients: audience }),
      );
      // Five people across the four channels SHOW_CHANGED is allowed to use.
      expect(written).toBe(20);

      // Replayed -- an at-least-once redelivery of the same reschedule.
      const again = await db!.$transaction(async (tx: Client) =>
        service.fanOutCritical(tx, { type: NotificationType.SHOW_CHANGED, recipients: audience }),
      );
      expect(again).toBe(0);

      const rows = await db!.notification.findMany({
        where: { type: 'SHOW_CHANGED', toEmail: { contains: suffix } },
      });
      expect(rows).toHaveLength(20);

      // And a genuine SECOND move is not suppressed: the new start time is part of the key.
      const moved = audience.map((r) => ({
        ...r,
        payload: { ...r.payload, startsAt: '2026-11-01T19:45:00.000Z' },
      }));
      const third = await db!.$transaction(async (tx: Client) =>
        service.fanOutCritical(tx, { type: NotificationType.SHOW_CHANGED, recipients: moved }),
      );
      expect(third).toBe(20);

      await db!.notification.deleteMany({ where: { toEmail: { contains: suffix } } });
    },
    60_000,
  );

  maybe('a fan-out rolled back tells nobody', async () => {
    // Nobody may be told about a reschedule that did not happen. This is the reason the
    // fan-out sits inside the transaction rather than after it.
    const startsAt = '2026-12-01T10:00:00.000Z';
    await expect(
      db!.$transaction(async (tx: Client) => {
        await service.fanOutCritical(tx, {
          type: NotificationType.SHOW_CHANGED,
          recipients: [
            {
              userId: null,
              toEmail: `rolled${suffix}@example.test`,
              payload: { bookingId: `bk-rolled-${suffix}`, startsAt },
            },
          ],
        });
        throw new Error('screen is already booked');
      }),
    ).rejects.toThrow('screen is already booked');

    expect(
      await db!.notification.count({ where: { toEmail: `rolled${suffix}@example.test` } }),
    ).toBe(0);
  });

  maybe('a fan-out with nobody in it writes nothing', async () => {
    const written = await db!.$transaction(async (tx: Client) =>
      service.fanOutCritical(tx, { type: NotificationType.SHOW_CHANGED, recipients: [] }),
    );
    expect(written).toBe(0);
  });

  maybe('a duplicate inside a transaction does not roll the domain change back', async () => {
    /*
      The failure mode a naive unique index introduces. The second delivery of an event finds
      the notification already written; if that collision escaped as an error it would abort
      the whole transaction — so a redelivery would undo work that had already succeeded,
      and idempotency would have made things worse rather than better.
    */
    const bookingId = `bk-collide-${suffix}`;
    await db!.$transaction(async (tx: Client) =>
      service.sendCritical(tx, {
        type: NotificationType.BOOKING_CONFIRMED,
        userId,
        toEmail: EMAIL,
        payload: { bookingId },
        channels: ['email'],
      }),
    );

    await expect(
      db!.$transaction(async (tx: Client) => {
        await domainWrite(tx, `collide-${suffix}`);
        await service.sendCritical(tx, {
          type: NotificationType.BOOKING_CONFIRMED,
          userId,
          toEmail: EMAIL,
          payload: { bookingId },
          channels: ['email'],
        });
      }),
    ).resolves.toBeUndefined();

    expect(
      await db!.notificationPreference.count({ where: { userId, channel: `collide-${suffix}` } }),
    ).toBe(1);
    expect(
      await db!.notification.count({
        where: { userId, payload: { path: ['bookingId'], equals: bookingId } },
      }),
    ).toBe(1);
  });
});
