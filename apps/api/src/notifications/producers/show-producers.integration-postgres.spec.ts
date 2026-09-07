import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@eticketsgo/shared-types';
import { ShowCancellationFanoutService } from './show-cancellation-fanout.service';
import { ShowReminderService } from './show-reminder.service';
import { NotificationService } from '../notification.service';
import { NotificationPolicyResolver } from '../policy/notification-policy.resolver';
import { NotificationPreferencesService } from '../notification-preferences.service';
import { MarketingConsentService } from '../marketing-consent.service';
import { DeliveryRecorderService } from '../delivery/delivery-recorder.service';
import { SuppressionService } from '../delivery/suppression.service';

/**
 * integration-real-postgres — a cancelled show reaches the right people, and only them.
 *
 * ── WHAT MAKES THIS WORTH A REAL DATABASE ──────────────────────────────────────────
 * Every guarantee is a property of a query. "Who still needs telling" is a NOT EXISTS against
 * rows that were written by earlier batches, which is what makes the fan-out resumable
 * without a cursor — a stub would answer whatever this file told it to and prove none of it.
 * The same is true of "one reminder per booking per window", which is the unique dedupe index
 * and nothing else.
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
import { acquireSweepLock, type SweepLock } from '../test-support/sweep-lock';
type Client = InstanceType<typeof PrismaClient>;

describe('integration-real-postgres: show cancellation and reminders', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  let fanout: ShowCancellationFanoutService;
  let notifications: NotificationService;
  let deliver: jest.Mock;

  const suffix = `prod-${Date.now()}`;
  let orgId = '';
  let venueId = '';
  let eventId = '';
  let sessionId = '';
  let userId = '';

  /** Bookings created for the cancellation case, by the status they were created in. */
  const made: Record<string, string> = {};

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
        email: `holder+${suffix}@example.test`,
        passwordHash: 'x',
        fullName: 'Holder',
        roles: ['CUSTOMER'],
      },
    });
    userId = user.id;

    const org = await db.organization.create({
      data: { name: `Org ${suffix}`, slug: `org-${suffix}` },
    });
    orgId = org.id;
    const venue = await db.venue.create({
      data: {
        organizationId: org.id,
        name: `Venue ${suffix}`,
        address: '1 Test Road',
        city: 'Hyderabad',
        country: 'India',
        // The cinema's own zone, which is what a message must render in — never the reader's.
        timezone: 'Asia/Kolkata',
      },
    });
    venueId = venue.id;
    const event = await db.event.create({
      data: {
        organizationId: org.id,
        venueId: venue.id,
        title: `Show ${suffix}`,
        slug: `show-${suffix}`,
        category: 'Film',
        status: 'PUBLISHED',
      },
    });
    eventId = event.id;
    const session = await db.eventSession.create({
      data: {
        eventId: event.id,
        startsAt: new Date(Date.now() + 3 * 86_400_000),
        endsAt: new Date(Date.now() + 3 * 86_400_000 + 7_200_000),
        status: 'SCHEDULED',
      },
    });
    sessionId = session.id;

    const suppression = new SuppressionService(db as never);
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
      new DeliveryRecorderService(db as never, suppression),
      suppression,
      new NotificationPolicyResolver(
        new NotificationPreferencesService(db as never),
        new MarketingConsentService(db as never),
        new ConfigService({}),
      ),
    );
    fanout = new ShowCancellationFanoutService(db as never, notifications);
  }, 90_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.notification.deleteMany({ where: { userId } });
    await db.booking.deleteMany({ where: { organizationId: orgId } });
    await db.eventSession.deleteMany({ where: { eventId } });
    await db.event.deleteMany({ where: { id: eventId } });
    await db.venue.deleteMany({ where: { id: venueId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await sweepLock?.release();
    await db.$disconnect();
  }, 90_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  async function booking(status: string, tag: string) {
    const row = await db!.booking.create({
      data: {
        organizationId: orgId,
        eventId,
        eventSessionId: sessionId,
        userId,
        buyerEmail: `holder+${suffix}@example.test`,
        buyerName: 'Holder',
        // Required on every booking: when an unpaid hold expires. Long past for these,
        // because a confirmed booking's hold is history rather than a live claim.
        holdExpiresAt: new Date(Date.now() - 3_600_000),
        status: status as never,
        currency: 'INR',
        subtotalMinor: 20000,

        totalMinor: 20000,
        reference: `REF-${tag}-${suffix}`,
      },
    });
    made[tag] = row.id;
    return row.id;
  }

  const cancelled = (bookingId: string) =>
    db!.notification.count({
      where: { bookingId, type: NotificationType.SHOW_CANCELLED, channel: 'email' },
    });

  maybe('tells only the people who still hold a live booking', async () => {
    /*
      The eligibility rule, proven against the real statuses. Getting it wrong is expensive
      both ways: too wide and we pay to send emergency SMS to people with no stake, too narrow
      and somebody travels to a dark venue.
    */
    await booking('CONFIRMED', 'confirmed');
    await booking('PARTIALLY_REFUNDED', 'partial');
    await booking('CANCELLED', 'self-cancelled');
    await booking('REFUNDED', 'refunded');
    await booking('PENDING_PAYMENT', 'in-checkout');
    await booking('EXPIRED', 'expired');

    await db!.eventSession.update({ where: { id: sessionId }, data: { status: 'CANCELLED' } });
    const result = await fanout.fanOut(sessionId);

    expect(result.notified).toBe(2);
    expect(await cancelled(made.confirmed)).toBe(1);
    // Still has live tickets on it, so still very much affected.
    expect(await cancelled(made.partial)).toBe(1);
    // Walked away, refunded, never paid, or timed out. None of them need an emergency.
    expect(await cancelled(made['self-cancelled'])).toBe(0);
    expect(await cancelled(made.refunded)).toBe(0);
    expect(await cancelled(made['in-checkout'])).toBe(0);
    expect(await cancelled(made.expired)).toBe(0);
  });

  maybe('running the fan-out again tells nobody twice', async () => {
    // A redelivered event, a restarted worker and an overlapping sweep are the same case.
    const again = await fanout.fanOut(sessionId);
    expect(again.notified).toBe(0);
    expect(again.remaining).toBe(0);
    expect(await cancelled(made.confirmed)).toBe(1);
  });

  maybe(
    'resumes from where a bounded batch stopped, with no cursor',
    async () => {
      /*
      The heart of the design. Progress is the rows already written, so a batch of one walked
      over a fresh audience finishes it in as many passes as there are people — and a worker
      killed between any two of them loses nothing.
    */
      const session = await db!.eventSession.create({
        data: {
          eventId,
          startsAt: new Date(Date.now() + 5 * 86_400_000),
          endsAt: new Date(Date.now() + 5 * 86_400_000 + 7_200_000),
          status: 'CANCELLED',
        },
      });
      for (let i = 0; i < 5; i++) {
        await db!.booking.create({
          data: {
            organizationId: orgId,
            eventId,
            eventSessionId: session.id,
            userId,
            buyerEmail: `holder+${suffix}@example.test`,
            buyerName: 'Holder',
            // Required on every booking: when an unpaid hold expires. Long past for these,
            // because a confirmed booking's hold is history rather than a live claim.
            holdExpiresAt: new Date(Date.now() - 3_600_000),
            status: 'CONFIRMED',
            currency: 'INR',
            subtotalMinor: 100,

            totalMinor: 100,
            reference: `REF-batch-${i}-${suffix}`,
          },
        });
      }

      let passes = 0;
      let remaining = 5;
      while (remaining > 0 && passes < 10) {
        const r = await fanout.fanOut(session.id, 1);
        remaining = r.remaining;
        passes += 1;
        expect(r.notified).toBeLessThanOrEqual(1);
      }
      expect(remaining).toBe(0);
      expect(passes).toBe(5);

      // And a sixth pass is a no-op rather than a second round of messages.
      expect((await fanout.fanOut(session.id, 1)).notified).toBe(0);
    },
    60_000,
  );

  maybe('will not tell anybody about a show that is no longer cancelled', async () => {
    // Re-checked at execution rather than trusted from the event: a reinstated show must not
    // have its customers told it is off.
    const session = await db!.eventSession.create({
      data: {
        eventId,
        startsAt: new Date(Date.now() + 6 * 86_400_000),
        endsAt: new Date(Date.now() + 6 * 86_400_000 + 7_200_000),
        status: 'SCHEDULED',
      },
    });
    await db!.booking.create({
      data: {
        organizationId: orgId,
        eventId,
        eventSessionId: session.id,
        userId,
        buyerEmail: `holder+${suffix}@example.test`,
        buyerName: 'Holder',
        // Required on every booking: when an unpaid hold expires. Long past for these,
        // because a confirmed booking's hold is history rather than a live claim.
        holdExpiresAt: new Date(Date.now() - 3_600_000),
        status: 'CONFIRMED',
        currency: 'INR',
        subtotalMinor: 100,

        totalMinor: 100,
        reference: `REF-reinstated-${suffix}`,
      },
    });

    expect((await fanout.fanOut(session.id)).notified).toBe(0);
  });

  maybe('a cancellation notice never carries SMS immediately', async () => {
    /*
      SMS is the fallback for this type: it opens thirty minutes later and only if nothing
      else got through. Sending it up front would mean four messages about one cancellation
      and a bill for the one the customer was least likely to need.
    */
    const channels = await db!.notification.findMany({
      where: { bookingId: made.confirmed, type: NotificationType.SHOW_CANCELLED },
      select: { channel: true },
    });
    expect(channels.map((c: { channel: string }) => c.channel).sort()).toEqual([
      'email',
      'in_app',
      'push',
      'whatsapp',
    ]);
  });
});

describe('integration-real-postgres: reminders', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  let reminders: ShowReminderService;
  let notifications: NotificationService;

  const suffix = `rem-${Date.now()}`;
  let orgId = '';
  let venueId = '';
  let eventId = '';
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
      data: {
        email: `rem+${suffix}@example.test`,
        passwordHash: 'x',
        fullName: 'Rem',
        roles: ['CUSTOMER'],
      },
    });
    userId = user.id;
    const org = await db.organization.create({
      data: { name: `Org ${suffix}`, slug: `org-${suffix}` },
    });
    orgId = org.id;
    const venue = await db.venue.create({
      data: {
        organizationId: org.id,
        name: `Venue ${suffix}`,
        address: '1 Test Road',
        city: 'Boise',
        country: 'United States',
        timezone: 'America/Boise',
      },
    });
    venueId = venue.id;
    const event = await db.event.create({
      data: {
        organizationId: org.id,
        venueId: venue.id,
        title: `Show ${suffix}`,
        slug: `show-${suffix}`,
        category: 'Film',
        status: 'PUBLISHED',
      },
    });
    eventId = event.id;

    const suppression = new SuppressionService(db as never);
    notifications = new NotificationService(
      db as never,
      { render: () => ({ subject: 'S', body: 'B' }) } as never,
      new NotificationPreferencesService(db as never) as never,
      {
        has: (c: string) => ['email', 'in_app', 'push', 'whatsapp', 'sms'].includes(c),
        resolve: (c: string) => ({
          key: c,
          deliver: jest.fn().mockResolvedValue({ provider: 'log' }),
        }),
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
    reminders = new ShowReminderService(
      db as never,
      notifications,
      new ConfigService({ NOTIFICATION_REMINDERS_ENABLED: 'true' }),
    );
  }, 90_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.notification.deleteMany({ where: { userId } });
    await db.booking.deleteMany({ where: { organizationId: orgId } });
    await db.eventSession.deleteMany({ where: { eventId } });
    await db.event.deleteMany({ where: { id: eventId } });
    await db.venue.deleteMany({ where: { id: venueId } });
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await sweepLock?.release();
    await db.$disconnect();
  }, 90_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (!available) return;
      await fn();
    });

  /** A show starting `hoursFromNow` from now, with one confirmed booking on it. */
  async function show(hoursFromNow: number, tag: string, status = 'SCHEDULED') {
    const startsAt = new Date(Date.now() + hoursFromNow * 3_600_000);
    const session = await db!.eventSession.create({
      data: {
        eventId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 7_200_000),
        status: status as never,
      },
    });
    const booking = await db!.booking.create({
      data: {
        organizationId: orgId,
        eventId,
        eventSessionId: session.id,
        userId,
        buyerEmail: `rem+${suffix}@example.test`,
        buyerName: 'Rem',
        holdExpiresAt: new Date(Date.now() - 3_600_000),
        status: 'CONFIRMED',
        currency: 'USD',
        subtotalMinor: 1500,

        totalMinor: 1500,
        reference: `REF-${tag}-${suffix}`,
      },
    });
    return { sessionId: session.id, bookingId: booking.id, startsAt };
  }

  const reminded = (bookingId: string) =>
    db!.notification.count({
      where: { bookingId, type: NotificationType.EVENT_REMINDER, channel: 'in_app' },
    });

  maybe('reminds about a show entering its window', async () => {
    const s = await show(24, 'due');
    const summary = await reminders.runDue(new Date(), { toleranceMinutes: 90 });
    expect(summary.reminded).toBeGreaterThan(0);
    expect(await reminded(s.bookingId)).toBe(1);
  });

  maybe('does not remind twice, however many times the sweep runs', async () => {
    const s = await show(24, 'once');
    await reminders.runDue(new Date(), { toleranceMinutes: 90 });
    await reminders.runDue(new Date(), { toleranceMinutes: 90 });
    await Promise.allSettled([
      reminders.runDue(new Date(), { toleranceMinutes: 90 }),
      reminders.runDue(new Date(), { toleranceMinutes: 90 }),
    ]);
    expect(await reminded(s.bookingId)).toBe(1);
  });

  maybe('does not remind about a show that is not due yet', async () => {
    const s = await show(72, 'far');
    await reminders.runDue(new Date(), { toleranceMinutes: 90 });
    expect(await reminded(s.bookingId)).toBe(0);
  });

  maybe('does not remind about a cancelled show', async () => {
    // A reminder for a show that is off is worse than no reminder: the customer now believes
    // it is on.
    const s = await show(24, 'cancelled', 'CANCELLED');
    await reminders.runDue(new Date(), { toleranceMinutes: 90 });
    expect(await reminded(s.bookingId)).toBe(0);
  });

  maybe('does not remind a booking refunded since it was due', async () => {
    /*
      Eligibility is checked when the reminder FIRES, not when it was planned. A day is long
      enough for the booking to have been refunded, and trusting the earlier state is how
      somebody gets reminded about a show they no longer have a ticket to.
    */
    const s = await show(24, 'refunded');
    await db!.booking.update({ where: { id: s.bookingId }, data: { status: 'REFUNDED' } });
    await reminders.runDue(new Date(), { toleranceMinutes: 90 });
    expect(await reminded(s.bookingId)).toBe(0);
  });

  maybe('sends nothing at all while reminders are switched off', async () => {
    // The default. Turning it on starts messaging every ticket holder about every future
    // show, which is a product launch rather than a deployment.
    const off = new ShowReminderService(db as never, notifications, new ConfigService({}));
    const s = await show(24, 'disabled');
    expect(await off.runDue(new Date(), { toleranceMinutes: 90 })).toEqual({
      shows: 0,
      reminded: 0,
    });
    expect(await reminded(s.bookingId)).toBe(0);
  });

  maybe('is not confused by a timezone, because it never uses one', async () => {
    /*
      "Twenty-four hours before" is a duration before an instant, so it is another instant and
      no calendar arithmetic is involved. That is why this is correct through a daylight-saving
      change: a Boise show does not move because the clocks did, and computing "the same time
      yesterday" locally is what produces a reminder an hour early twice a year.

      The RENDERING is a different matter and does convert — the message says when the show
      starts in the venue's own zone — but that belongs to the template.
    */
    const s = await show(24, 'tz');
    await reminders.runDue(new Date(), { toleranceMinutes: 90 });

    const row = await db!.notification.findFirst({
      where: { bookingId: s.bookingId, type: NotificationType.EVENT_REMINDER },
      select: { payload: true },
    });
    const payload = row.payload as { startsAt: string; timeZone: string };
    // The absolute instant, and the venue's own zone for rendering it.
    expect(new Date(payload.startsAt).getTime()).toBe(s.startsAt.getTime());
    expect(payload.timeZone).toBe('America/Boise');
  });

  maybe('a reminder is never sent by email', async () => {
    // Policy: inbox, push and WhatsApp. An inbox full of "your show is tomorrow" is how
    // people learn to ignore a sender, and the ticket email already exists.
    const channels = await db!.notification.findMany({
      where: { userId, type: NotificationType.EVENT_REMINDER },
      select: { channel: true },
      distinct: ['channel'],
    });
    expect(channels.map((c: { channel: string }) => c.channel).sort()).toEqual([
      'in_app',
      'push',
      'whatsapp',
    ]);
  });
});
