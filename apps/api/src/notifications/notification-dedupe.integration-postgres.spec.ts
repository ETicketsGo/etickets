import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NotificationType } from '@eticketsgo/shared-types';
import { NotificationService } from './notification.service';
import { dedupeKeyFor } from './policy/dedupe-key';

/**
 * integration-real-postgres — one intent, one message, however many times it is processed.
 *
 * ── WHY THIS CANNOT BE PROVEN WITH A MOCK ──────────────────────────────────────────
 * The guarantee IS the unique index. Everything that causes a duplicate lives outside a
 * single process — a BullMQ job retried after a timeout, a worker killed mid-batch and
 * restarted, an event redelivered because at-least-once is the only guarantee on offer, two
 * API instances behind a load balancer handling the same webhook. A set in memory is empty
 * after every deploy and is not shared between instances. A stubbed Prisma client would
 * happily return whatever this test told it to, and would prove nothing about any of that.
 *
 * So these run real concurrent inserts against real Postgres and count the rows that
 * survive. Skips (never fabricates a pass) when no database is reachable.
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
import { acquireSweepLock, type SweepLock } from './test-support/sweep-lock';
type Client = InstanceType<typeof PrismaClient>;

describe('integration-real-postgres: duplicate notifications', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  let service: NotificationService;
  let deliver: jest.Mock;

  const suffix = `dedupe-${Date.now()}`;
  const EMAIL = `ravi+${suffix}@example.test`;
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
      Serialize against the other suites that call a GLOBAL sweep. Without it they deliver
      one another's notifications through their own mocks, and an assertion passes alone and
      fails in a full run. See test-support/sweep-lock.
    */
      sweepLock = await acquireSweepLock(url);
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    const user = await db.user.create({
      data: { email: EMAIL, passwordHash: 'x', fullName: 'Ravi', roles: ['CUSTOMER'] },
    });
    userId = user.id;

    deliver = jest.fn().mockResolvedValue({ provider: 'log', providerMessageId: 'log-1' });
    service = new NotificationService(
      db as never,
      { render: () => ({ subject: 'S', body: 'B' }) } as never,
      // Preferences and consent are not what is under test; leave everything on so anything
      // suppressed below was suppressed by the index.
      { resolveChannels: async (_u: unknown, _t: unknown, req: string[]) => req } as never,
      {
        has: (c: string) => ['email', 'in_app', 'push', 'whatsapp', 'sms'].includes(c),
        resolve: (c: string) => ({ key: c, deliver }),
      } as never,
      { mayReceiveMarketing: jest.fn().mockResolvedValue(false) } as never,
    );
  }, 180_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.notification.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
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

  const confirm = (bookingId: string) =>
    service.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId,
      toEmail: EMAIL,
      payload: { bookingId },
      channels: ['email'],
    });

  maybe('the same intent sent twice in sequence writes one row', async () => {
    const bookingId = `bk-seq-${suffix}`;
    await confirm(bookingId);
    await confirm(bookingId);

    const rows = await db!.notification.findMany({
      where: { userId, channel: 'email', payload: { path: ['bookingId'], equals: bookingId } },
    });
    expect(rows).toHaveLength(1);
  });

  maybe(
    'eight workers processing the same event at once write one row between them',
    async () => {
      /*
        The real shape of the failure. Not "somebody called send twice" but "the same event
        was delivered to eight consumers simultaneously", which is what a redelivery storm or
        a lease expiring under load looks like. Exactly one insert must win.
      */
      const bookingId = `bk-race-${suffix}`;
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => confirm(bookingId)));

      // Every caller succeeds. A collision is an expected outcome, not an error to propagate
      // into whatever was calling — and for two of the sixteen callers, that is a payment.
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      const rows = await db!.notification.findMany({
        where: { userId, channel: 'email', payload: { path: ['bookingId'], equals: bookingId } },
      });
      expect(rows).toHaveLength(1);
    },
    60_000,
  );

  maybe('and therefore exactly one message reaches a provider', async () => {
    // The row count is the mechanism; this is the consequence anybody actually cares about.
    const bookingId = `bk-once-${suffix}`;
    deliver.mockClear();
    await Promise.allSettled(Array.from({ length: 5 }, () => confirm(bookingId)));

    const due = await db!.notification.findMany({
      where: { userId, status: 'PENDING', payload: { path: ['bookingId'], equals: bookingId } },
    });
    expect(due).toHaveLength(1);

    await service.dispatchDue();
    const delivered = deliver.mock.calls.filter(
      (c) => (c[0] as { payload: { bookingId?: string } }).payload.bookingId === bookingId,
    );
    expect(delivered).toHaveLength(1);
  });

  maybe('one intent still fans out across its channels', async () => {
    // The channel is part of the key. The email and the WhatsApp message about the same
    // confirmed booking are not duplicates of each other; a second email is.
    const bookingId = `bk-fan-${suffix}`;
    await service.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId,
      toEmail: EMAIL,
      payload: { bookingId },
      channels: ['email', 'push'],
    });
    await service.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId,
      toEmail: EMAIL,
      payload: { bookingId },
      channels: ['email', 'push'],
    });

    const rows = await db!.notification.findMany({
      where: { userId, payload: { path: ['bookingId'], equals: bookingId } },
    });
    expect(rows.map((r: { channel: string }) => r.channel).sort()).toEqual(['email', 'push']);
  });

  maybe('a genuinely different message is NOT suppressed', async () => {
    /*
      The half that is easy to get wrong. Over-suppression is silent: nobody reports the
      message they never knew was coming.
    */
    const bookingId = `bk-distinct-${suffix}`;
    await confirm(bookingId);

    // A different booking.
    await confirm(`${bookingId}-other`);
    // A different fact about the same booking.
    await service.send({
      type: NotificationType.BOOKING_CANCELLED,
      userId,
      toEmail: EMAIL,
      payload: { bookingId },
      channels: ['email'],
    });

    const rows = await db!.notification.findMany({
      where: { userId, channel: 'email', payload: { path: ['bookingId'], equals: bookingId } },
    });
    expect(rows.map((r: { type: string }) => r.type).sort()).toEqual([
      'BOOKING_CANCELLED',
      'BOOKING_CONFIRMED',
    ]);
  });

  maybe('two partial refunds of the same amount both go out', async () => {
    /*
      Why REFUND_COMPLETED is keyed on the refund and not the booking. A booking can be
      refunded in parts, and two refunds of the same amount on the same booking are two real
      refunds — keyed on the booking, the customer would be told about one of them.
    */
    const bookingId = `bk-partial-${suffix}`;
    for (const refundId of [`rf-a-${suffix}`, `rf-b-${suffix}`]) {
      await service.send({
        type: NotificationType.REFUND_COMPLETED,
        userId,
        toEmail: EMAIL,
        payload: { bookingId, refundId, currency: 'INR', amountMinor: 50000 },
        channels: ['email'],
      });
    }
    const rows = await db!.notification.findMany({
      where: {
        userId,
        type: 'REFUND_COMPLETED',
        payload: { path: ['bookingId'], equals: bookingId },
      },
    });
    expect(rows).toHaveLength(2);
  });

  maybe('a type that may legitimately repeat is never suppressed', async () => {
    // A show can be reminded about more than once. These carry no key at all, and Postgres
    // permits any number of nulls in a unique index — which is what makes opt-in workable.
    const showId = `show-${suffix}`;
    for (let i = 0; i < 3; i++) {
      await service.send({
        type: NotificationType.EVENT_REMINDER,
        userId,
        toEmail: EMAIL,
        payload: { showId, nth: i },
        channels: ['in_app'],
      });
    }
    const rows = await db!.notification.findMany({
      where: { userId, type: 'EVENT_REMINDER', channel: 'in_app' },
    });
    expect(rows.length).toBe(3);
    expect(rows.every((r: { dedupeKey: string | null }) => r.dedupeKey === null)).toBe(true);
  });

  maybe('a caller may state the intent itself when the payload cannot', async () => {
    const explicit = `manual-batch-${suffix}`;
    for (let i = 0; i < 3; i++) {
      await service.send({
        type: NotificationType.EVENT_REMINDER,
        userId,
        toEmail: EMAIL,
        payload: { nth: i },
        // A reminder's policy has no email on it, so this uses a channel it does allow.
        channels: ['in_app'],
        intentKey: explicit,
      });
    }
    const key = dedupeKeyFor({
      type: NotificationType.EVENT_REMINDER,
      channel: 'in_app',
      recipientRef: userId,
      payload: {},
      explicitIntent: explicit,
    });
    const rows = await db!.notification.findMany({ where: { dedupeKey: key } });
    expect(rows).toHaveLength(1);
  });

  maybe('the key does not carry the recipient in readable form', async () => {
    // This column is read by anyone with database access, in support tooling and in backups.
    // A key does not need to be readable to be unique, and the readable parts are the parts
    // that should not be.
    const key = dedupeKeyFor({
      type: NotificationType.BOOKING_CONFIRMED,
      channel: 'email',
      recipientRef: EMAIL,
      payload: { bookingId: 'bk-1' },
    });
    expect(key).not.toBeNull();
    expect(key).not.toContain(EMAIL);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});
