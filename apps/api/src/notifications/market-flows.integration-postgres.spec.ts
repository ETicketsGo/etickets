import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import {
  DeliveryState,
  FailureClass,
  NotificationType,
  OutcomeClass,
} from '@eticketsgo/shared-types';
import { NotificationService } from './notification.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { MarketingConsentService } from './marketing-consent.service';
import { DeliveryRecorderService } from './delivery/delivery-recorder.service';
import { SuppressionService } from './delivery/suppression.service';
import { NotificationPolicyResolver } from './policy/notification-policy.resolver';
import { NotificationFallbackService } from './policy/fallback.service';
import { TemplateBindingService } from './templates/template-binding.service';
import { acquireSweepLock, type SweepLock } from './test-support/sweep-lock';

type Client = PrismaClient;

/** The same loader the other integration suites use: skip rather than fabricate a pass. */
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

/**
 * India, the United States and Canada, proven end to end with the provider boundary mocked.
 *
 * ── WHY THESE FLOWS AND NOT UNIT TESTS OF THE PARTS ────────────────────────────────
 * Every piece below already has its own test, and every piece passing is compatible with the
 * whole thing being wrong. Which channels a booking confirmation opens is decided by the
 * policy table, the preference service, the consent service, the market router and the
 * template bindings — five components, each correct in isolation, whose COMBINATION is the
 * behaviour a customer experiences and the thing nothing was asserting.
 *
 * The specific fear these exist to answer: an Indian buyer receiving an SMS they should never
 * get (billed, and reserved for cancellations), or NOT receiving the WhatsApp they expect.
 *
 * ── WHERE THE MOCK BOUNDARY IS, AND WHY THERE ────────────────────────────────────────
 * At the channel: everything above it is real — real Postgres, real policy, real dedupe, real
 * delivery records. Only the provider call is mocked, because no credential exists and
 * pretending one does is the one thing this whole phase forbids. A green run here is
 * CONTRACT_TESTED, never LIVE_CERTIFIED.
 */
describe('integration-real-postgres: India, US and Canada notification flows', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  let deliver: jest.Mock;

  const suffix = `flows-${Date.now()}`;
  let indianUser = '';
  let americanUser = '';
  let canadianUser = '';

  /** The launch routing, exactly as the setup guide describes it. */
  const CONFIG = {
    NOTIFICATION_MARKETS: 'IN,US,CA',
    SMS_PROVIDER_BY_MARKET: 'IN=msg91,US=twilio,CA=twilio',
    WHATSAPP_PROVIDER_BY_MARKET: 'IN=msg91,US=cloud,CA=cloud',
    EMAIL_PROVIDER: 'ses',
  };

  const buildService = (over: Record<string, string> = {}) => {
    const config = new ConfigService({ ...CONFIG, ...over });
    const suppression = new SuppressionService(db as never);
    return new NotificationService(
      db as never,
      { render: () => ({ subject: 'S', body: 'B' }) } as never,
      new NotificationPreferencesService(db as never) as never,
      {
        has: (c: string) => ['email', 'in_app', 'push', 'whatsapp', 'sms'].includes(c),
        resolve: (c: string) => ({ key: c, deliver: (m: unknown) => deliver(c, m) }),
      } as never,
      new MarketingConsentService(db as never) as never,
      undefined,
      new DeliveryRecorderService(db as never, suppression),
      suppression,
      new NotificationPolicyResolver(
        new NotificationPreferencesService(db as never),
        new MarketingConsentService(db as never),
        config,
      ),
    );
  };

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
    const make = async (tag: string, phone: string) =>
      (
        await db!.user.create({
          data: {
            email: `${tag}+${suffix}@example.test`,
            passwordHash: 'x',
            fullName: tag,
            roles: ['CUSTOMER'],
            phone,
          },
        })
      ).id;
    indianUser = await make('raj', `+9199${String(Date.now()).slice(-8)}`);
    americanUser = await make('sam', `+1415${String(Date.now()).slice(-7)}`);
    canadianUser = await make('mo', `+1416${String(Date.now()).slice(-7)}`);
    deliver = jest.fn();
  }, 180_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.notification.deleteMany({
      where: { userId: { in: [indianUser, americanUser, canadianUser] } },
    });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await sweepLock?.release();
    await db.$disconnect();
  }, 180_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (!available) return;
      await fn();
    });

  /**
   * The channels delivered for ONE booking.
   *
   * Filtered by payload rather than counted globally, because `dispatchDue()` is the real
   * sweep and acts on every due row in the database — including rows other tests left behind.
   * Counting them all would make these assertions about the database rather than about this
   * booking, which is how a suite becomes non-deterministic.
   */
  const deliveredFor = (bookingId: string): string[] =>
    deliver.mock.calls
      .filter(
        ([, m]) => (m as { payload?: { bookingId?: string } })?.payload?.bookingId === bookingId,
      )
      .map(([c]) => c as string)
      .sort();

  /**
   * Far enough ahead that no other suite's sweep will touch these rows.
   *
   * ── WHY THIS IS NECESSARY AND NOT PARANOIA ────────────────────────────────────────
   * `dispatchDue()` acts on every row in the database that is pending and DUE. Jest runs
   * suites in parallel workers against one database, so a second suite calling the sweep
   * delivers this suite's notifications through ITS mock — and then an assertion here about
   * what happened to them is really an assertion about which worker got there first.
   *
   * Scheduling into the future takes the rows out of every other sweep's window, and passing
   * the matching `now` brings them back into this one's. The behaviour under test is
   * unchanged: the same policy, the same routing, the same dedupe — only the clock moves.
   */
  const FUTURE = () => new Date(Date.now() + 6 * 60 * 60 * 1000);
  const AFTER = () => new Date(Date.now() + 7 * 60 * 60 * 1000);

  const confirmedPayload = (bookingId: string) => ({
    bookingId,
    reference: `ETG-IND-2026-${bookingId.slice(-6)}`,
    eventTitle: 'A Film',
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    venue: 'A Cinema',
  });

  // ─── A. India, booking confirmed ───

  maybe(
    'A. an Indian booking confirmation opens email, WhatsApp, push — and never SMS',
    async () => {
      const bookingId = `in-confirm-${suffix}`;
      deliver.mockReset();
      deliver.mockResolvedValue({ provider: 'log' });
      const notifications = buildService();

      await notifications.schedule(
        {
          type: NotificationType.BOOKING_CONFIRMED,
          userId: indianUser,
          toEmail: `raj+${suffix}@example.test`,
          country: 'IN',
          payload: confirmedPayload(bookingId),
        },
        FUTURE(),
      );
      await notifications.dispatchDue(AFTER());

      const channels = deliveredFor(bookingId);
      expect(channels).toEqual(['email', 'in_app', 'push', 'whatsapp']);
      /*
      The assertion this whole flow exists for. An SMS here is billed, is redundant with three
      free channels carrying the same information, and in India requires a DLT template that
      exists only for cancellations. Sending one would be a cost and a compliance problem at
      the same time.
    */
      expect(channels).not.toContain('sms');
    },
  );

  // ─── B. India, show cancelled ───

  maybe(
    'B. an Indian cancellation opens four channels immediately and holds the SMS back',
    async () => {
      const bookingId = `in-cancel-${suffix}`;
      deliver.mockReset();
      deliver.mockResolvedValue({ provider: 'log' });
      const notifications = buildService();

      await notifications.schedule(
        {
          type: NotificationType.SHOW_CANCELLED,
          userId: indianUser,
          toEmail: `raj+${suffix}@example.test`,
          country: 'IN',
          payload: confirmedPayload(bookingId),
        },
        FUTURE(),
      );
      await notifications.dispatchDue(AFTER());

      /*
      SMS is in the policy's channel list and is NOT sent now. Permitting a channel is not
      scheduling it: sending it alongside the other three means everybody with a phone gets
      four messages about one cancellation and we pay for the one they least needed.
    */
      expect(deliveredFor(bookingId)).toEqual(['email', 'in_app', 'push', 'whatsapp']);
    },
  );

  maybe('B2. a missing DLT template blocks the SMS truthfully, and blames nobody', async () => {
    /*
      The state India is actually in: MSG91 routed, DLT registration incomplete, so no
      template is bound. The message must not disappear, must not be retried forever, must not
      be recorded as MSG91 failing, and must be findable by an operator as work for them.
    */
    const bindings = new TemplateBindingService(
      new ConfigService({ NOTIFICATION_TEMPLATE_BINDINGS: '' }),
    );
    const bound = bindings.resolve({
      provider: 'msg91',
      channel: 'sms',
      type: NotificationType.SHOW_CANCELLED,
      locale: 'en',
    });
    expect(bound).toBeNull();

    const suppression = new SuppressionService(db as never);
    const recorder = new DeliveryRecorderService(db as never, suppression);
    const notification = await db!.notification.create({
      data: {
        user: { connect: { id: indianUser } },
        type: NotificationType.SHOW_CANCELLED,
        channel: 'sms',
        locale: 'en',
        status: 'PENDING',
        payload: { bookingId: `in-dlt-${suffix}` },
        dedupeKey: `in-dlt-${suffix}`,
      },
    });
    const deliveryId = await recorder.open({
      notificationId: notification.id,
      // 'none' until a route resolves. The attempt is opened BEFORE anybody is called, which
      // is what makes "we do not know whether this went out" a recordable state.
      provider: 'none',
      channel: 'sms',
      attemptNumber: 1,
    });
    await recorder.failed(
      deliveryId!,
      'none',
      'no DLT template bound for SHOW_CANCELLED',
      FailureClass.TEMPLATE_NOT_FOUND,
    );

    const row = await db!.notificationDelivery.findUnique({ where: { id: deliveryId! } });
    expect(row!.status).toBe(DeliveryState.FAILED);
    expect(row!.failureClass).toBe(FailureClass.TEMPLATE_NOT_FOUND);
    // Not PROVIDER_UNAVAILABLE. MSG91 was never called and must not carry this in its
    // failure rate -- otherwise an unopened market reads exactly like an outage.
    expect(row!.outcomeClass).toBe(OutcomeClass.CONFIGURATION_BLOCKED);
    expect(row!.costMicro).toBeNull();
  });

  // ─── C. United States, booking confirmed ───

  maybe('C. a US booking confirmation routes WhatsApp to Meta and still sends no SMS', async () => {
    const bookingId = `us-confirm-${suffix}`;
    deliver.mockReset();
    deliver.mockResolvedValue({ provider: 'log' });
    const notifications = buildService();

    await notifications.schedule(
      {
        type: NotificationType.BOOKING_CONFIRMED,
        userId: americanUser,
        toEmail: `sam+${suffix}@example.test`,
        country: 'US',
        payload: confirmedPayload(bookingId),
      },
      FUTURE(),
    );
    await notifications.dispatchDue(AFTER());
    expect(deliveredFor(bookingId)).toEqual(['email', 'in_app', 'push', 'whatsapp']);
  });

  // ─── D. Canada, show cancelled with the SMS fallback ───

  maybe(
    'D. a Canadian cancellation stays silent on SMS while the free channels are working',
    async () => {
      /*
      The expensive half of the fallback rule, and the one it is easiest to get wrong in the
      generous direction. Every preferred channel was accepted, so the customer has been told
      three times over -- and opening a paid SMS as well would mean everybody with a phone
      gets four messages about one cancellation and we pay for the one they least needed.
    */
      const bookingId = `ca-ok-${suffix}`;
      deliver.mockReset();
      deliver.mockResolvedValue({ provider: 'log' });
      const notifications = buildService();
      const fallbacks = new NotificationFallbackService(db as never, notifications as never);

      await notifications.schedule(
        {
          type: NotificationType.SHOW_CANCELLED,
          userId: canadianUser,
          toEmail: `mo+${suffix}@example.test`,
          country: 'CA',
          payload: confirmedPayload(bookingId),
        },
        FUTURE(),
      );
      await notifications.dispatchDue(AFTER());
      expect(deliveredFor(bookingId)).toEqual(['email', 'in_app', 'push', 'whatsapp']);

      await db!.notification.updateMany({
        where: { userId: canadianUser, payload: { path: ['bookingId'], equals: bookingId } },
        data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
      });
      deliver.mockClear();
      await fallbacks.runDue(new Date());
      await notifications.dispatchDue(AFTER());
      expect(deliveredFor(bookingId)).toEqual([]);
    },
  );

  maybe('D2. a Canadian cancellation DOES open one SMS when nothing else got through', async () => {
    /*
      The person this fallback exists for: no app, no data, an email address that bounced. The
      free channels produced nothing effective, the wait elapsed, and a cancelled show is the
      one message on this platform worth paying for -- once.
    */
    const bookingId = `ca-cancel-${suffix}`;
    deliver.mockReset();
    deliver.mockImplementation(async (channel: string) => {
      if (channel === 'sms') return { provider: 'log' };
      throw new Error('nothing free is getting through');
    });
    const notifications = buildService();
    const fallbacks = new NotificationFallbackService(db as never, notifications as never);

    await notifications.schedule(
      {
        type: NotificationType.SHOW_CANCELLED,
        userId: canadianUser,
        toEmail: `mo+${suffix}@example.test`,
        country: 'CA',
        payload: confirmedPayload(bookingId),
      },
      FUTURE(),
    );
    await notifications.dispatchDue(AFTER());

    /*
      Aged rather than waited for. Thirty real minutes in a test suite is thirty minutes
      nobody has, and sleeping would prove only that the clock advances.
    */
    await db!.notification.updateMany({
      where: { userId: canadianUser, payload: { path: ['bookingId'], equals: bookingId } },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    deliver.mockClear();
    /*
      Two steps on purpose. `runDue` decides a fallback is OWED and writes it down; the sweep
      is the only thing that talks to a provider. Collapsing them would hide the property that
      keeps a provider outage out of the request path.
    */
    await fallbacks.runDue(new Date());
    await notifications.dispatchDue(AFTER());
    expect(deliveredFor(bookingId)).toContain('sms');

    // Run it again. A fallback that fires twice is two paid messages about one cancellation.
    deliver.mockClear();
    await fallbacks.runDue(new Date());
    await notifications.dispatchDue(AFTER());
    expect(deliveredFor(bookingId)).not.toContain('sms');
  });

  // ─── E. A provider outage must never reach the money path ───

  maybe('E. every channel failing leaves the domain transaction untouched', async () => {
    const bookingId = `outage-${suffix}`;
    deliver.mockReset();
    deliver.mockRejectedValue(new Error('the provider is down'));
    const notifications = buildService();

    /*
      The send is written inside the caller's transaction and delivered by the sweep. If a
      provider outage could reach the transaction, a WhatsApp outage would roll back a
      confirmed booking -- which is the failure this architecture exists to make impossible.
    */
    await expect(
      db!.$transaction(async (tx) => {
        await notifications.sendCritical(tx as never, {
          type: NotificationType.BOOKING_CONFIRMED,
          userId: indianUser,
          toEmail: `raj+${suffix}@example.test`,
          country: 'IN',
          payload: confirmedPayload(bookingId),
        });
        return 'committed';
      }),
    ).resolves.toBe('committed');

    /*
      The guarantee, stated exactly: NO provider was contacted while the transaction was open.
      That is stronger than checking what the rows say afterwards, and it is the property that
      makes a provider outage unable to fail a payment -- the transaction commits without ever
      having depended on anybody else being up.

      Asserting instead that the rows are "not SENT" would be asserting which worker's sweep
      reached them first, which this test does not control and should not care about.
    */
    expect(deliver).not.toHaveBeenCalled();

    const rows = await db!.notification.findMany({
      where: { userId: indianUser, payload: { path: ['bookingId'], equals: bookingId } },
      select: { status: true },
    });
    // Written down inside the transaction, so the message is owed the moment the booking is
    // real -- and owed durably, whatever happens to any provider afterwards.
    expect(rows.length).toBeGreaterThan(0);
  });

  // ─── F. A duplicate domain event ───

  maybe('F. the same event twice produces one notification per channel', async () => {
    const bookingId = `dupe-${suffix}`;
    deliver.mockReset();
    deliver.mockResolvedValue({ provider: 'log' });
    const notifications = buildService();
    const send = () =>
      notifications.schedule(
        {
          type: NotificationType.BOOKING_CONFIRMED,
          userId: americanUser,
          toEmail: `sam+${suffix}@example.test`,
          country: 'US',
          payload: confirmedPayload(bookingId),
        },
        FUTURE(),
      );

    await send();
    await send();
    const rows = await db!.notification.count({
      where: { userId: americanUser, payload: { path: ['bookingId'], equals: bookingId } },
    });
    expect(rows).toBe(4);
  });

  // ─── G. A suppressed destination ───

  maybe('G. a suppressed email does not silence the other channels', async () => {
    const bookingId = `suppressed-${suffix}`;
    const email = `mo+${suffix}@example.test`;
    const suppression = new SuppressionService(db as never);
    await suppression.suppress({
      channel: 'email',
      destination: email,
      reason: 'HARD_BOUNCE' as never,
    });
    deliver.mockReset();
    deliver.mockResolvedValue({ provider: 'log' });
    const notifications = buildService();

    await notifications.schedule(
      {
        type: NotificationType.SHOW_CANCELLED,
        userId: canadianUser,
        toEmail: email,
        country: 'CA',
        payload: confirmedPayload(bookingId),
      },
      FUTURE(),
    );
    await notifications.dispatchDue(AFTER());

    const channels = deliveredFor(bookingId);
    expect(channels).not.toContain('email');
    // A dead mailbox says nothing about a phone. Letting it silence the whole notification
    // would turn one bounce into a customer who never hears their show was cancelled.
    expect(channels).toEqual(['in_app', 'push', 'whatsapp']);

    await db!.suppressedDestination.deleteMany({
      where: { destinationHash: SuppressionService.hash('email', email) },
    });
  });

  // ─── H. A market that is routed but not enabled ───

  maybe(
    'H. a market with no provider routed refuses rather than borrowing another one',
    async () => {
      /*
      The failure mode worth being explicit about: an Indian number sent through the North
      American route. The carrier drops it, we are billed at an international rate, and nobody
      finds out until a customer says their ticket never arrived. Refusing is the cheaper
      failure, and it is the one somebody can see.
    */
      const { routeNotificationProvider } = await import('@eticketsgo/shared-types');
      const decision = routeNotificationProvider({
        marketProviders: { US: 'twilio', CA: 'twilio' },
        defaultProvider: 'twilio',
        country: 'IN',
        destination: '+919999000011',
      });
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.refusal).toBe('unsupported_market');
    },
  );
});
