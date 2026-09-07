import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { DeliveryState, NotificationType } from '@eticketsgo/shared-types';
import { NotificationService } from '../notification.service';
import { NotificationFallbackService } from './fallback.service';
import { NotificationPolicyResolver } from './notification-policy.resolver';
import { DeliveryRecorderService } from '../delivery/delivery-recorder.service';
import { SuppressionService } from '../delivery/suppression.service';
import { NotificationPreferencesService } from '../notification-preferences.service';
import { MarketingConsentService } from '../marketing-consent.service';

/**
 * integration-real-postgres — one cancellation, the right number of messages.
 *
 * ── WHAT IS BEING PROVEN ───────────────────────────────────────────────────────────
 * The two failures a multi-channel platform falls into, which are opposite and both bad.
 *
 * Too few: a customer whose WhatsApp never arrived and who has no app finds out their show
 * was cancelled by turning up to a dark venue.
 *
 * Too many: everybody gets a push, a WhatsApp, an email and an SMS about the same
 * cancellation, and we pay for the last one — then a worker restart sends a second SMS, and
 * a delayed webhook a third.
 *
 * Every guarantee against the second is a database guarantee (the unique index on
 * `dedupeKey`, and `intentKey` grouping siblings), so none of it can be proven with a stub.
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
import { acquireSweepLock, type SweepLock } from '../test-support/sweep-lock';
type Client = InstanceType<typeof PrismaClient>;

/** Older than the thirty minutes a cancellation's preferred channels are given. */
const LONG_AGO = new Date(Date.now() - 90 * 60_000);

describe('integration-real-postgres: cross-channel fallback', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  let notifications: NotificationService;
  let fallbacks: NotificationFallbackService;
  let recorder: DeliveryRecorderService;
  let deliver: jest.Mock;

  const suffix = `fb-${Date.now()}`;
  const EMAIL = `priya+${suffix}@example.test`;
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
      data: {
        email: EMAIL,
        passwordHash: 'x',
        fullName: 'Priya',
        roles: ['CUSTOMER'],
        phone: `+9198${(Date.now() % 100000000).toString().padStart(8, '0')}`,
      },
    });
    userId = user.id;

    const suppression = new SuppressionService(db as never);
    recorder = new DeliveryRecorderService(db as never, suppression);
    deliver = jest.fn().mockResolvedValue({ provider: 'log' });
    notifications = new NotificationService(
      db as never,
      { render: () => ({ subject: 'S', body: 'B' }) } as never,
      new NotificationPreferencesService(db as never) as never,
      {
        has: (c: string) => ['email', 'in_app', 'push', 'whatsapp', 'sms'].includes(c),
        resolve: (c: string) => ({ key: c, deliver }),
      } as never,
      new MarketingConsentService(db as never) as never,
      undefined,
      recorder,
      suppression,
      new NotificationPolicyResolver(
        new NotificationPreferencesService(db as never),
        new MarketingConsentService(db as never),
        new ConfigService({}),
      ),
    );
    fallbacks = new NotificationFallbackService(db as never, notifications);
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.notification.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await sweepLock?.release();
    await db.$disconnect();
  }, 60_000);

  /*
    A generous batch limit throughout.  scans every overdue intent in the database,
    and this suite shares one with every other Postgres suite running beside it -- at the
    default bound, another suite's leftovers can push this one's booking out of the batch and
    the assertion fails for a reason that has nothing to do with the behaviour under test.
  */
  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  /** A cancellation sent long enough ago that its fallback window has passed. */
  async function cancelled(bookingId: string) {
    await notifications.send({
      type: NotificationType.SHOW_CANCELLED,
      userId,
      toEmail: EMAIL,
      payload: { bookingId, reference: `REF-${bookingId}` },
    });
    await db!.notification.updateMany({
      where: { userId, payload: { path: ['bookingId'], equals: bookingId } },
      data: { createdAt: LONG_AGO },
    });
    return db!.notification.findMany({
      where: { userId, payload: { path: ['bookingId'], equals: bookingId } },
    });
  }

  const channelsFor = async (bookingId: string) =>
    (
      await db!.notification.findMany({
        where: { userId, payload: { path: ['bookingId'], equals: bookingId } },
        select: { channel: true },
      })
    )
      .map((r: { channel: string }) => r.channel)
      .sort();

  /** Mark one channel's attempt as having reached the provider, or beyond. */
  async function attempt(bookingId: string, channel: string, state: DeliveryState) {
    const row = await db!.notification.findFirst({
      where: { userId, channel, payload: { path: ['bookingId'], equals: bookingId } },
    });
    const id = await recorder.open({
      notificationId: row.id,
      provider: 'log',
      channel,
      attemptNumber: 1,
    });
    await recorder.accepted(id!, 'log', `pm-${row.id}`);
    if (state !== DeliveryState.ACCEPTED) {
      await recorder.applyProviderEvent({
        provider: 'log',
        providerMessageId: `pm-${row.id}`,
        state,
      });
    }
  }

  maybe('a cancellation sends four channels and NOT an SMS', async () => {
    /*
      SMS is in the policy -- it has to be, before anything may reach it -- but sending it
      alongside the others means four messages about one cancellation and a bill for the one
      the customer was least likely to need.
    */
    const bookingId = `bk-immediate-${suffix}`;
    const rows = await cancelled(bookingId);
    expect(rows.map((r: { channel: string }) => r.channel).sort()).toEqual([
      'email',
      'in_app',
      'push',
      'whatsapp',
    ]);
  });

  maybe('opens the SMS when nothing preferred got through', async () => {
    const bookingId = `bk-nothing-${suffix}`;
    await cancelled(bookingId);
    // Every preferred channel accepted but nothing came back. Push is excluded here by
    // having no attempt at all -- somebody with no registered device.
    await attempt(bookingId, 'whatsapp', DeliveryState.UNDELIVERED);

    /*
      Asserted on THIS booking, not on the sweep's total. Earlier cases in this file leave
      their own overdue cancellations behind, and the sweep is quite right to pick those up
      too -- a count would be asserting the order the tests happen to run in.
    */
    await fallbacks.runDue(new Date(), 5_000);
    expect(await channelsFor(bookingId)).toContain('sms');
  });

  maybe(
    'opens exactly ONE SMS however many times the sweep runs',
    async () => {
      /*
      The sweep runs every minute, and a restarted worker runs it again immediately. Without
      an identity for the fallback, an overdue cancellation would earn an SMS per tick.
    */
      const bookingId = `bk-once-${suffix}`;
      await cancelled(bookingId);
      await attempt(bookingId, 'whatsapp', DeliveryState.UNDELIVERED);

      await fallbacks.runDue(new Date(), 5_000);
      await fallbacks.runDue(new Date(), 5_000);
      await Promise.allSettled([
        fallbacks.runDue(new Date(), 5_000),
        fallbacks.runDue(new Date(), 5_000),
        fallbacks.runDue(new Date(), 5_000),
      ]);

      const sms = await db!.notification.count({
        where: { userId, channel: 'sms', payload: { path: ['bookingId'], equals: bookingId } },
      });
      expect(sms).toBe(1);
    },
    60_000,
  );

  maybe('does NOT open an SMS when WhatsApp was delivered', async () => {
    const bookingId = `bk-delivered-${suffix}`;
    await cancelled(bookingId);
    await attempt(bookingId, 'whatsapp', DeliveryState.DELIVERED);

    await fallbacks.runDue(new Date(), 5_000);
    expect(await channelsFor(bookingId)).not.toContain('sms');
  });

  maybe('does NOT open an SMS when only PUSH was accepted', async () => {
    /*
      Push can never report delivery -- neither FCM nor Web Push has a per-message callback.
      Treating "no push receipt" as "push failed" would fire an SMS at every customer with
      the app installed, punishing the channel that works best for being the one that cannot
      prove it.
    */
    const bookingId = `bk-push-${suffix}`;
    await cancelled(bookingId);
    await attempt(bookingId, 'push', DeliveryState.ACCEPTED);

    await fallbacks.runDue(new Date(), 5_000);
    expect(await channelsFor(bookingId)).not.toContain('sms');
  });

  maybe('DOES open an SMS when only WhatsApp was accepted and never delivered', async () => {
    // WhatsApp reports delivery, so acceptance alone is not evidence it arrived. That is the
    // distinction Phase 2 drew, applied.
    const bookingId = `bk-accepted-${suffix}`;
    await cancelled(bookingId);
    await attempt(bookingId, 'whatsapp', DeliveryState.ACCEPTED);

    await fallbacks.runDue(new Date(), 5_000);
    expect(await channelsFor(bookingId)).toContain('sms');
  });

  maybe('does not open an SMS before the wait has elapsed', async () => {
    const bookingId = `bk-early-${suffix}`;
    await notifications.send({
      type: NotificationType.SHOW_CANCELLED,
      userId,
      toEmail: EMAIL,
      payload: { bookingId, reference: `REF-${bookingId}` },
    });

    await fallbacks.runDue(new Date(), 5_000);
    expect(await channelsFor(bookingId)).not.toContain('sms');
  });

  maybe('never opens a fallback for a type that has none', async () => {
    // A booking confirmation whose WhatsApp failed must never become an SMS. This is the
    // single most expensive mistake a naive fallback engine makes.
    const bookingId = `bk-confirmed-${suffix}`;
    await notifications.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId,
      toEmail: EMAIL,
      payload: { bookingId },
    });
    await db!.notification.updateMany({
      where: { userId, payload: { path: ['bookingId'], equals: bookingId } },
      data: { createdAt: LONG_AGO },
    });
    await attempt(bookingId, 'whatsapp', DeliveryState.UNDELIVERED);

    await fallbacks.runDue(new Date(), 5_000);
    expect(await channelsFor(bookingId)).not.toContain('sms');
  });
});

describe('integration-real-postgres: one channel failing does not recreate the others', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  let notifications: NotificationService;
  let deliver: jest.Mock;

  const suffix = `bomb-${Date.now()}`;
  const EMAIL = `raj+${suffix}@example.test`;
  let userId = '';

  beforeAll(async () => {
    if (!url) return;
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
      return;
    }
    const user = await db.user.create({
      data: { email: EMAIL, passwordHash: 'x', fullName: 'Raj', roles: ['CUSTOMER'] },
    });
    userId = user.id;

    const suppression = new SuppressionService(db as never);
    deliver = jest.fn();
    notifications = new NotificationService(
      db as never,
      { render: () => ({ subject: 'S', body: 'B' }) } as never,
      new NotificationPreferencesService(db as never) as never,
      {
        has: (c: string) => ['email', 'in_app', 'push', 'whatsapp'].includes(c),
        resolve: (c: string) => ({ key: c, deliver: (m: unknown) => deliver(c, m) }),
      } as never,
      new MarketingConsentService(db as never) as never,
      undefined,
      new DeliveryRecorderService(db as never, suppression),
      suppression,
      new NotificationPolicyResolver(
        new NotificationPreferencesService(db as never),
        new MarketingConsentService(db as never),
        new ConfigService({}),
      ),
    );
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.notification.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await sweepLock?.release();
    await db.$disconnect();
  }, 60_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (!available) return;
      await fn();
    });

  /**
   * The channels delivered FOR ONE BOOKING, sorted.
   *
   * ── WHY THE MOCK CALLS ARE FILTERED AND NOT JUST COUNTED ──────────────────────────
   * `dispatchDue()` is the real sweep: it acts on every notification in the database that is
   * pending and due, which is correct behaviour and exactly what makes a bare
   * `deliver.mock.calls` assertion non-deterministic. Anything else that left a pending row
   * — an earlier test in this file, another suite sharing the database, a run somebody
   * interrupted — is swept too, and shows up as extra channels in a list this test believes
   * is its own.
   *
   * That is not flakiness to be retried away; it is the assertion asking a question about
   * the whole database when it means to ask about one booking. Every notification carries its
   * `bookingId` in the payload, and the rendered message reaches the channel, so the calls
   * can be attributed exactly. The assertions below are unchanged in strength — still the
   * complete channel set, still an exact match — they are simply about the right rows.
   */
  const deliveredFor = (bookingId: string): string[] =>
    deliver.mock.calls
      .filter(
        ([, message]) =>
          (message as { payload?: { bookingId?: string } })?.payload?.bookingId === bookingId,
      )
      .map(([channel]) => channel as string)
      .sort();

  maybe('a retry of the failed channel re-sends ONLY that channel', async () => {
    /*
      The bombardment failure that is easiest to build by accident: retrying at the level of
      the NOTIFICATION rather than the channel, so a WhatsApp timeout re-sends the email and
      the push that already worked. Each channel is its own row with its own attempt counter
      and its own dedupe key, which is what makes the retry surgical.
    */
    const bookingId = `bk-retry-${suffix}`;
    deliver.mockImplementation(async (channel: string) => {
      if (channel === 'whatsapp') throw new Error('WhatsApp is having a moment');
      return { provider: 'log' };
    });

    await notifications.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId,
      toEmail: EMAIL,
      payload: { bookingId },
    });
    await notifications.dispatchDue();

    expect(deliveredFor(bookingId)).toEqual(['email', 'in_app', 'push', 'whatsapp']);

    // The second sweep. Only the channel that failed is still due.
    deliver.mockClear();
    await notifications.dispatchDue();
    expect(deliveredFor(bookingId)).toEqual(['whatsapp']);
  });

  maybe('a duplicate domain event sends nothing a second time', async () => {
    const bookingId = `bk-dupe-${suffix}`;
    deliver.mockResolvedValue({ provider: 'log' });

    const send = () =>
      notifications.send({
        type: NotificationType.BOOKING_CONFIRMED,
        userId,
        toEmail: EMAIL,
        payload: { bookingId },
      });

    await send();
    await notifications.dispatchDue();
    deliver.mockClear();

    // The same event redelivered. Four rows already exist and all four are terminal.
    await send();
    await notifications.dispatchDue();
    expect(deliveredFor(bookingId)).toEqual([]);

    const rows = await db!.notification.count({
      where: { userId, payload: { path: ['bookingId'], equals: bookingId } },
    });
    expect(rows).toBe(4);
  });

  maybe('a suppressed email does not stop the other channels', async () => {
    /*
      Suppression is about ONE destination on ONE channel. A dead mailbox says nothing about
      a phone, and letting it silence the whole notification would turn a bounced email into
      a customer who never hears about their booking at all.
    */
    const bookingId = `bk-suppressed-${suffix}`;
    const suppression = new SuppressionService(db as never);
    await suppression.suppress({
      channel: 'email',
      destination: EMAIL,
      reason: 'HARD_BOUNCE' as never,
    });
    deliver.mockClear();
    deliver.mockResolvedValue({ provider: 'log' });

    await notifications.send({
      type: NotificationType.BOOKING_CONFIRMED,
      userId,
      toEmail: EMAIL,
      payload: { bookingId },
    });
    await notifications.dispatchDue();

    const attempted = deliveredFor(bookingId);
    // No provider was called for the suppressed destination -- not called and refused, not
    // called at all, so it cannot earn another bounce against the sending domain.
    expect(attempted).not.toContain('email');
    expect(attempted).toEqual(['in_app', 'push', 'whatsapp']);

    const email = await db!.notification.findFirst({
      where: { userId, channel: 'email', payload: { path: ['bookingId'], equals: bookingId } },
    });
    expect(email.status).toBe('FAILED');
    expect(email.lastError).toBe('destination_suppressed');

    await db!.suppressedDestination.deleteMany({
      where: { destinationHash: SuppressionService.hash('email', EMAIL) },
    });
  });
});
