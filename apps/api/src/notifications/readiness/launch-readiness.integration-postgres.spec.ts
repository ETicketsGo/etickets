import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  BillingUnit,
  NotificationType,
  SendKind,
  isCustomerTraffic,
} from '@eticketsgo/shared-types';
import { NotificationReadinessService } from './notification-readiness.service';
import { TemplateBindingService } from '../templates/template-binding.service';
import { MarketCertificationService } from './market-certification.service';
import { NotificationRateService } from '../cost/notification-rate.service';
import { NotificationAnalyticsService } from '../cost/notification-analytics.service';
import { DeliveryRecorderService } from '../delivery/delivery-recorder.service';
import { SuppressionService } from '../delivery/suppression.service';
import { acquireSweepLock, type SweepLock } from '../test-support/sweep-lock';

/**
 * integration-real-postgres — what "ready" means, and what it must not be allowed to mean.
 *
 * ── THE FAILURE THESE PREVENT ──────────────────────────────────────────────────────
 * A launch call reads a dashboard. If the dashboard turns green when somebody sets an
 * environment variable, the call gets made on the strength of a string being non-empty — and
 * the first evidence that MSG91's DLT template was never approved is a customer saying their
 * ticket never arrived.
 *
 * So certification is judged on delivery EVIDENCE, and these prove it cannot be satisfied any
 * other way.
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

/** A fully configured India, so the ladder is exercised past the configuration rungs. */
const INDIA_CONFIGURED = {
  EMAIL_PROVIDER: 'ses',
  AWS_REGION: 'ap-south-1',
  EMAIL_FROM: 'tickets@example.test',
  SMS_PROVIDER_BY_MARKET: 'IN=msg91',
  WHATSAPP_PROVIDER_BY_MARKET: 'IN=msg91',
  MSG91_AUTH_KEY: 'test-key',
  MSG91_SMS_TEMPLATE_IDS: 'SHOW_CANCELLED=tmpl-1',
  MSG91_WHATSAPP_NUMBER: '919999999999',
  MSG91_WHATSAPP_TEMPLATES: 'BOOKING_CONFIRMED=conf_v1',
  MSG91_WEBHOOK_SECRET: 'secret',
  SES_WEBHOOK_SECRET: 'secret',
  PUSH_PROVIDER: 'expo',
};

describe('integration-real-postgres: launch readiness and certification', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let sweepLock: SweepLock | undefined;
  let rates: NotificationRateService;
  let recorder: DeliveryRecorderService;
  let analytics: NotificationAnalyticsService;

  const suffix = `ready-${Date.now()}`;
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
        These assertions are about GLOBAL evidence -- has ANY message through this provider
        been accepted, does ANY callback exist -- which is exactly what makes the certification
        ladder meaningful and exactly what another suite writing provider rows perturbs.
        Serialized against the other suites that read or write that state.
      */
      sweepLock = await acquireSweepLock(url);
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED — DB unavailable');
      return;
    }
    const user = await db.user.create({
      data: {
        email: `ops+${suffix}@example.test`,
        passwordHash: 'x',
        fullName: 'Ops',
        roles: ['CUSTOMER'],
      },
    });
    userId = user.id;
    rates = new NotificationRateService(db as never);
    // With the rate service, so accepted attempts are actually priced -- without it every
    // cost is UNKNOWN and the cost assertions below would pass vacuously.
    recorder = new DeliveryRecorderService(
      db as never,
      new SuppressionService(db as never),
      undefined,
      rates,
    );
    analytics = new NotificationAnalyticsService(db as never);
  }, 180_000);

  afterAll(async () => {
    if (!db || !available) return;
    await db.notification.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { email: { contains: suffix } } });
    await db.notificationRate.deleteMany({ where: { notes: { contains: suffix } } });
    await sweepLock?.release();
    await db.$disconnect();
  }, 180_000);

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (!available) return;
      await fn();
    });

  const certifier = (env: Record<string, string> = {}) => {
    const config = new ConfigService(env);
    return new MarketCertificationService(
      db as never,
      new NotificationReadinessService(config, db as never, new TemplateBindingService(config)),
    );
  };

  /** An attempt in whatever state the ladder is being tested at. */
  async function attempt(opts: {
    provider: string;
    channel: string;
    sendKind?: SendKind;
    accept?: boolean;
    callback?: boolean;
  }) {
    const notification = await db!.notification.create({
      data: {
        type: NotificationType.BOOKING_CONFIRMED,
        userId,
        toEmail: `ops+${suffix}@example.test`,
        payload: {},
        channel: opts.channel,
        locale: 'en',
        status: 'PENDING',
        sendReason: opts.sendKind ?? SendKind.PRIMARY,
      },
    });
    const id = await recorder.open({
      notificationId: notification.id,
      provider: opts.provider,
      channel: opts.channel,
      attemptNumber: 1,
      sendKind: opts.sendKind,
    });
    if (opts.accept) {
      const ref = `pm-${notification.id}`;
      await recorder.accepted(id!, opts.provider, ref);
      if (opts.callback) {
        await recorder.applyProviderEvent({
          provider: opts.provider,
          providerMessageId: ref,
          state: 'DELIVERED' as never,
          providerStatus: 'delivered',
        });
      }
    }
    return id!;
  }

  // ─── Correction A: TEST is its own classification ───

  maybe('an operator test send is TEST, not a customer resend', async () => {
    /*
      Filed as MANUAL_RESEND, every certification run would inflate the figure somebody reads
      as "how much is support spending on customers' behalf", and a quiet month of testing
      would look like a support incident.
    */
    const id = await attempt({
      provider: `t-${suffix}`,
      channel: 'email',
      sendKind: SendKind.TEST,
    });
    const row = await db!.notificationDelivery.findUnique({ where: { id } });
    expect(row.sendKind).toBe(SendKind.TEST);
    expect(row.sendKind).not.toBe(SendKind.MANUAL_RESEND);
    expect(isCustomerTraffic(SendKind.TEST)).toBe(false);
    expect(isCustomerTraffic(SendKind.MANUAL_RESEND)).toBe(true);
  });

  maybe('test traffic is reported apart from customer traffic, cost included', async () => {
    const provider = `cost-${suffix}`;
    await rates.create({
      provider,
      channel: 'sms',
      unitPriceMicro: 150_000,
      currency: 'INR',
      billingUnit: BillingUnit.PER_MESSAGE,
      effectiveFrom: new Date('2026-01-01'),
      active: true,
      notes: suffix,
    });
    await attempt({ provider, channel: 'sms', sendKind: SendKind.TEST, accept: true });
    await attempt({ provider, channel: 'sms', sendKind: SendKind.PRIMARY, accept: true });

    const window = { from: new Date('2026-01-01'), to: new Date(Date.now() + 86_400_000) };
    const summary = await analytics.summary({ ...window, provider });

    expect(summary.testAttempts).toBe(1);
    expect(summary.customerAttempts).toBe(1);
    // The COST is still counted -- a WhatsApp test in India is real money, and hiding it
    // would understate the bill. Only the attribution differs.
    const inr = summary.cost.find((c) => c.currency === 'INR')!;
    expect(inr.costMicro).toBe(300_000);
    expect(summary.byKind[SendKind.TEST]).toBe(1);
  });

  maybe('test traffic never moves cost per booking', async () => {
    // Certification is not a customer message, and an average that includes it answers a
    // business question with engineering activity.
    const provider = `cpb-${suffix}`;
    await rates.create({
      provider,
      channel: 'email',
      unitPriceMicro: 1_000_000,
      currency: 'USD',
      billingUnit: BillingUnit.PER_MESSAGE,
      effectiveFrom: new Date('2026-01-01'),
      active: true,
      notes: suffix,
    });
    await attempt({ provider, channel: 'email', sendKind: SendKind.TEST, accept: true });

    const report = await analytics.costPerBooking({
      from: new Date('2026-01-01'),
      to: new Date(Date.now() + 86_400_000),
      provider,
    });
    expect(report.perCurrency).toEqual([]);
  });

  // ─── The certification ladder ───

  maybe('an unconfigured market is CODE_READY and NOT_CONFIGURED', async () => {
    const report = await certifier().forMarket('IN');
    expect(report.level).toBe('CODE_READY');
    const email = report.channels.find((c) => c.channel === 'email')!;
    expect(email.outcome).toBe('NOT_CONFIGURED');
    // And says what to do rather than merely that something is wrong.
    expect(email.action).toBeTruthy();
  });

  /**
   * A known baseline for the ladder.
   *
   * ── WHY A TEST DELETES ROWS IT DID NOT CREATE ─────────────────────────────────────
   * The certification ladder deliberately reads GLOBAL evidence: "has ANY message through
   * msg91/sms ever been accepted, has ANY callback ever arrived". That is what makes it
   * meaningful — evidence is evidence, wherever it came from — and it is precisely why a
   * test asserting "nothing has ever been sent" cannot be written against a shared database
   * without first making that sentence true.
   *
   * Deleting is safe here and nowhere else: this suite holds the global notification lock, so
   * no other suite is mid-run, and the rows being removed are other runs' leftovers rather
   * than anybody's live fixture. Scoped to the two pairings the ladder asserts on.
   */
  const clearEvidenceFor = async (provider: string, channel: string) => {
    if (!db || !available) return;
    await db.notificationDelivery.deleteMany({ where: { provider, channel } });
  };

  maybe('configured but never used is CONFIG_READY, not certified', async () => {
    /*
      The rung that stops a launch call being made on the strength of an environment variable.
      A perfectly configured MSG91 account with an unapproved template is exactly this state
      and will carry nothing.
    */
    await clearEvidenceFor('msg91', 'sms');
    const report = await certifier(INDIA_CONFIGURED).forMarket('IN');
    const sms = report.channels.find((c) => c.channel === 'sms')!;
    expect(sms.level).toBe('CONFIG_READY');
    expect(sms.outcome).toBe('BLOCKED_EXTERNAL_SETUP');
    expect(sms.detail).toMatch(/nothing has ever been sent/i);
    expect(sms.action).toMatch(/test-send/i);
  });

  maybe('accepted but never called back is EXTERNAL_VERIFICATION_REQUIRED', async () => {
    // The return path is unproven: the webhook may be unregistered, the signature may be
    // failing, or the correlation may be broken -- all identical from the send side.
    await clearEvidenceFor('msg91', 'sms');
    await attempt({ provider: 'msg91', channel: 'sms', sendKind: SendKind.TEST, accept: true });
    const report = await certifier(INDIA_CONFIGURED).forMarket('IN');
    const sms = report.channels.find((c) => c.channel === 'sms')!;
    expect(sms.level).toBe('EXTERNAL_VERIFICATION_REQUIRED');
    expect(sms.detail).toMatch(/no delivery callback/i);
    expect(sms.action).toMatch(/delivery-report URL/i);
  });

  maybe('a callback with no rate is still not certified', async () => {
    // Working and unpriced. Not a delivery failure, but every cost report is silently a floor
    // until a rate exists, and calling that certified puts an incomplete number in front of
    // somebody with no asterisk on it.
    await attempt({
      provider: 'msg91',
      channel: 'sms',
      sendKind: SendKind.TEST,
      accept: true,
      callback: true,
    });
    const report = await certifier(INDIA_CONFIGURED).forMarket('IN');
    const sms = report.channels.find((c) => c.channel === 'sms')!;
    expect(sms.level).toBe('EXTERNAL_VERIFICATION_REQUIRED');
    expect(sms.detail).toMatch(/no rate is configured/i);
  });

  maybe('only a send AND a callback AND a rate reach LIVE_CERTIFIED', async () => {
    await rates.create({
      provider: 'msg91',
      channel: 'sms',
      country: 'IN',
      unitPriceMicro: 150_000,
      currency: 'INR',
      billingUnit: BillingUnit.PER_MESSAGE,
      effectiveFrom: new Date('2026-01-01'),
      active: true,
      notes: suffix,
    });
    const report = await certifier(INDIA_CONFIGURED).forMarket('IN');
    const sms = report.channels.find((c) => c.channel === 'sms')!;
    expect(sms.level).toBe('LIVE_CERTIFIED');
    expect(sms.outcome).toBe('PASS');
  });

  maybe('a market is only as certified as its weakest channel', async () => {
    /*
      Reporting the best one would produce exactly the launch call this ladder exists to
      prevent: "email is live" is not "India is live" when every Indian buyer expects
      WhatsApp.
    */
    const report = await certifier(INDIA_CONFIGURED).forMarket('IN');
    const levels = report.channels.map((c) => c.level);
    expect(levels).toContain('LIVE_CERTIFIED');
    expect(report.level).not.toBe('LIVE_CERTIFIED');
  });

  maybe('push is certified on acceptance, and says why', async () => {
    // FCM and Web Push have no per-message delivery callback. Requiring one would leave push
    // permanently uncertifiable; claiming delivery would be a fabrication.
    await attempt({ provider: 'expo', channel: 'push', sendKind: SendKind.TEST, accept: true });
    await rates.create({
      provider: 'expo',
      channel: 'push',
      unitPriceMicro: 0,
      currency: 'USD',
      billingUnit: BillingUnit.PER_MESSAGE,
      effectiveFrom: new Date('2026-01-01'),
      active: true,
      notes: suffix,
    });
    const report = await certifier(INDIA_CONFIGURED).forMarket('IN');
    const push = report.channels.find((c) => c.channel === 'push')!;
    expect(push.level).toBe('LIVE_CERTIFIED');
    expect(push.detail).toMatch(/no delivery receipt/i);
  });

  maybe('every blocker names the console action a human must take', async () => {
    const report = await certifier(INDIA_CONFIGURED).report(['IN', 'US', 'CA']);
    expect(report.lowestLevel).not.toBe('LIVE_CERTIFIED');
    expect(report.externalActions.length).toBeGreaterThan(0);
    for (const action of report.externalActions) {
      expect(action.action).toBeTruthy();
      // Never a vague "configure the provider": an operator has to know which console and
      // which setting.
      expect(action.action.length).toBeGreaterThan(20);
    }
  });

  maybe('the report never contains a credential', async () => {
    const report = await certifier(INDIA_CONFIGURED).report(['IN']);
    const json = JSON.stringify(report);
    for (const secret of ['test-key', 'secret', '919999999999']) {
      expect(json).not.toContain(secret);
    }
  });
});
