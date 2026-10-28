import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type FeatureFlag } from '@eticketsgo/shared-types';
import { AuditService } from '../audit/audit.service';
import { EntitlementService } from './entitlements/entitlement.service';
import { BillingCatalogService } from './billing-catalog.service';
import { BillingInvoiceService } from './billing-invoice.service';
import { BillingReadService } from './billing-read.service';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingTaxService } from './billing-tax.service';
import { CreditPackPricesService } from './credit-pack-prices.service';
import { SubscriptionService } from './subscription.service';
import { assignInvoiceNumber } from './invoice-number';
import { MockBillingProvider } from './provider/billing-provider';
import { BillingProviderRegistry } from './provider/billing-provider.registry';
import { holdBillingSpecLock } from './billing-spec-lock.fixture';
import { TransactionalEventPublisher, type DomainEvent } from '../common/domain-events';
import { ManualTaxProvider } from '../tax/providers/manual-tax.provider';
import { SuppressionService } from '../notifications/delivery/suppression.service';
import { MarketingConsentService } from '../notifications/marketing-consent.service';
import { CommunicationConsentService } from '../engagement/communication-consent.service';
import { UnsubscribeService } from '../engagement/unsubscribe.service';
import { signUnsubscribeToken, unsubscribeKey } from '../engagement/unsubscribe-token';

/**
 * integration-real-postgres: the owner's product decisions of 2026-10-27, against the migrated
 * schema. The pure halves are in growth-owner-decisions.spec.ts.
 *
 * Every tax rate here is the suite's own value, written into a TaxRule row it creates and
 * removes: the code holds no rate. Skips (never fabricates a pass) without a database.
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

const RATE_BPS = 1800; // the suite's own GST rate for its own rule
const US_STATE_BPS = 625; // the suite's own state rate for its own rule

describe('integration-real-postgres: owner decisions 2026-10-27', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let releaseLock: (() => Promise<void>) | undefined;
  const tag = `god${Date.now()}`;
  const userIds: string[] = [];
  const orgIds: string[] = [];
  const ruleIds: string[] = [];
  const packPriceIds: string[] = [];
  const scopes: string[] = [];
  let createdPlanCodes: string[] = [];
  let staffId = '';

  const env: Record<string, string | undefined> = {
    APP_ENV: 'LOCAL',
    BILLING_ENABLED: 'true',
    PLATFORM_TAX_REGION: 'Karnataka',
    ORGANIZER_WEB_URL: 'https://organizer.test',
    CUSTOMER_WEB_URL: 'https://shop.test',
    JWT_ACCESS_SECRET: 'j'.repeat(40),
  };
  const config = { get: (k: string) => env[k] } as never;

  let audit: AuditService;
  let catalog: BillingCatalogService;
  let packs: CreditPackPricesService;
  let tax: BillingTaxService;
  let reads: BillingReadService;
  let checkouts: BillingCheckoutService;

  const ALL_ON = (_f: FeatureFlag) => true;

  async function makeUser(name: string) {
    const u = await db!.user.create({
      data: {
        email: `${name}-${tag}@test.invalid`,
        fullName: name,
        passwordHash: 'x',
        roles: ['ORGANIZER_OWNER'],
      },
    });
    userIds.push(u.id);
    return u;
  }

  async function makeOrg(name: string, country: string, region: string | null) {
    const o = await db!.organization.create({
      data: {
        name: `${name} ${tag}`,
        slug: `${name}-${tag}`,
        status: 'APPROVED',
        registeredCountry: country,
        registeredRegion: region,
      },
    });
    orgIds.push(o.id);
    return o.id;
  }

  async function rule(data: Record<string, unknown>) {
    const r = await db!.taxRule.create({
      data: { label: `GST ${tag}`, appliesTo: 'PLATFORM_SERVICES', active: true, ...data } as never,
    });
    ruleIds.push(r.id);
    return r;
  }

  beforeAll(async () => {
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - no DATABASE_URL');
      return;
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    try {
      await db!.$queryRaw`SELECT 1`;
      available = true;
      releaseLock = await holdBillingSpecLock(url);
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }
    audit = new AuditService(db as never);
    const publisher = new TransactionalEventPublisher(
      db as never,
      { publishMany: async (_e: DomainEvent[]) => undefined } as never,
      { get: () => 'in_process' } as never,
      {} as never,
    );
    const entitlements = new EntitlementService(db as never, ALL_ON);
    const subscriptions = new SubscriptionService(db as never, audit, publisher, entitlements);
    const registry = BillingProviderRegistry.fixed(new MockBillingProvider());
    catalog = new BillingCatalogService(db as never, audit);
    packs = new CreditPackPricesService(db as never, audit);
    tax = new BillingTaxService(db as never, config);
    reads = new BillingReadService(
      db as never,
      entitlements,
      new BillingInvoiceService(db as never),
      config,
      registry,
    );
    checkouts = new BillingCheckoutService(
      db as never,
      config,
      registry,
      subscriptions,
      tax,
      packs,
    );
    staffId = (await makeUser('staff')).id;

    // No other PLATFORM_SERVICES rule may decide these answers: park any that are active.
    const others = await db!.taxRule.findMany({
      where: { appliesTo: 'PLATFORM_SERVICES', active: true },
      select: { id: true },
    });
    parked = others.map((r: { id: string }) => r.id);
    if (parked.length) {
      await db!.taxRule.updateMany({ where: { id: { in: parked } }, data: { active: false } });
    }

    const had = new Set(
      (await db!.billingPlan.findMany({ select: { code: true } })).map(
        (p: { code: string }) => p.code,
      ),
    );
    await catalog.loadProvisional(staffId);
    createdPlanCodes = ['FREE', 'PRO', 'PREMIUM'].filter((c) => !had.has(c));
  }, 120_000);
  let parked: string[] = [];

  afterAll(async () => {
    if (db && available) {
      await db.creditPackPurchase.deleteMany({ where: { organizationId: { in: orgIds } } });
      if (packPriceIds.length) {
        await db.creditPackPrice.deleteMany({ where: { id: { in: packPriceIds } } });
      }
      await db.taxRule.deleteMany({ where: { id: { in: ruleIds } } });
      if (parked.length) {
        await db.taxRule.updateMany({ where: { id: { in: parked } }, data: { active: true } });
      }
      await db.readableReferenceCounter.deleteMany({ where: { scope: { in: scopes } } });
      await db.suppressedDestination.deleteMany({
        where: { destinationMask: { contains: '@test.invalid' } },
      });
      await db.organizerSuppression.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.communicationConsent.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.marketingConsent.deleteMany({ where: { userId: { in: userIds } } });
      await db.organizerBillingAccount.deleteMany({ where: { organizationId: { in: orgIds } } });
      if (createdPlanCodes.length) {
        const plans = await db.billingPlan.findMany({ where: { code: { in: createdPlanCodes } } });
        const ids = plans.map((p: { id: string }) => p.id);
        await db.planEntitlement.deleteMany({ where: { planId: { in: ids } } });
        await db.billingPrice.deleteMany({ where: { planId: { in: ids } } });
        await db.billingPlan.deleteMany({ where: { id: { in: ids } } });
      }
      await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
      await db.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await db?.$disconnect();
    await releaseLock?.();
  }, 120_000);

  const maybe = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
    it(
      name,
      async () => {
        if (!available) return;
        await fn();
      },
      timeout,
    );

  // ── Decision 5: prices, and 10x a year ──────────────────────────────────────────

  maybe('the loader writes the owner prices, a year at 10x, and keeps a staff edit', async () => {
    const price = (code: string, country: string, interval: 'MONTH' | 'YEAR') =>
      db!.billingPrice.findFirst({
        where: { plan: { code }, country, interval, active: true },
      });
    if (createdPlanCodes.length === 3) {
      const expected: [string, string, 'MONTH' | 'YEAR', number][] = [
        ['FREE', 'IN', 'MONTH', 0],
        ['FREE', 'US', 'YEAR', 0],
        ['PRO', 'IN', 'MONTH', 99900],
        ['PRO', 'IN', 'YEAR', 999000],
        ['PREMIUM', 'IN', 'MONTH', 299900],
        ['PREMIUM', 'IN', 'YEAR', 2999000],
        ['PRO', 'US', 'MONTH', 1900],
        ['PRO', 'US', 'YEAR', 19000],
        ['PREMIUM', 'US', 'MONTH', 4900],
        ['PREMIUM', 'US', 'YEAR', 49000],
      ];
      for (const [code, country, interval, amount] of expected) {
        expect((await price(code, country, interval))?.amountMinor).toBe(amount);
      }
    }
    // A staff edit survives a second load: nothing is overwritten.
    const pro = (await price('PRO', 'IN', 'MONTH'))!;
    const original = pro.amountMinor;
    await catalog.updatePrice(pro.id, { amountMinor: 123400 }, staffId);
    const again = await catalog.loadProvisional(staffId);
    expect(again.pricesCreated).toBe(0);
    expect((await price('PRO', 'IN', 'MONTH'))!.amountMinor).toBe(123400);
    await catalog.updatePrice(pro.id, { amountMinor: original }, staffId);
  });

  // ── Decision 6: credit packs unpublished by default ─────────────────────────────

  maybe(
    'a credit pack is not on sale until priced AND published; publication is audited',
    async () => {
      const org = await makeOrg('packs', 'India', 'Karnataka');
      const existing = await db!.creditPackPrice.findUnique({
        where: { packCode_country: { packCode: 'EMAIL_10K', country: 'IN' } },
      });
      if (existing) {
        // Somebody else's row: leave it alone, the rest of the test needs a clean one.
        return;
      }
      // Nothing set: not shown, and a checkout is refused.
      expect((await reads.organizerBilling(org)).creditPacks).toEqual([]);
      await expect(checkouts.startCreditPackCheckout(org, 'EMAIL_10K')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      // Priced but unpublished: still not on sale.
      const row = await packs.setPrice(
        'EMAIL_10K',
        'IN',
        { currency: 'INR', amountMinor: 250_000 },
        staffId,
      );
      packPriceIds.push(row.id);
      expect(row.published).toBe(false);
      expect((await reads.organizerBilling(org)).creditPacks).toEqual([]);
      await expect(checkouts.startCreditPackCheckout(org, 'EMAIL_10K')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      // A stale page cannot publish over a newer price.
      await expect(
        packs.setPublished('EMAIL_10K', 'IN', true, staffId, row.version - 1),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      // The wrong currency for the country is refused.
      await expect(
        packs.setPrice('EMAIL_10K', 'IN', { currency: 'USD', amountMinor: 1 }, staffId),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      const live = await packs.setPublished('EMAIL_10K', 'IN', true, staffId, row.version);
      expect(live.published).toBe(true);
      expect((await reads.organizerBilling(org)).creditPacks).toEqual([
        {
          code: 'EMAIL_10K',
          name: '10,000 campaign email credits',
          credits: 10_000,
          currency: 'INR',
          amountMinor: 250_000,
        },
      ]);
      // On sale now, but with no tax rule for India the checkout is still refused: fail closed.
      await expect(checkouts.startCreditPackCheckout(org, 'EMAIL_10K')).rejects.toMatchObject({
        code: 'BILLING_TAX_NOT_CONFIGURED',
      });
      expect(await db!.creditPackPurchase.count({ where: { organizationId: org } })).toBe(0);

      const actions = (
        await db!.auditLog.findMany({
          where: { entityType: 'CreditPackPrice', entityId: row.id },
          orderBy: { createdAt: 'asc' },
        })
      ).map((a: { action: string }) => a.action);
      expect(actions).toEqual(['BILLING_CREDIT_PACK_PRICE_SET', 'BILLING_CREDIT_PACK_PUBLISHED']);

      await packs.setPublished('EMAIL_10K', 'IN', false, staffId);
      expect((await reads.organizerBilling(org)).creditPacks).toEqual([]);
    },
  );

  // ── Decision 7: tax by jurisdiction, from configured rules only ─────────────────

  maybe('India: no rule means no checkout, never a silent zero', async () => {
    const org = await makeOrg('notax', 'India', 'Karnataka');
    await expect(
      tax.quote({ organizationId: org, country: 'IN', currency: 'INR', amountMinor: 99900 }),
    ).rejects.toMatchObject({ code: 'BILLING_TAX_NOT_CONFIGURED' });
    const pro = await db!.billingPrice.findFirstOrThrow({
      where: { plan: { code: 'PRO' }, country: 'IN', interval: 'MONTH', active: true },
    });
    await expect(checkouts.startPlanCheckout(org, pro.id)).rejects.toMatchObject({
      code: 'BILLING_TAX_NOT_CONFIGURED',
    });
  });

  maybe(
    'India GST: CGST + SGST inside the platform state, IGST across states, same amount',
    async () => {
      await rule({ rateBasisPoints: RATE_BPS, country: 'IN', currency: 'INR', split: 'CGST_SGST' });
      const intra = await makeOrg('intra', 'India', 'Karnataka');
      const inter = await makeOrg('inter', 'India', 'Telangana');
      const stateless = await makeOrg('stateless', 'India', null);
      const levy = Math.round((99900 * RATE_BPS) / 10_000);

      const a = await tax.quote({
        organizationId: intra,
        country: 'IN',
        currency: 'INR',
        amountMinor: 99900,
      });
      expect(a.mode).toBe('MANUAL');
      expect(a.lines.map((l) => l.label)).toEqual(['CGST', 'SGST']);
      expect(a.lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(levy);
      expect(a).toMatchObject({ netMinor: 99900, taxMinor: levy, totalMinor: 99900 + levy });
      expect(a.jurisdiction).toMatchObject({ region: 'Karnataka', interState: false });

      const b = await tax.quote({
        organizationId: inter,
        country: 'IN',
        currency: 'INR',
        amountMinor: 99900,
      });
      expect(b.lines).toEqual([
        { label: 'IGST', rateBasisPoints: RATE_BPS, baseMinor: 99900, amountMinor: levy },
      ]);
      expect(b.totalMinor).toBe(a.totalMinor);
      expect(b.jurisdiction.interState).toBe(true);

      // GST depends on the organizer's state: unknown is refused, not guessed.
      await expect(
        tax.quote({ organizationId: stateless, country: 'IN', currency: 'INR', amountMinor: 1 }),
      ).rejects.toMatchObject({ code: 'BILLING_TAX_NOT_CONFIGURED' });

      // A plan checkout now passes the tax gate (the mock provider then takes it).
      const pro = await db!.billingPrice.findFirstOrThrow({
        where: { plan: { code: 'PRO' }, country: 'IN', interval: 'MONTH', active: true },
      });
      await expect(checkouts.startPlanCheckout(inter, pro.id)).resolves.toMatchObject({
        provider: 'MOCK',
      });
    },
  );

  maybe('the ticket tax path never rates a PLATFORM_SERVICES rule', async () => {
    // The India GST rule above is active. A ticket order and its fee pay none of it.
    const quote = await new ManualTaxProvider(db as never).quote({
      context: { currency: 'INR', country: 'IN', region: 'Karnataka' },
      netSubtotalMinor: 50_000,
      customerFeeMinor: 1_500,
      lines: [],
    });
    expect(quote.taxLines.filter((l) => l.basis === 'PLATFORM_SERVICES')).toEqual([]);
    expect(quote.taxLines.some((l) => l.label === `GST ${tag}`)).toBe(false);
  });

  maybe('USA: a state rule rates that state only; Stripe Tax when switched on', async () => {
    await rule({
      label: `TX ${tag}`,
      rateBasisPoints: US_STATE_BPS,
      country: 'US',
      region: 'TX',
      currency: 'USD',
    });
    const texas = await makeOrg('texas', 'United States', 'TX');
    const oregon = await makeOrg('oregon', 'United States', 'OR');
    const t = await tax.quote({
      organizationId: texas,
      country: 'US',
      currency: 'USD',
      amountMinor: 1900,
    });
    const stateTax = Math.round((1900 * US_STATE_BPS) / 10_000);
    expect(t).toMatchObject({ mode: 'MANUAL', taxMinor: stateTax, totalMinor: 1900 + stateTax });
    await expect(
      tax.quote({ organizationId: oregon, country: 'US', currency: 'USD', amountMinor: 1900 }),
    ).rejects.toMatchObject({ code: 'BILLING_TAX_NOT_CONFIGURED' });

    // A deliberate 0% rule is an answer, printed as a 0% line.
    await rule({
      label: `OR ${tag}`,
      rateBasisPoints: 0,
      country: 'US',
      region: 'OR',
      currency: 'USD',
    });
    const o = await tax.quote({
      organizationId: oregon,
      country: 'US',
      currency: 'USD',
      amountMinor: 1900,
    });
    expect(o).toMatchObject({ taxMinor: 0, totalMinor: 1900 });
    expect(o.lines).toEqual([
      { label: `OR ${tag}`, rateBasisPoints: 0, baseMinor: 1900, amountMinor: 0 },
    ]);

    env.STRIPE_BILLING_AUTOMATIC_TAX = 'true';
    try {
      const auto = await tax.quote({
        organizationId: oregon,
        country: 'US',
        currency: 'USD',
        amountMinor: 1900,
      });
      expect(auto).toMatchObject({ mode: 'PROVIDER_AUTOMATIC', lines: [] });
    } finally {
      delete env.STRIPE_BILLING_AUTOMATIC_TAX;
    }
  });

  // ── Decision 8: invoice series ──────────────────────────────────────────────────

  maybe('USA: gapless under concurrency, a new series on 1 January (UTC)', async () => {
    scopes.push('BIL-US-2097', 'BIL-US-2098', 'BIL-IN-FY2097-98');
    const dec31 = new Date('2097-12-31T23:59:59.999Z');
    const numbers = await Promise.all(
      Array.from({ length: 15 }, () =>
        db!.$transaction((tx: Client) => assignInvoiceNumber(tx, dec31, 'US')),
      ),
    );
    const seqs = numbers.map((n: string) => Number(n.split('-').pop())).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(numbers.every((n: string) => /^ETG-BIL-US-2097-\d{6}$/.test(n))).toBe(true);
    expect(
      await db!.$transaction((tx: Client) =>
        assignInvoiceNumber(tx, new Date('2098-01-01T00:00:00.000Z'), 'US'),
      ),
    ).toBe('ETG-BIL-US-2098-000001');
    // India is its own series: a US number never consumes an Indian one.
    expect(
      await db!.$transaction((tx: Client) =>
        assignInvoiceNumber(tx, new Date('2097-06-01T00:00:00Z'), 'IN'),
      ),
    ).toBe('ETGB-9798-000001');
  });

  // ── Decisions 1 and 3: complaints and "unsubscribe from all marketing email" ────

  maybe(
    'a complaint stops marketing from every organizer but not tickets; a hard bounce stops both',
    async () => {
      const suppression = new SuppressionService(db as never);
      const consent = new CommunicationConsentService(
        db as never,
        audit,
        new MarketingConsentService(db as never),
        suppression,
      );
      const orgA = await makeOrg('mk-a', 'India', 'Karnataka');
      const orgB = await makeOrg('mk-b', 'India', 'Karnataka');
      const u = await makeUser('complainer');
      const subject = { userId: u.id, email: u.email };
      const ctx = { source: 'test', actorUserId: u.id };
      for (const organizationId of [orgA, orgB]) {
        await consent.record(
          subject,
          { purpose: 'ORGANIZER_UPDATES', organizationId, granted: true },
          ctx,
        );
      }
      expect(await consent.mayEmailForOrganizer(subject, orgB, 'ORGANIZER_UPDATES')).toBe(true);

      // A complaint about orgA's campaign.
      await suppression.suppress({
        channel: 'email',
        destination: u.email,
        reason: 'COMPLAINT' as never,
        provider: 'ses',
      });
      expect(await suppression.isSuppressed('email', u.email)).toBe(false); // tickets go
      expect(await suppression.isSuppressed('email', u.email, 'marketing')).toBe(true);
      // ...and every organizer's marketing stops, not only orgA's.
      expect(await consent.mayEmailForOrganizer(subject, orgB, 'ORGANIZER_UPDATES')).toBe(false);

      // A hard bounce later: the address is dead, so everything stops; both reasons kept.
      await suppression.suppress({
        channel: 'email',
        destination: u.email,
        reason: 'HARD_BOUNCE' as never,
        provider: 'ses',
      });
      expect(await suppression.isSuppressed('email', u.email)).toBe(true);
      const rows = await db!.suppressedDestination.findMany({
        where: { channel: 'email', destinationHash: SuppressionService.hash('email', u.email) },
        orderBy: { scope: 'asc' },
      });
      expect(rows.map((r: { scope: string; reason: string }) => [r.scope, r.reason])).toEqual([
        ['ALL', 'HARD_BOUNCE'],
        ['MARKETING', 'COMPLAINT'],
      ]);
    },
  );

  maybe(
    '"unsubscribe from all marketing email" stops every organizer, never tickets, and only the account-wide setting lifts it',
    async () => {
      const suppression = new SuppressionService(db as never);
      const marketing = new MarketingConsentService(db as never, suppression, audit);
      const consent = new CommunicationConsentService(db as never, audit, marketing, suppression);
      const unsubscribe = new UnsubscribeService(
        db as never,
        config,
        consent,
        undefined,
        suppression,
      );
      const orgA = await makeOrg('all-a', 'India', 'Karnataka');
      const orgB = await makeOrg('all-b', 'United States', 'TX');
      const u = await makeUser('leaver');
      const subject = { userId: u.id, email: u.email };
      for (const organizationId of [orgA, orgB]) {
        await consent.record(
          subject,
          { purpose: 'OFFERS', organizationId, granted: true },
          { source: 'test', actorUserId: u.id },
        );
      }
      const token = signUnsubscribeToken(
        {
          userId: u.id,
          email: u.email,
          scope: 'global',
          organizationId: null,
          purpose: 'MARKETING_EMAIL',
        },
        unsubscribeKey(config),
      );
      await unsubscribe.unsubscribe(token, { oneClick: false });

      expect(await suppression.isSuppressed('email', u.email)).toBe(false); // never tickets
      expect(await suppression.isSuppressed('email', u.email, 'marketing')).toBe(true);
      expect(await consent.mayEmailForOrganizer(subject, orgA, 'OFFERS')).toBe(false);
      expect(await consent.mayEmailForOrganizer(subject, orgB, 'OFFERS')).toBe(false);
      expect((await consent.platformMarketingEmail(subject)).granted).toBe(false);

      // Opting in again to ONE organizer records that consent but never lifts the global
      // unsubscribe (owner decision 2026-10-28): marketing stays blocked.
      await consent.record(
        subject,
        { purpose: 'OFFERS', organizationId: orgA, granted: true },
        { source: 'account', actorUserId: u.id },
      );
      expect(await suppression.isSuppressed('email', u.email, 'marketing')).toBe(true);
      expect(await consent.mayEmailForOrganizer(subject, orgA, 'OFFERS')).toBe(false);

      // Turning marketing email back on account-wide lifts it; only orgA was granted again.
      await consent.record(
        subject,
        { purpose: 'MARKETING_EMAIL', organizationId: null, granted: true },
        { source: 'account-settings:marketing-email', actorUserId: u.id, accountWide: true },
      );
      expect(await suppression.isSuppressed('email', u.email, 'marketing')).toBe(false);
      expect(await consent.mayEmailForOrganizer(subject, orgA, 'OFFERS')).toBe(true);
      expect(await consent.mayEmailForOrganizer(subject, orgB, 'OFFERS')).toBe(false);
    },
  );
});
