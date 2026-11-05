import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { NotificationType, SuppressionReason } from '@eticketsgo/shared-types';
import { NotificationService } from '../notification.service';
import { NotificationPreferencesService } from '../notification-preferences.service';
import { MarketingConsentService } from '../marketing-consent.service';
import { DeliveryRecorderService } from '../delivery/delivery-recorder.service';
import { SuppressionService } from '../delivery/suppression.service';
import { NotificationPolicyResolver } from './notification-policy.resolver';
import { SMS_TRANSACTIONAL_SCOPE } from './sms-consent';
import { acquireSweepLock, type SweepLock } from '../test-support/sweep-lock';

/** The same loader the other integration suites use: skip rather than fabricate a pass. */
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

/**
 * Transactional SMS consent against real Postgres: the append-only consent log, the
 * suppression table, the dedupe index and the sweep, with only the provider call mocked.
 *
 * What it proves that the unit suite cannot: that the newest `sms:transactional` row really
 * decides (a withdrawal is a later row, not an edit), that a marketing `sms` row neither
 * satisfies nor is satisfied by it, that the SKIPPED row lands on the booking under the
 * unique dedupe key, and that a STOP or a withdrawal committed after enqueue stops the send.
 */
describe('integration-real-postgres: transactional SMS consent', () => {
  const url = loadDatabaseUrl();
  let db: PrismaClient | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  const deliver = jest.fn(async (channel: string, _msg: unknown) => ({
    provider: channel === 'sms' ? 'twilio' : 'ses',
    providerMessageId: `${channel}-${Date.now()}-${Math.random()}`,
  }));

  const suffix = `smsconsent-${Date.now()}`;
  const tail = String(Date.now()).slice(-7);
  let american = '';
  let indian = '';
  const emailOf = (tag: string) => `${tag}+${suffix}@example.test`;

  const CONFIG = {
    NOTIFICATION_MARKETS: 'IN,US,CA',
    SMS_PROVIDER_BY_MARKET: 'IN=msg91,US=twilio,CA=twilio',
    EMAIL_PROVIDER: 'ses',
    SMS_TRANSACTIONAL_TYPES: 'BOOKING_CONFIRMED',
    // Set for this suite only. The shipped default stays India alone.
    SMS_TRANSACTIONAL_MARKETS: 'IN,US,CA',
  };

  const build = () => {
    const suppression = new SuppressionService(db as never);
    const consent = new MarketingConsentService(db as never);
    const service = new NotificationService(
      db as never,
      { render: () => ({ subject: 'S', body: 'B' }) } as never,
      new NotificationPreferencesService(db as never) as never,
      {
        has: (c: string) => ['email', 'sms'].includes(c),
        resolve: (c: string) => ({ key: c, deliver: (m: unknown) => deliver(c, m) }),
      } as never,
      consent,
      undefined,
      new DeliveryRecorderService(db as never, suppression),
      suppression,
      new NotificationPolicyResolver(
        new NotificationPreferencesService(db as never),
        consent,
        new ConfigService(CONFIG),
        db as never,
        suppression,
      ),
    );
    return { service, consent, suppression };
  };

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
      sweepLock = await acquireSweepLock(url);
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }
    const make = async (tag: string, phone: string) =>
      (
        await db!.user.create({
          data: {
            email: emailOf(tag),
            passwordHash: 'x',
            fullName: tag,
            roles: ['CUSTOMER'],
            phone,
            phoneVerifiedAt: new Date(),
          },
        })
      ).id;
    american = await make('sam', `+1415${tail}`);
    indian = await make('raj', `+9199${tail}1`);
  }, 180_000);

  afterAll(async () => {
    if (!db || !available) return;
    const ids = [american, indian].filter(Boolean);
    await db.notificationDelivery.deleteMany({ where: { notification: { userId: { in: ids } } } });
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.marketingConsent.deleteMany({ where: { email: { contains: suffix } } });
    await db.suppressedDestination.deleteMany({
      where: {
        destinationHash: { in: [SuppressionService.hash('sms', `+1415${tail}`)] },
      },
    });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await sweepLock?.release();
    await db.$disconnect();
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

  // Out of every other suite's sweep window; `AFTER` brings the rows back into this one.
  const AFTER = () => new Date(Date.now() + 7 * 60 * 60 * 1000);

  const payload = (bookingId: string, india = false) => ({
    bookingId,
    reference: india ? 'ETG-IND-2026-000042' : 'ETG-USA-2026-000042',
    eventTitle: india ? 'Kantara Chapter 1' : 'Hamilton',
    startsAt: '2026-11-12T14:00:00.000Z',
    timeZone: india ? 'Asia/Kolkata' : 'America/New_York',
    seats: 'F7, F8',
    tickets: 2,
    currency: india ? 'INR' : 'USD',
  });

  /** Confirm a booking the way payments.service does: inside the booking's transaction. */
  const confirm = async (userId: string, tag: string, bookingId: string, india = false) => {
    const { service } = build();
    await db!.$transaction(async (tx) => {
      await service.sendCritical(tx, {
        type: NotificationType.BOOKING_CONFIRMED,
        userId,
        toEmail: emailOf(tag),
        payload: payload(bookingId, india),
      });
    });
    // Moved into the future so no parallel suite's sweep delivers them through its own mock.
    await db!.notification.updateMany({
      where: { bookingId, status: 'PENDING' },
      data: { scheduledFor: new Date(Date.now() + 6 * 60 * 60 * 1000) },
    });
    return db!.notification.findMany({ where: { bookingId }, orderBy: { channel: 'asc' } });
  };

  /*
    The newest row decides, so each decision is a few milliseconds after the last one: two
    rows in the same millisecond would leave "newest" to chance.
  */
  const grant = async (userId: string, tag: string, channel: string, granted: boolean) => {
    await new Promise((r) => setTimeout(r, 10));
    await new MarketingConsentService(db as never).record(
      { userId, email: emailOf(tag) },
      channel,
      granted,
      {
        source: granted ? 'CUSTOMER_SIGNUP' : `withdrawn-by-user:${channel}`,
        // As sign-up does: the grant names the number the person agreed to be texted on.
        ...(granted
          ? { phone: (await db!.user.findUnique({ where: { id: userId } }))?.phone ?? undefined }
          : {}),
      },
    );
  };

  const smsSentFor = (bookingId: string) =>
    deliver.mock.calls.filter(
      ([c, m]) =>
        c === 'sms' &&
        (m as { payload?: { bookingId?: string } })?.payload?.bookingId === bookingId,
    ).length;

  maybe('US, no consent: email queued, SMS is a SKIPPED row on the booking', async () => {
    const bookingId = `us-none-${suffix}`;
    const rows = await confirm(american, 'sam', bookingId);
    expect(rows.find((r) => r.channel === 'email')?.status).toBe('PENDING');
    const sms = rows.filter((r) => r.channel === 'sms');
    expect(sms).toHaveLength(1);
    expect(sms[0]).toMatchObject({ status: 'SKIPPED', lastError: 'not_sent: no sms consent' });

    // A redelivered confirmation after consent is given writes no late text.
    await grant(american, 'sam', SMS_TRANSACTIONAL_SCOPE, true);
    const again = await confirm(american, 'sam', bookingId);
    expect(again.filter((r) => r.channel === 'sms')).toHaveLength(1);
    await grant(american, 'sam', SMS_TRANSACTIONAL_SCOPE, false);
  });

  maybe('US, marketing SMS consent only: still no transactional text', async () => {
    await grant(american, 'sam', 'sms', true);
    const rows = await confirm(american, 'sam', `us-mkt-${suffix}`);
    expect(rows.find((r) => r.channel === 'sms')).toMatchObject({
      status: 'SKIPPED',
      lastError: 'not_sent: sms consent withdrawn',
    });
    await grant(american, 'sam', 'sms', false);
  });

  maybe('transactional consent never authorises marketing SMS', async () => {
    await grant(american, 'sam', SMS_TRANSACTIONAL_SCOPE, true);
    const consent = new MarketingConsentService(db as never);
    const subject = { userId: american, email: emailOf('sam') };
    const phone = (await db!.user.findUnique({ where: { id: american } }))!.phone!;
    await expect(consent.smsTransactionalConsent(subject, phone)).resolves.toBe('granted');
    await expect(consent.mayReceiveMarketing(subject, 'sms')).resolves.toBe(false);
  });

  maybe('US with consent: PENDING, then withdrawn before the sweep: never sent', async () => {
    await grant(american, 'sam', SMS_TRANSACTIONAL_SCOPE, true);
    const bookingId = `us-withdraw-${suffix}`;
    const rows = await confirm(american, 'sam', bookingId);
    expect(rows.find((r) => r.channel === 'sms')?.status).toBe('PENDING');

    // The withdrawal is a newer row, not an edit of the grant.
    await grant(american, 'sam', SMS_TRANSACTIONAL_SCOPE, false);
    await build().service.dispatchDue(AFTER());

    expect(smsSentFor(bookingId)).toBe(0);
    const sms = await db!.notification.findFirst({ where: { bookingId, channel: 'sms' } });
    expect(sms).toMatchObject({ status: 'SKIPPED', lastError: 'not_sent: sms consent withdrawn' });
    // The email for the same booking went out regardless.
    const email = await db!.notification.findFirst({ where: { bookingId, channel: 'email' } });
    expect(email?.status).toBe('SENT');

    // Terminal: another sweep does not pick it up again.
    await build().service.dispatchDue(AFTER());
    expect(smsSentFor(bookingId)).toBe(0);
  });

  maybe('US with consent, then STOP before the sweep: never sent; START lifts it', async () => {
    await grant(american, 'sam', SMS_TRANSACTIONAL_SCOPE, true);
    const bookingId = `us-stop-${suffix}`;
    const rows = await confirm(american, 'sam', bookingId);
    expect(rows.find((r) => r.channel === 'sms')?.status).toBe('PENDING');

    const { suppression } = build();
    await suppression.suppress({
      channel: 'sms',
      destination: `+1415${tail}`,
      reason: SuppressionReason.UNSUBSCRIBED,
      provider: 'twilio',
    });
    await build().service.dispatchDue(AFTER());
    expect(smsSentFor(bookingId)).toBe(0);
    expect(
      await db!.notification.findFirst({ where: { bookingId, channel: 'sms' } }),
    ).toMatchObject({ status: 'SKIPPED', lastError: 'destination_suppressed' });

    // While STOP stands, a new booking names the reason at enqueue.
    const blocked = await confirm(american, 'sam', `us-stop2-${suffix}`);
    expect(blocked.find((r) => r.channel === 'sms')).toMatchObject({
      status: 'SKIPPED',
      lastError: 'not_sent: destination suppressed',
    });

    // START lifts it as before, and the next booking is texted.
    await suppression.liftProviderOptOut('sms', `+1415${tail}`, 'twilio', 'start');
    const lifted = `us-start-${suffix}`;
    await confirm(american, 'sam', lifted);
    await build().service.dispatchDue(AFTER());
    expect(smsSentFor(lifted)).toBe(1);
  });

  /*
    Consent is for ONE number. Changing the account's number always takes a fresh code (the
    number is re-verified), and the old grant does not carry over: the person agrees again
    for the new number before anything is texted to it.
  */
  maybe('a grant for the old number is not consent for a new, re-verified number', async () => {
    const before = (await db!.user.findUnique({ where: { id: american } }))!.phone!;
    await grant(american, 'sam', SMS_TRANSACTIONAL_SCOPE, true);
    const moved = `+1415${String(Date.now()).slice(-7)}`;
    await db!.user.update({
      where: { id: american },
      data: { phone: moved, phoneVerifiedAt: new Date() },
    });
    try {
      const first = `us-moved-${suffix}`;
      const rows = await confirm(american, 'sam', first);
      expect(rows.find((r) => r.channel === 'sms')).toMatchObject({
        status: 'SKIPPED',
        lastError: 'not_sent: sms consent not given for this number',
      });
      expect(rows.find((r) => r.channel === 'email')?.status).toBe('PENDING');

      // Agreeing again, now, records the NEW number, and the next booking is texted to it.
      await grant(american, 'sam', SMS_TRANSACTIONAL_SCOPE, true);
      const consent = new MarketingConsentService(db as never);
      const subject = { userId: american, email: emailOf('sam') };
      await expect(consent.smsTransactionalConsent(subject, moved)).resolves.toBe('granted');
      await expect(consent.smsTransactionalConsent(subject, before)).resolves.toBe('granted');
      const second = `us-moved-2-${suffix}`;
      const again = await confirm(american, 'sam', second);
      expect(again.find((r) => r.channel === 'sms')?.status).toBe('PENDING');
      await build().service.dispatchDue(AFTER());
      expect(smsSentFor(second)).toBe(1);
    } finally {
      await db!.user.update({ where: { id: american }, data: { phone: before } });
      await grant(american, 'sam', SMS_TRANSACTIONAL_SCOPE, false);
    }
  });

  maybe(
    'a grant that names no number counts for no number; a withdrawal with none stops all',
    async () => {
      const consent = new MarketingConsentService(db as never);
      const subject = { userId: american, email: emailOf('sam') };
      const phone = (await db!.user.findUnique({ where: { id: american } }))!.phone!;
      await new Promise((r) => setTimeout(r, 10));
      // Stored the way sms:transactional consents were before the number was kept with them.
      await db!.marketingConsent.create({
        data: {
          userId: american,
          email: emailOf('sam'),
          channel: SMS_TRANSACTIONAL_SCOPE,
          granted: true,
          source: 'CUSTOMER_SIGNUP',
          phone: null,
        },
      });
      // Never consent. (The earlier withdrawal for this number is what answers here.)
    await expect(consent.smsTransactionalConsent(subject, phone)).resolves.not.toBe('granted');

      await grant(american, 'sam', SMS_TRANSACTIONAL_SCOPE, true);
      await expect(consent.smsTransactionalConsent(subject, phone)).resolves.toBe('granted');
      await new Promise((r) => setTimeout(r, 10));
      await db!.marketingConsent.create({
        data: {
          userId: american,
          email: emailOf('sam'),
          channel: SMS_TRANSACTIONAL_SCOPE,
          granted: false,
          source: 'withdrawn-by-user:sms:transactional',
          phone: null,
        },
      });
      await expect(consent.smsTransactionalConsent(subject, phone)).resolves.toBe('withdrawn');
    },
  );

  maybe('signup and settings consents now keep the number they are for', async () => {
    const consent = new MarketingConsentService(db as never);
    const phone = (await db!.user.findUnique({ where: { id: american } }))!.phone!;
    await new Promise((r) => setTimeout(r, 10));
    // Settings: no number passed; the account's verified number is read and stored.
    await consent.record(
      { userId: american, email: emailOf('sam') },
      SMS_TRANSACTIONAL_SCOPE,
      true,
      {
        source: 'account-settings:sms:transactional',
      },
    );
    const row = await db!.marketingConsent.findFirst({
      where: { userId: american, channel: SMS_TRANSACTIONAL_SCOPE },
      orderBy: { createdAt: 'desc' },
    });
    expect(row?.phone).toBe(phone);
    await grant(american, 'sam', SMS_TRANSACTIONAL_SCOPE, false);
  });

  maybe('India, verified phone, no consent record: texted exactly as before', async () => {
    const bookingId = `in-${suffix}`;
    const rows = await confirm(indian, 'raj', bookingId, true);
    expect(rows.find((r) => r.channel === 'sms')?.status).toBe('PENDING');
    await build().service.dispatchDue(AFTER());
    expect(smsSentFor(bookingId)).toBe(1);
  });
});
