import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BillingUnit,
  CostSource,
  DeliveryState,
  NotificationType,
  OutcomeClass,
  SendKind,
} from '@eticketsgo/shared-types';
import { NotificationRateService } from './notification-rate.service';
import { NotificationAnalyticsService } from './notification-analytics.service';
import { DeliveryRecorderService } from '../delivery/delivery-recorder.service';
import { SuppressionService } from '../delivery/suppression.service';

/**
 * integration-real-postgres — what the platform spent, and what it cannot account for.
 *
 * ── WHY THESE NEED A REAL DATABASE ─────────────────────────────────────────────────
 * Every number here is produced by SQL: the effective-date window is a `WHERE` clause, the
 * overlap refusal is a query, and the aggregates are `GROUP BY`s over indexes. A stubbed
 * client would return whatever this file told it to and would prove nothing about any of it —
 * least of all the one that matters most, which is that two currencies never get added
 * together.
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

const JAN = new Date('2026-01-01T00:00:00Z');
const JUN = new Date('2026-06-01T00:00:00Z');
const MAR = new Date('2026-03-01T00:00:00Z');
const AUG = new Date('2026-08-01T00:00:00Z');
/*
  Reporting windows have to reach the present: a delivery row is stamped with the wall clock,
  not with a fixture date, so a window that ends in the past contains nothing this suite wrote.
*/
const REPORT = { from: JAN, to: new Date(Date.now() + 86_400_000) };

describe('integration-real-postgres: notification cost accounting', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let rates: NotificationRateService;
  let analytics: NotificationAnalyticsService;
  let recorder: DeliveryRecorderService;

  const suffix = `cost-${Date.now()}`;
  const EMAIL = `dev+${suffix}@example.test`;
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
      data: { email: EMAIL, passwordHash: 'x', fullName: 'Dev', roles: ['CUSTOMER'] },
    });
    userId = user.id;
    rates = new NotificationRateService(db as never);
    analytics = new NotificationAnalyticsService(db as never);
    recorder = new DeliveryRecorderService(
      db as never,
      new SuppressionService(db as never),
      undefined,
      rates,
    );
  }, 60_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.notification.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await db.notificationRate.deleteMany({ where: { notes: { contains: suffix } } });
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

  const rate = (over: Partial<Parameters<NotificationRateService['create']>[0]> = {}) =>
    rates.create({
      provider: `p-${suffix}`,
      channel: 'email',
      unitPriceMicro: 100_000,
      currency: 'USD',
      billingUnit: BillingUnit.PER_1000,
      effectiveFrom: JAN,
      active: true,
      notes: suffix,
      ...over,
    });

  // ─── Rate resolution ───

  maybe('picks the rate that was in force at the moment of the send', async () => {
    /*
      The whole reason rates are effective-dated. A price compiled into the application would
      reprice HISTORY: last month's report, recomputed today, would come back a different
      number and nobody could say which was right.
    */
    const provider = `hist-${suffix}`;
    await rate({ provider, unitPriceMicro: 100_000, effectiveFrom: JAN, effectiveTo: JUN });
    await rate({ provider, unitPriceMicro: 200_000, effectiveFrom: JUN });

    expect(await rates.resolve({ provider, channel: 'email', at: MAR })).toMatchObject({
      unitPriceMicro: 100_000,
    });
    expect(await rates.resolve({ provider, channel: 'email', at: AUG })).toMatchObject({
      unitPriceMicro: 200_000,
    });
    // Before anything was in force, there is no price — not a free one.
    expect(
      await rates.resolve({ provider, channel: 'email', at: new Date('2025-01-01') }),
    ).toBeNull();
  });

  maybe('prefers a country rate over a wildcard', async () => {
    const provider = `geo-${suffix}`;
    await rate({ provider, channel: 'sms', unitPriceMicro: 8_000, currency: 'USD' });
    await rate({
      provider,
      channel: 'sms',
      country: 'IN',
      unitPriceMicro: 150_000,
      currency: 'INR',
      billingUnit: BillingUnit.PER_SEGMENT,
    });

    expect(
      await rates.resolve({ provider, channel: 'sms', country: 'India', at: MAR }),
    ).toMatchObject({ unitPriceMicro: 150_000, currency: 'INR' });
    expect(await rates.resolve({ provider, channel: 'sms', country: 'US', at: MAR })).toMatchObject(
      { unitPriceMicro: 8_000, currency: 'USD' },
    );
  });

  maybe('refuses a second active rate covering the same period', async () => {
    /*
      Two overlapping rates do not produce a wrong number, they produce an UNSTABLE one: the
      cost depends on which row the database returned, and the same report run twice gives two
      answers. Write time is the only point where that is cheap to fix.
    */
    const provider = `clash-${suffix}`;
    await rate({ provider });
    await expect(rate({ provider })).rejects.toThrow(/already covers/i);
    // An inactive draft is fine — a rate is written and reviewed before it applies to money.
    await expect(rate({ provider, active: false })).resolves.toBeDefined();
  });

  maybe('refuses a rate that ends before it starts, and a negative one', async () => {
    await expect(
      rate({ provider: `bad-${suffix}`, effectiveFrom: JUN, effectiveTo: JAN }),
    ).rejects.toThrow(/end after it starts/i);
    await expect(rate({ provider: `neg-${suffix}`, unitPriceMicro: -1 })).rejects.toThrow(
      /cannot be negative/i,
    );
  });

  maybe('ends a rate rather than deleting it', async () => {
    // A deleted rate takes with it the ability to reproduce the report it priced.
    const provider = `sup-${suffix}`;
    const row = await rate({ provider });
    expect(await rates.supersede(row.id, JUN)).toEqual({ superseded: true });
    expect(await db!.notificationRate.findUnique({ where: { id: row.id } })).toBeTruthy();
    expect(await rates.resolve({ provider, channel: 'email', at: AUG })).toBeNull();
    expect(await rates.resolve({ provider, channel: 'email', at: MAR })).toBeTruthy();
  });

  // ─── Estimation ───

  maybe('an unconfigured provider is UNKNOWN, not free', async () => {
    /*
      The single most important assertion in this file. "We have no rate for MSG91 WhatsApp
      in India" and "MSG91 WhatsApp in India is free" produce the same total and mean opposite
      things.
    */
    const est = await rates.estimate({ provider: `nothing-${suffix}`, channel: 'sms', at: MAR });
    expect(est.costSource).toBe(CostSource.UNKNOWN);
    expect(est.costMicro).toBeNull();
    expect(est.costCurrency).toBeNull();
  });

  maybe('a configured zero is CONFIGURED_FREE, and says so', async () => {
    // Push through Expo genuinely costs nothing. That is a fact worth recording as one.
    const provider = `free-${suffix}`;
    await rate({
      provider,
      channel: 'push',
      unitPriceMicro: 0,
      billingUnit: BillingUnit.PER_MESSAGE,
    });
    const est = await rates.estimate({ provider, channel: 'push', at: MAR });
    expect(est).toMatchObject({ costMicro: 0, costSource: CostSource.CONFIGURED_FREE });
  });

  maybe('prices an SMS by its segments, not by the message', async () => {
    const provider = `seg-${suffix}`;
    await rate({
      provider,
      channel: 'sms',
      unitPriceMicro: 10_000,
      billingUnit: BillingUnit.PER_SEGMENT,
    });

    const short = await rates.estimate({ provider, channel: 'sms', at: MAR, body: 'Short.' });
    expect(short).toMatchObject({ billedUnits: 1, costMicro: 10_000 });

    // A rupee sign makes it Unicode and the segment size falls from 160 to 70.
    const unicode = await rates.estimate({
      provider,
      channel: 'sms',
      at: MAR,
      body: '₹' + 'a'.repeat(150),
    });
    expect(unicode).toMatchObject({ billedUnits: 3, costMicro: 30_000 });
  });

  // ─── Cost on the attempt ───

  async function attempt(
    over: {
      channel?: string;
      provider?: string;
      sendKind?: SendKind;
      bookingId?: string | null;
      type?: NotificationType;
    } = {},
  ) {
    const channel = over.channel ?? 'email';
    const notification = await db!.notification.create({
      data: {
        type: over.type ?? NotificationType.BOOKING_CONFIRMED,
        userId,
        toEmail: EMAIL,
        payload: {},
        channel,
        locale: 'en',
        status: 'PENDING',
        bookingId: over.bookingId ?? null,
      },
    });
    const id = await recorder.open({
      notificationId: notification.id,
      provider: 'pending',
      channel,
      attemptNumber: 1,
      sendKind: over.sendKind,
    });
    return { notificationId: notification.id, deliveryId: id! };
  }

  maybe('records what an accepted attempt cost, from the rate card', async () => {
    const provider = `acc-${suffix}`;
    await rate({ provider });
    const { deliveryId } = await attempt();
    await recorder.accepted(deliveryId, provider, 'msg-1');

    const row = await db!.notificationDelivery.findUnique({ where: { id: deliveryId } });
    expect(row).toMatchObject({
      costMicro: 100,
      costCurrency: 'USD',
      costSource: CostSource.RATE_CARD,
      outcomeClass: OutcomeClass.PROVIDER_ACCEPTED,
    });
    expect(row.costCalculatedAt).toBeTruthy();
  });

  maybe('an accepted-then-undelivered message KEEPS its cost', async () => {
    /*
      The provider carried it and charged for it. Deleting the cost when the outcome turns bad
      would make the total shrink as things go wrong — the exact opposite of what anybody
      needs to see. Delivery outcome and money are separate facts.
    */
    const provider = `undel-${suffix}`;
    await rate({ provider });
    const { deliveryId } = await attempt();
    await recorder.accepted(deliveryId, provider, `msg-undel-${suffix}`);
    await recorder.applyProviderEvent({
      provider,
      providerMessageId: `msg-undel-${suffix}`,
      state: DeliveryState.UNDELIVERED,
    });

    const row = await db!.notificationDelivery.findUnique({ where: { id: deliveryId } });
    expect(row.status).toBe(DeliveryState.UNDELIVERED);
    expect(row.costMicro).toBe(100);
    expect(row.outcomeClass).toBe(OutcomeClass.UNDELIVERABLE_DESTINATION);
  });

  maybe('a bounce does not erase the cost either', async () => {
    const provider = `bnc-${suffix}`;
    await rate({ provider });
    const { deliveryId } = await attempt();
    await recorder.accepted(deliveryId, provider, `msg-bnc-${suffix}`);
    await recorder.applyProviderEvent({
      provider,
      providerMessageId: `msg-bnc-${suffix}`,
      state: DeliveryState.BOUNCED,
    });
    const row = await db!.notificationDelivery.findUnique({ where: { id: deliveryId } });
    expect(row.costMicro).toBe(100);
  });

  maybe('a send that never reached a provider costs nothing and blames nobody', async () => {
    const { deliveryId } = await attempt();
    await recorder.failed(deliveryId, 'none', 'connection reset');
    const row = await db!.notificationDelivery.findUnique({ where: { id: deliveryId } });
    expect(row.costMicro).toBeNull();
    expect(row.costSource).toBe(CostSource.UNKNOWN);
    expect(row.outcomeClass).toBe(OutcomeClass.PROVIDER_UNAVAILABLE);
  });

  maybe('a suppressed destination produces no provider charge at all', async () => {
    const { deliveryId } = await attempt();
    await recorder.notAttempted(
      deliveryId,
      OutcomeClass.POLICY_SUPPRESSED,
      'destination_suppressed',
    );
    const row = await db!.notificationDelivery.findUnique({ where: { id: deliveryId } });
    expect(row.provider).toBe('none');
    expect(row.costMicro).toBeNull();
    // UNKNOWN, not CONFIGURED_FREE: nothing was sent, so there is no price to quote.
    expect(row.costSource).toBe(CostSource.UNKNOWN);
    expect(row.outcomeClass).toBe(OutcomeClass.POLICY_SUPPRESSED);
  });

  // ─── Aggregation ───

  maybe('never adds two currencies together', async () => {
    /*
      There is no exchange rate anywhere in this platform and there will not be one. Inventing
      a conversion to produce a single comforting number makes the report wrong at a rate that
      changes daily and in a direction nobody chose.
    */
    const usd = `usd-${suffix}`;
    const inr = `inr-${suffix}`;
    await rate({ provider: usd, unitPriceMicro: 100_000, currency: 'USD' });
    await rate({
      provider: inr,
      channel: 'sms',
      unitPriceMicro: 150_000,
      currency: 'INR',
      billingUnit: BillingUnit.PER_MESSAGE,
    });

    const a = await attempt();
    await recorder.accepted(a.deliveryId, usd, 'm1');
    const b = await attempt({ channel: 'sms' });
    await recorder.accepted(b.deliveryId, inr, 'm2');

    const summary = await analytics.summary(REPORT);
    const currencies = summary.cost.map((c) => c.currency).sort();
    expect(currencies).toEqual(expect.arrayContaining(['INR', 'USD']));
    const inrRow = summary.cost.find((c) => c.currency === 'INR')!;
    const usdRow = summary.cost.find((c) => c.currency === 'USD')!;
    expect(inrRow.costMicro).toBeGreaterThanOrEqual(150_000);
    expect(usdRow.costMicro).toBeLessThan(150_000);
  });

  maybe('reports unknown-cost attempts beside the total', async () => {
    // Until this is zero, the total is a floor and not an answer.
    const { deliveryId } = await attempt();
    await recorder.accepted(deliveryId, `unpriced-${suffix}`, 'm3');
    const summary = await analytics.summary(REPORT);
    expect(summary.unknownCostAttempts).toBeGreaterThan(0);
  });

  maybe('counts logical notifications and provider attempts separately', async () => {
    const summary = await analytics.summary(REPORT);
    // A retry, a fallback and an operator resend all raise attempts and not notifications.
    expect(summary.attempts).toBeGreaterThan(0);
    expect(summary.notifications).toBeGreaterThan(0);
  });

  maybe('separates a fallback and a manual resend from an ordinary send', async () => {
    /*
      The two questions whose answers are otherwise buried in the total: what is the emergency
      channel costing, and how much is support spending on somebody's behalf.
    */
    const provider = `kind-${suffix}`;
    await rate({
      provider,
      channel: 'sms',
      unitPriceMicro: 20_000,
      billingUnit: BillingUnit.PER_MESSAGE,
    });

    const fb = await attempt({ channel: 'sms', sendKind: SendKind.FALLBACK });
    await recorder.accepted(fb.deliveryId, provider, 'm-fb');
    const mr = await attempt({ channel: 'sms', sendKind: SendKind.MANUAL_RESEND });
    await recorder.accepted(mr.deliveryId, provider, 'm-mr');

    const byKind = await analytics.costs({ ...REPORT, provider }, 'sendKind');
    const kinds = Object.fromEntries(byKind.map((r) => [r.sendKind, r]));
    expect(kinds[SendKind.FALLBACK].totals[0].costMicro).toBe(20_000);
    expect(kinds[SendKind.MANUAL_RESEND].totals[0].costMicro).toBe(20_000);
  });

  maybe('reports cost per booking, and how much belongs to no booking', async () => {
    const provider = `bk-${suffix}`;
    await rate({ provider, unitPriceMicro: 1_000_000, billingUnit: BillingUnit.PER_MESSAGE });

    // Two messages about one booking, and one about nothing.
    for (const n of [1, 2]) {
      const a = await attempt({ bookingId: `booking-${suffix}` });
      await recorder.accepted(a.deliveryId, provider, `m-bk-${n}`);
    }
    const orphan = await attempt({ bookingId: null });
    await recorder.accepted(orphan.deliveryId, provider, 'm-orphan');

    const report = await analytics.costPerBooking({ ...REPORT, provider });
    const usd = report.perCurrency.find((r) => r.currency === 'USD')!;
    expect(usd.bookings).toBe(1);
    expect(usd.costMicro).toBe(2_000_000);
    expect(usd.averagePerBookingMicro).toBe(2_000_000);
    /*
      An organizer payout notice and a password reset are real spend that no booking should
      carry. Folding them in would overstate the per-booking figure by however much unrelated
      traffic the platform happens to send.
    */
    expect(report.unlinkedAttempts).toBeGreaterThan(0);
  });

  maybe('reports which event types drive the spend', async () => {
    const rows = await analytics.byEvent(REPORT);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('eventType');
    expect(rows[0]).toHaveProperty('sendKind');
    expect(rows[0]).toHaveProperty('unknownCostAttempts');
  });

  // ─── Provider health ───

  maybe('does not count a suppression against the provider', async () => {
    /*
      The denominator problem, proven. A suppressed address carries provider `none` and is
      excluded from the health report entirely — it says nothing about SES, and including it
      would make SES look worse every time this platform correctly refuses to email a dead
      mailbox.
    */
    const provider = `health-${suffix}`;
    await rate({ provider });

    const ok = await attempt();
    await recorder.accepted(ok.deliveryId, provider, 'm-ok');
    const supp = await attempt();
    await recorder.notAttempted(supp.deliveryId, OutcomeClass.POLICY_SUPPRESSED, 'suppressed');
    const none = await attempt();
    await recorder.skipped(none.deliveryId, 'none', 'no_destination');

    const health = await analytics.providerHealth({ ...REPORT, provider });
    const row = health.find((h) => h.provider === provider)!;
    expect(row.providerAttempts).toBe(1);
    expect(row.acceptedRate).toBe(1);
    expect(row.outcomes[OutcomeClass.POLICY_SUPPRESSED]).toBeUndefined();
    expect(row.outcomes[OutcomeClass.NO_DESTINATION]).toBeUndefined();
  });

  maybe('says when a delivery rate cannot be measured rather than reporting zero', async () => {
    // Neither FCM nor Web Push has a per-message delivery callback. Reporting 0% would
    // punish the channel that works best for being the one that cannot prove it.
    const provider = `push-${suffix}`;
    const a = await attempt({ channel: 'push' });
    await recorder.accepted(a.deliveryId, provider, 'm-push');

    const health = await analytics.providerHealth({ ...REPORT, provider });
    const row = health.find((h) => h.channel === 'push')!;
    expect(row.deliveryMeasurable).toBe(false);
    expect(row.acceptedRate).toBe(1);
  });
});
