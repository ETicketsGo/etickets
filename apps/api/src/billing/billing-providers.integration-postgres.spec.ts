import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Role, type FeatureFlag } from '@eticketsgo/shared-types';
import { AuditService } from '../audit/audit.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { TransactionalEventPublisher, type DomainEvent } from '../common/domain-events';
import type { RequestUser } from '../common/decorators';
import { EntitlementService } from './entitlements/entitlement.service';
import { SubscriptionService } from './subscription.service';
import { BillingCatalogService } from './billing-catalog.service';
import { BillingInvoiceService } from './billing-invoice.service';
import { BillingReadService } from './billing-read.service';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingProviderEventService } from './billing-provider-events.service';
import { BillingSweepService } from './billing-sweep.service';
import { BillingTaxService } from './billing-tax.service';
import { CreditPackPricesService } from './credit-pack-prices.service';
import { BillingWebhookController } from './billing-webhook.controller';
import { OrganizerBillingController } from './billing.controller';
import { BillingProviderRegistry } from './provider/billing-provider.registry';
import { DisabledBillingProvider } from './provider/billing-provider';
import { StripeBillingProvider } from './provider/stripe-billing.provider';
import { RazorpaySubscriptionsProvider } from './provider/razorpay-subscriptions.provider';
import {
  RAZORPAY_TEST_WEBHOOK_SECRET,
  STRIPE_TEST_WEBHOOK_SECRET,
  fakeRazorpay,
  fakeStripe,
  razorpayEvent,
  razorpayPaymentLink,
  razorpayState,
  razorpaySubscription,
  signRazorpay,
  signStripe,
  stripeCreditPackSession,
  stripeEvent,
  stripeInvoice,
  stripeState,
  stripeSubscription,
} from './provider/billing-provider.fixture';
import { holdBillingSpecLock } from './billing-spec-lock.fixture';

/**
 * integration-real-postgres: the real billing providers, end to end from the RAW webhook bytes
 * to the subscription, invoice and credit rows - offline.
 *
 * Stripe Billing and Razorpay Subscriptions are the real adapters (signature verification,
 * event mapping, record reading); only their HTTP clients are fakes answering from recorded-
 * shape fixtures (provider/billing-provider.fixture.ts). What this proves against the migrated
 * schema: replay safety (event row, payment row, ledger key), activation refused without the
 * provider's verified record or with an amount/currency/customer mismatch, out-of-order and
 * stale events never moving a subscription backwards, credits granted once, disputes flagged,
 * cancellation, the sweep's PAST_DUE -> GRACE -> EXPIRED path with dunning, transient failures
 * retried, and checkout refused across tenants.
 *
 * Fixture dates are in 2093 so the invoice counters it uses (BIL-US-2093, BIL-IN-FY2092-93,
 * BIL-IN-FY2093-94) are its own; they are removed
 * afterwards with every row made here. Skips (never fabricates a pass) without a database.
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

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2093-03-01T00:00:00Z');
/*
  Tax: US plans and packs here go through Stripe Tax (STRIPE_BILLING_AUTOMATIC_TAX=true); India
  through a PLATFORM_SERVICES rule this suite creates and removes. The rate is the suite's own
  value, never one from the code (there is none there).
*/
const IN_RATE_BPS = 1800;
const withTax = (net: number) => net + Math.round((net * IN_RATE_BPS) / 10_000);
const at = (days: number) => new Date(T0.getTime() + days * DAY);

describe('integration-real-postgres: billing providers (Stripe Billing, Razorpay Subscriptions)', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  let releaseLock: (() => Promise<void>) | undefined;
  const tag = `bp${Date.now()}`;
  const userIds: string[] = [];
  const orgIds: string[] = [];
  let createdPlanCodes: string[] = [];
  const restoredPrices: { id: string; ref: string | null }[] = [];

  const sState = stripeState();
  const rState = razorpayState();
  const stripe = new StripeBillingProvider({
    secretKey: 'sk_test_offline',
    webhookSecret: STRIPE_TEST_WEBHOOK_SECRET,
    mode: 'test',
    client: fakeStripe(sState),
  });
  const razorpay = new RazorpaySubscriptionsProvider({
    keyId: 'rzp_test_offline',
    keySecret: 'offline',
    webhookSecret: RAZORPAY_TEST_WEBHOOK_SECRET,
    mode: 'test',
    mandateMaxMinor: 1_500_000,
    upiAutopay: false,
    client: fakeRazorpay(rState),
  });
  const registry = BillingProviderRegistry.fixed(new DisabledBillingProvider(), {
    STRIPE_BILLING: stripe,
    RAZORPAY_BILLING: razorpay,
  });
  const env: Record<string, string> = {
    APP_ENV: 'LOCAL',
    BILLING_ENABLED: 'true',
    BILLING_GRACE_DAYS: '7',
    BILLING_PAST_DUE_DAYS: '7',
    ORGANIZER_WEB_URL: 'https://organizer.test',
    STRIPE_BILLING_AUTOMATIC_TAX: 'true',
    PLATFORM_TAX_REGION: 'Karnataka',
  };
  let taxRuleId = '';
  const createdPackPrices: string[] = [];
  const config = { get: (k: string) => env[k] } as never;
  const dunning: { organizationId: string; payload: Record<string, unknown> }[] = [];
  const audience = {
    notifyOrganizationOwners: async (
      organizationId: string,
      _t: unknown,
      payload: Record<string, unknown>,
    ) => {
      dunning.push({ organizationId, payload });
      return 1;
    },
  };

  let events: BillingProviderEventService;
  let checkouts: BillingCheckoutService;
  let sweep: BillingSweepService;
  let webhooks: BillingWebhookController;
  let controller: OrganizerBillingController;

  let ownerUS: RequestUser;
  let ownerIN: RequestUser;
  let orgUS = '';
  let orgIN = '';
  let orgSweep = '';
  let usPrice: { id: string; amountMinor: number; planId: string };
  let usPremium: { id: string; amountMinor: number; planId: string };
  let inPrice: { id: string; amountMinor: number; planId: string };
  let usCustomer = '';
  let sweepCustomer = '';
  let inCustomer = '';

  const ALL_ON = (_f: FeatureFlag) => true;

  async function makeUser(name: string): Promise<RequestUser> {
    const u = await db!.user.create({
      data: {
        email: `${name}-${tag}@test.invalid`,
        fullName: name,
        passwordHash: 'x',
        roles: ['ORGANIZER_OWNER'],
      },
    });
    userIds.push(u.id);
    return { id: u.id, email: u.email, fullName: u.fullName, roles: [Role.ORGANIZER_OWNER] };
  }

  async function makeOrg(name: string, country: string, owner: RequestUser): Promise<string> {
    const o = await db!.organization.create({
      data: {
        name: `${name} ${tag}`,
        slug: `${name}-${tag}`,
        status: 'APPROVED',
        registeredCountry: country,
      },
    });
    orgIds.push(o.id);
    await db!.organizationMember.create({
      data: { organizationId: o.id, userId: owner.id, role: 'ORGANIZER_OWNER' },
    });
    return o.id;
  }

  /** Sets a test-mode provider ref on a price, remembering what was there to put it back. */
  async function priceWithRef(code: string, country: string, ref: string) {
    const p = await db!.billingPrice.findFirstOrThrow({
      where: { plan: { code }, country, interval: 'MONTH', active: true },
    });
    restoredPrices.push({ id: p.id, ref: p.providerPriceRefTest });
    await db!.billingPrice.update({ where: { id: p.id }, data: { providerPriceRefTest: ref } });
    return { id: p.id, amountMinor: p.amountMinor, planId: p.planId };
  }

  const stripeHook = async (
    type: string,
    object: Record<string, unknown>,
    id: string,
    when = new Date(),
  ) => {
    const { raw, headers } = signStripe(stripeEvent(`${tag}-${id}`, type, object, when));
    return webhooks.stripe({
      rawBody: Buffer.from(raw),
      header: (n: string) => (headers as Record<string, string>)[n],
    } as never);
  };
  const razorpayHook = async (body: Record<string, unknown>, id: string) => {
    const { raw, headers } = signRazorpay(body, `${tag}-${id}`);
    return webhooks.razorpay({
      rawBody: Buffer.from(raw),
      header: (n: string) => (headers as Record<string, string>)[n],
    } as never);
  };
  const current = async (organizationId: string) => {
    const account = await db!.organizerBillingAccount.findUnique({ where: { organizationId } });
    return account
      ? db!.organizerSubscription.findUnique({
          where: { currentKey: account.id },
          include: { plan: true },
        })
      : null;
  };

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
    const audit = new AuditService(db as never);
    const published: DomainEvent[] = [];
    const publisher = new TransactionalEventPublisher(
      db as never,
      { publishMany: async (e: DomainEvent[]) => void published.push(...e) } as never,
      { get: () => 'in_process' } as never,
      {} as never,
    );
    const entitlements = new EntitlementService(db as never, ALL_ON);
    const subscriptions = new SubscriptionService(db as never, audit, publisher, entitlements);
    const invoices = new BillingInvoiceService(db as never);
    const tax = new BillingTaxService(db as never, config);
    const packPrices = new CreditPackPricesService(db as never, audit);
    events = new BillingProviderEventService(
      db as never,
      audit,
      subscriptions,
      entitlements,
      publisher,
      invoices,
      registry,
      config,
      audience as never,
      tax,
    );
    checkouts = new BillingCheckoutService(
      db as never,
      config,
      registry,
      subscriptions,
      tax,
      packPrices,
    );
    sweep = new BillingSweepService(
      db as never,
      config,
      subscriptions,
      events,
      registry,
      audience as never,
    );
    webhooks = new BillingWebhookController(registry, events);
    controller = new OrganizerBillingController(
      new OrgAccessService(db as never, audit),
      entitlements,
      new BillingReadService(db as never, entitlements, invoices, config, registry),
      db as never,
      checkouts,
    );

    const staff = await makeUser('staff');
    ownerUS = await makeUser('owner-us');
    ownerIN = await makeUser('owner-in');
    orgUS = await makeOrg('org-us', 'United States', ownerUS);
    orgIN = await makeOrg('org-in', 'India', ownerIN);
    await db!.organization.update({
      where: { id: orgIN },
      data: { registeredRegion: 'Telangana' },
    });
    taxRuleId = (
      await db!.taxRule.create({
        data: {
          label: 'GST',
          rateBasisPoints: IN_RATE_BPS,
          appliesTo: 'PLATFORM_SERVICES',
          country: 'IN',
          currency: 'INR',
          split: 'CGST_SGST',
          active: true,
        },
      })
    ).id;
    // The pack this suite buys, priced and published (unpublished packs are not on sale).
    for (const [country, currency, amountMinor] of [
      ['US', 'USD', 900],
      ['IN', 'INR', 49_900],
    ] as const) {
      const before = await db!.creditPackPrice.findUnique({
        where: { packCode_country: { packCode: 'EMAIL_5K', country } },
      });
      const row = await packPrices.setPrice(
        'EMAIL_5K',
        country,
        { currency, amountMinor },
        staff.id,
      );
      if (!before) createdPackPrices.push(row.id);
      await packPrices.setPublished('EMAIL_5K', country, true, staff.id);
    }
    orgSweep = await makeOrg('org-sweep', 'US', ownerUS);

    const had = new Set(
      (await db!.billingPlan.findMany({ select: { code: true } })).map(
        (p: { code: string }) => p.code,
      ),
    );
    await new BillingCatalogService(db as never, audit).loadProvisional(staff.id);
    createdPlanCodes = ['FREE', 'PRO', 'PREMIUM'].filter((c) => !had.has(c));
    usPrice = await priceWithRef('PRO', 'US', `price_${tag}_pro_us`);
    usPremium = await priceWithRef('PREMIUM', 'US', `price_${tag}_premium_us`);
    inPrice = await priceWithRef('PRO', 'IN', `plan_${tag}_pro_in`);
    rState.plans[`plan_${tag}_pro_in`] = {
      id: `plan_${tag}_pro_in`,
      period: 'monthly',
      interval: 1,
      // Razorpay computes no tax: the plan charges the price plus GST.
      item: { amount: withTax(inPrice.amountMinor), currency: 'INR' },
    };
  }, 120_000);

  afterAll(async () => {
    if (db && available) {
      for (const p of restoredPrices) {
        await db.billingPrice.update({
          where: { id: p.id },
          data: { providerPriceRefTest: p.ref },
        });
      }
      const accounts = await db.organizerBillingAccount.findMany({
        where: { organizationId: { in: orgIds } },
        select: { id: true },
      });
      const accountIds = accounts.map((a: { id: string }) => a.id);
      await db.$transaction(async (tx: Client) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "UsageLedger" DISABLE TRIGGER "UsageLedger_append_only"',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE "OrganizerInvoice" DISABLE TRIGGER "OrganizerInvoice_number_frozen"',
        );
        await tx.usageLedger.deleteMany({ where: { organizationId: { in: orgIds } } });
        await tx.billingPayment.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.organizerInvoice.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.organizerSubscription.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.organizerBillingAccount.deleteMany({ where: { id: { in: accountIds } } });
        await tx.billingWebhookEvent.deleteMany({
          where: { providerEventId: { startsWith: tag } },
        });
        await tx.readableReferenceCounter.deleteMany({
          where: { scope: { in: ['BIL-US-2093', 'BIL-IN-FY2092-93', 'BIL-IN-FY2093-94'] } },
        });
        await tx.creditPackPurchase.deleteMany({ where: { organizationId: { in: orgIds } } });
        if (createdPlanCodes.length) {
          const plans = await tx.billingPlan.findMany({
            where: { code: { in: createdPlanCodes } },
          });
          const ids = plans.map((p: { id: string }) => p.id);
          await tx.billingPrice.deleteMany({ where: { planId: { in: ids } } });
          await tx.billingPlan.deleteMany({ where: { id: { in: ids } } });
        }
        await tx.$executeRawUnsafe(
          'ALTER TABLE "UsageLedger" ENABLE TRIGGER "UsageLedger_append_only"',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE "OrganizerInvoice" ENABLE TRIGGER "OrganizerInvoice_number_frozen"',
        );
      });
      if (taxRuleId) await db.taxRule.deleteMany({ where: { id: taxRuleId } });
      if (createdPackPrices.length) {
        await db.creditPackPrice.deleteMany({ where: { id: { in: createdPackPrices } } });
      }
      await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
      await db.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
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

  // ── Checkout ───────────────────────────────────────────────────────────────────

  maybe('checkout: an owner gets a hosted Stripe page; the customer is created once', async () => {
    const s = await controller.checkout(ownerUS, orgUS, { priceId: usPrice.id });
    expect(s).toMatchObject({ provider: 'STRIPE_BILLING' });
    expect(s.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const account = await db!.organizerBillingAccount.findUniqueOrThrow({
      where: { organizationId: orgUS },
    });
    expect(account.provider).toBe('STRIPE_BILLING');
    usCustomer = account.providerCustomerRef!;
    expect(usCustomer).toMatch(/^cus_/);
    await controller.checkout(ownerUS, orgUS, { priceId: usPrice.id });
    expect(sState.calls.filter((c) => c.method === 'customers.create')).toHaveLength(1);
    // The return page polls our state; nothing was granted by starting a checkout.
    expect(await current(orgUS)).toBeNull();
  });

  maybe('checkout: refused across tenants and for another country price', async () => {
    await expect(
      controller.checkout(ownerIN, orgUS, { priceId: usPrice.id }),
    ).rejects.toBeDefined();
    await expect(
      controller.checkout(ownerUS, orgUS, { priceId: inPrice.id }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(controller.portal(ownerIN, orgUS)).rejects.toBeDefined();
  });

  // ── Webhook signature ─────────────────────────────────────────────────────────

  maybe('a delivery with a bad signature is refused and leaves no row', async () => {
    const { raw } = signStripe(stripeEvent(`${tag}-forged`, 'invoice.paid', { id: 'in_x' }));
    await expect(
      webhooks.stripe({ rawBody: Buffer.from(raw), header: () => 't=1,v1=deadbeef' } as never),
    ).rejects.toMatchObject({ code: 'BILLING_WEBHOOK_INVALID' });
    expect(
      await db!.billingWebhookEvent.count({ where: { providerEventId: `${tag}-forged` } }),
    ).toBe(0);
  });

  // ── Activation needs the provider's verified record ───────────────────────────

  const subRef = () => `sub_${tag}_us`;
  const invoice = (id: string, o: Partial<Parameters<typeof stripeInvoice>[0]> = {}) =>
    stripeInvoice({
      id,
      customer: usCustomer,
      subscription: subRef(),
      organizationId: orgUS,
      price: `price_${tag}_pro_us`,
      amount: usPrice.amountMinor,
      currency: 'USD',
      start: at(0),
      end: at(30),
      ...o,
    });

  maybe(
    'activation is refused: unpaid, wrong amount, wrong currency, another customer',
    async () => {
      sState.subs[subRef()] = stripeSubscription({
        id: subRef(),
        customer: usCustomer,
        price: `price_${tag}_pro_us`,
        organizationId: orgUS,
        start: at(0),
        end: at(30),
      });
      const cases: [string, Record<string, unknown>, RegExp][] = [
        [
          `in_${tag}_open`,
          invoice(`in_${tag}_open`, { status: 'open' }),
          /no verified paid record/,
        ],
        [
          `in_${tag}_low`,
          invoice(`in_${tag}_low`, { amount: usPrice.amountMinor - 1 }),
          /does not match/,
        ],
        [`in_${tag}_inr`, invoice(`in_${tag}_inr`, { currency: 'INR' }), /does not match/],
        [
          `in_${tag}_cus`,
          invoice(`in_${tag}_cus`, { customer: 'cus_somebody_else' }),
          /belongs to no billing account/,
        ],
      ];
      for (const [id, inv, reason] of cases) {
        sState.invoices[id] = inv;
        // The webhook body CLAIMS paid every time; only the fetched record decides.
        const r = await stripeHook('invoice.paid', { ...inv, status: 'paid' }, id);
        expect(r).toMatchObject({ outcome: 'FAILED' });
        expect((r as { reason: string }).reason).toMatch(reason);
      }
      expect(await current(orgUS)).toBeNull();
      const rows = await db!.billingWebhookEvent.findMany({
        where: { providerEventId: { in: cases.map(([id]) => `${tag}-${id}`) } },
      });
      expect(rows.map((r: { status: string }) => r.status)).toEqual([
        'FAILED',
        'FAILED',
        'FAILED',
        'FAILED',
      ]);
    },
  );

  maybe(
    'a verified payment activates; the replay is a DUPLICATE; one invoice, one payment',
    async () => {
      const id = `in_${tag}_1`;
      sState.invoices[id] = invoice(id);
      const r = await stripeHook('invoice.paid', sState.invoices[id], 'paid-1');
      expect(r).toMatchObject({ outcome: 'PROCESSED' });
      const sub = await current(orgUS);
      expect(sub).toMatchObject({
        status: 'ACTIVE',
        source: 'PROVIDER',
        providerSubscriptionRef: subRef(),
      });
      expect(sub!.currentPeriodEnd!.toISOString()).toBe(at(30).toISOString());

      expect(await stripeHook('invoice.paid', sState.invoices[id], 'paid-1')).toMatchObject({
        outcome: 'DUPLICATE',
      });
      // The same payment reached through another event (checkout completed): applied once.
      sState.subs[subRef()].latest_invoice = sState.invoices[id];
      const again = await stripeHook(
        'checkout.session.completed',
        {
          id: 'cs_x',
          mode: 'subscription',
          subscription: subRef(),
          metadata: { organizationId: orgUS, etg_purpose: 'etg_billing_subscription' },
        },
        'checkout-1',
      );
      expect(again).toMatchObject({ outcome: 'IGNORED' });

      const account = await db!.organizerBillingAccount.findUniqueOrThrow({
        where: { organizationId: orgUS },
      });
      const invoices = await db!.organizerInvoice.findMany({ where: { accountId: account.id } });
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({
        status: 'PAID',
        provider: 'STRIPE_BILLING',
        providerInvoiceRef: id,
        taxMinor: 0,
      });
      expect(invoices[0].number).toMatch(/^ETG-BIL-US-2093-\d{6}$/);
      // Stripe Tax decided (STRIPE_BILLING_AUTOMATIC_TAX): the invoice says so in a tax line.
      const doc = invoices[0].documentJson as Record<string, unknown>;
      expect(doc.taxNote).toBeNull();
      expect(doc.taxMode).toBe('PROVIDER_AUTOMATIC');
      expect(doc.taxLines).toEqual([
        expect.objectContaining({ label: 'Sales tax (Stripe Tax)', amountMinor: 0 }),
      ]);
      const payments = await db!.billingPayment.findMany({ where: { accountId: account.id } });
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        status: 'SUCCEEDED',
        purpose: 'SUBSCRIPTION',
        invoiceId: invoices[0].id,
      });
      expect(payments[0].verifiedAt).not.toBeNull();

      // The printable invoice, behind the same membership check.
      const html = await controller.invoiceHtml(ownerUS, orgUS, invoices[0].id);
      expect(html).toContain(invoices[0].number!);
      // The tax line Stripe Tax charged, not a "tax not applied" note.
      expect(html).toContain('Sales tax (Stripe Tax)');
      expect(html).not.toContain('Tax not applied');
      await expect(controller.invoiceHtml(ownerIN, orgUS, invoices[0].id)).rejects.toBeDefined();
      await expect(controller.invoiceHtml(ownerIN, orgIN, invoices[0].id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    },
  );

  maybe('a second checkout is refused while the plan is paid', async () => {
    await expect(checkouts.startPlanCheckout(orgUS, usPrice.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  // ── Order: renewals, late payments, failures, recovery ────────────────────────

  maybe('renewal extends; a late payment for an earlier period changes nothing', async () => {
    const id = `in_${tag}_2`;
    sState.invoices[id] = invoice(id, { start: at(30), end: at(60) });
    sState.subs[subRef()] = { ...sState.subs[subRef()], latest_invoice: sState.invoices[id] };
    expect(await stripeHook('invoice.paid', sState.invoices[id], 'paid-2')).toMatchObject({
      outcome: 'PROCESSED',
    });
    expect((await current(orgUS))!.currentPeriodEnd!.toISOString()).toBe(at(60).toISOString());

    const old = `in_${tag}_0`;
    sState.invoices[old] = invoice(old, { start: at(-30), end: at(0) });
    const r = await stripeHook('invoice.paid', sState.invoices[old], 'paid-0');
    expect(r).toMatchObject({
      outcome: 'PROCESSED',
      note: expect.stringMatching(/already applied/),
    });
    expect((await current(orgUS))!.currentPeriodEnd!.toISOString()).toBe(at(60).toISOString());
  });

  maybe(
    'a failure moves to PAST_DUE only when the provider says so; a paid invoice recovers',
    async () => {
      // The event claims a failure but the provider reports the subscription active: nothing.
      const failed = invoice(`in_${tag}_f`, { status: 'open' });
      expect(await stripeHook('invoice.payment_failed', failed, 'failed-stale')).toMatchObject({
        outcome: 'IGNORED',
      });
      expect((await current(orgUS))!.status).toBe('ACTIVE');

      sState.subs[subRef()] = {
        ...sState.subs[subRef()],
        status: 'past_due',
        latest_invoice: failed,
      };
      expect(await stripeHook('invoice.payment_failed', failed, 'failed-1')).toMatchObject({
        outcome: 'PROCESSED',
      });
      expect((await current(orgUS))!.status).toBe('PAST_DUE');
      expect(
        dunning.some((d) => d.organizationId === orgUS && d.payload.stage === 'PAST_DUE'),
      ).toBe(true);

      // The retry succeeded, but invoice.paid never arrived: the next subscription event recovers it.
      const id = `in_${tag}_3`;
      sState.invoices[id] = invoice(id, { start: at(60), end: at(90) });
      sState.subs[subRef()] = {
        ...sState.subs[subRef()],
        status: 'active',
        latest_invoice: sState.invoices[id],
      };
      expect(
        await stripeHook('customer.subscription.updated', sState.subs[subRef()], 'updated-1'),
      ).toMatchObject({
        outcome: 'PROCESSED',
      });
      const sub = await current(orgUS);
      expect(sub!.status).toBe('ACTIVE');
      expect(sub!.currentPeriodEnd!.toISOString()).toBe(at(90).toISOString());
    },
  );

  maybe('cancellation: the provider confirms first; an OLDER event cannot resume it', async () => {
    const cancelled = await controller.cancel(ownerUS, orgUS, { reason: 'too expensive' });
    expect(cancelled).toMatchObject({ status: 'ACTIVE', cancelAtPeriodEnd: true });
    expect(sState.calls.some((c) => c.method === 'subscriptions.update')).toBe(true);

    // Newer provider event (cancel_at_period_end: true), then an older one saying false.
    await stripeHook(
      'customer.subscription.updated',
      sState.subs[subRef()],
      'updated-2',
      new Date(),
    );
    const stale = { ...sState.subs[subRef()], cancel_at_period_end: false };
    const r = await stripeHook(
      'customer.subscription.updated',
      stale,
      'updated-old',
      new Date(Date.now() - 3600_000),
    );
    expect(r).toMatchObject({ outcome: 'IGNORED', note: expect.stringMatching(/Stale/) });
    expect((await current(orgUS))!.cancelAtPeriodEnd).toBe(true);
  });

  maybe('deleted ends it; a late paid invoice after that never re-activates it', async () => {
    sState.subs[subRef()] = { ...sState.subs[subRef()], status: 'canceled' };
    expect(
      await stripeHook('customer.subscription.deleted', sState.subs[subRef()], 'deleted-1'),
    ).toMatchObject({
      outcome: 'PROCESSED',
    });
    expect(await current(orgUS)).toBeNull();
    const ended = await db!.organizerSubscription.findUniqueOrThrow({
      where: { providerSubscriptionRef: subRef() },
    });
    expect(ended.status).toBe('CANCELLED');

    const id = `in_${tag}_late`;
    sState.invoices[id] = invoice(id, { start: at(90), end: at(120) });
    const r = await stripeHook('invoice.paid', sState.invoices[id], 'paid-late');
    expect(r).toMatchObject({
      outcome: 'PROCESSED',
      note: expect.stringMatching(/no longer live|already ended/),
    });
    expect(await current(orgUS)).toBeNull();
  });

  // ── Credit packs ──────────────────────────────────────────────────────────────

  maybe('a credit pack grants credits once, on the verified payment only', async () => {
    const ledgerSum = async () =>
      (
        await db!.usageLedger.aggregate({
          where: { organizationId: orgUS, key: 'campaigns.email_credits' },
          _sum: { delta: true },
        })
      )._sum.delta ?? 0;
    const s = await controller.creditPackCheckout(ownerUS, orgUS, { packCode: 'EMAIL_5K' });
    expect(s.url).toMatch(/checkout\.stripe\.test/);
    const purchase = await db!.creditPackPurchase.findFirstOrThrow({
      where: { organizationId: orgUS },
      orderBy: { createdAt: 'desc' },
    });
    expect(purchase).toMatchObject({
      packCode: 'EMAIL_5K',
      netMinor: 900,
      taxMode: 'PROVIDER_AUTOMATIC',
      status: 'PENDING',
      providerSessionRef: s.sessionRef,
    });

    const mk = (id: string, o: Partial<Parameters<typeof stripeCreditPackSession>[0]> = {}) =>
      stripeCreditPackSession({
        id,
        customer: usCustomer,
        organizationId: orgUS,
        packCode: 'EMAIL_5K',
        amount: 900,
        currency: 'USD',
        at: at(1),
        purchaseRef: purchase.purchaseRef,
        ...o,
      });
    sState.sessions[`cs_${tag}_unpaid`] = mk(`cs_${tag}_unpaid`, { paid: false });
    expect(
      await stripeHook(
        'checkout.session.completed',
        { ...mk(`cs_${tag}_unpaid`), payment_status: 'paid' },
        'pack-unpaid',
      ),
    ).toMatchObject({ outcome: 'FAILED' });
    sState.sessions[`cs_${tag}_cheap`] = mk(`cs_${tag}_cheap`, { amount: 100 });
    expect(
      await stripeHook(
        'checkout.session.completed',
        sState.sessions[`cs_${tag}_cheap`],
        'pack-cheap',
      ),
    ).toMatchObject({
      outcome: 'FAILED',
    });
    expect(await ledgerSum()).toBe(0);

    sState.sessions[`cs_${tag}_ok`] = mk(`cs_${tag}_ok`);
    expect(
      await stripeHook('checkout.session.completed', sState.sessions[`cs_${tag}_ok`], 'pack-ok'),
    ).toMatchObject({
      outcome: 'PROCESSED',
    });
    expect(
      await stripeHook('checkout.session.completed', sState.sessions[`cs_${tag}_ok`], 'pack-ok'),
    ).toMatchObject({
      outcome: 'DUPLICATE',
    });
    // Redelivered under a new event id (a provider resend): the payment key stops it.
    expect(
      await stripeHook(
        'checkout.session.completed',
        sState.sessions[`cs_${tag}_ok`],
        'pack-ok-resend',
      ),
    ).toMatchObject({
      outcome: 'IGNORED',
    });
    expect(await ledgerSum()).toBe(5000);
    expect(
      await db!.creditPackPurchase.findUniqueOrThrow({ where: { id: purchase.id } }),
    ).toMatchObject({ status: 'PAID' });
  });

  // ── Disputes ──────────────────────────────────────────────────────────────────

  maybe(
    'a dispute on a billing payment flags the account and is audited; a ticket dispute is ignored',
    async () => {
      sState.disputes[`dp_${tag}_1`] = {
        id: `dp_${tag}_1`,
        amount: usPrice.amountMinor,
        currency: 'usd',
        reason: 'fraudulent',
        charge: { id: 'ch_1', customer: usCustomer },
      };
      sState.disputes[`dp_${tag}_t`] = {
        id: `dp_${tag}_t`,
        amount: 500,
        currency: 'usd',
        reason: 'general',
        charge: { id: 'ch_t', customer: null },
      };
      expect(
        await stripeHook('charge.dispute.created', { id: `dp_${tag}_t` }, 'dispute-ticket'),
      ).toMatchObject({
        outcome: 'IGNORED',
      });
      expect(
        await stripeHook('charge.dispute.created', { id: `dp_${tag}_1` }, 'dispute-1'),
      ).toMatchObject({
        outcome: 'PROCESSED',
      });
      const account = await db!.organizerBillingAccount.findUniqueOrThrow({
        where: { organizationId: orgUS },
      });
      expect(account.disputedAt).not.toBeNull();
      expect(account.disputeRef).toBe(`dp_${tag}_1`);
      expect(
        await db!.auditLog.count({
          where: { organizationId: orgUS, action: 'BILLING_DISPUTE_OPENED' },
        }),
      ).toBe(1);
    },
  );

  // ── Transient failures ────────────────────────────────────────────────────────

  maybe('a provider outage defers the event; the worker retry applies it', async () => {
    await checkouts.startPlanCheckout(orgSweep, usPremium.id);
    sweepCustomer = (
      await db!.organizerBillingAccount.findUniqueOrThrow({ where: { organizationId: orgSweep } })
    ).providerCustomerRef!;
    const ref = `sub_${tag}_sweep`;
    const id = `in_${tag}_sweep`;
    // A period that already ended: the sweep below picks it up.
    sState.invoices[id] = stripeInvoice({
      id,
      customer: sweepCustomer,
      subscription: ref,
      organizationId: orgSweep,
      price: `price_${tag}_premium_us`,
      amount: usPremium.amountMinor,
      currency: 'USD',
      start: new Date(Date.now() - 35 * DAY),
      end: new Date(Date.now() - 5 * DAY),
      paidAt: at(0),
    });
    sState.subs[ref] = stripeSubscription({
      id: ref,
      customer: sweepCustomer,
      price: `price_${tag}_premium_us`,
      organizationId: orgSweep,
      start: new Date(Date.now() - 35 * DAY),
      end: new Date(Date.now() - 5 * DAY),
      latestInvoice: sState.invoices[id],
    });
    sState.failReads = Object.assign(new Error('connect ETIMEDOUT'), {
      type: 'StripeConnectionError',
    });
    expect(await stripeHook('invoice.paid', sState.invoices[id], 'paid-sweep')).toMatchObject({
      outcome: 'DEFERRED',
    });
    const row = await db!.billingWebhookEvent.findUniqueOrThrow({
      where: {
        provider_providerEventId: {
          provider: 'STRIPE_BILLING',
          providerEventId: `${tag}-paid-sweep`,
        },
      },
    });
    expect(row).toMatchObject({ status: 'RECEIVED', attempts: 1 });
    sState.failReads = null;
    await events.retryPending(new Date(Date.now() + 2 * 60_000));
    expect(
      (await db!.billingWebhookEvent.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe('PROCESSED');
    expect((await current(orgSweep))!.status).toBe('ACTIVE');
  });

  // ── The clock ─────────────────────────────────────────────────────────────────

  maybe(
    'sweep: no renewal -> PAST_DUE -> GRACE -> EXPIRED, with one reminder per stage',
    async () => {
      const now = new Date();
      const before = dunning.filter((d) => d.organizationId === orgSweep).length;
      const r1 = await sweep.run(now);
      expect(r1.pastDue).toBeGreaterThanOrEqual(1);
      expect((await current(orgSweep))!.status).toBe('PAST_DUE');

      const r2 = await sweep.run(new Date(now.getTime() + 8 * DAY));
      expect(r2.grace).toBeGreaterThanOrEqual(1);
      const grace = await current(orgSweep);
      expect(grace!.status).toBe('GRACE');
      expect(grace!.graceEndsAt).not.toBeNull();

      await sweep.run(new Date(grace!.graceEndsAt!.getTime() + 60_000));
      expect(await current(orgSweep)).toBeNull();
      const ended = await db!.organizerSubscription.findFirstOrThrow({
        where: { providerSubscriptionRef: `sub_${tag}_sweep` },
      });
      expect(ended.status).toBe('EXPIRED');
      const stages = dunning
        .filter((d) => d.organizationId === orgSweep)
        .slice(before)
        .map((d) => d.payload.stage);
      expect(stages).toEqual(expect.arrayContaining(['PAST_DUE', 'GRACE']));
      // Every reminder says where to fix the payment.
      for (const d of dunning.filter((x) => x.organizationId === orgSweep).slice(before)) {
        expect(d.payload.link).toBe('https://organizer.test/organizer/billing');
      }
    },
  );

  // ── Razorpay ─────────────────────────────────────────────────────────────────

  maybe(
    'Razorpay: hosted subscription, activation from subscription.charged, halted -> GRACE, cancel',
    async () => {
      const s = await controller.checkout(ownerIN, orgIN, { priceId: inPrice.id });
      expect(s).toMatchObject({ provider: 'RAZORPAY_BILLING' });
      expect(s.url).toMatch(/^https:\/\/rzp\.test\/i\//);
      const inAccount = await db!.organizerBillingAccount.findUniqueOrThrow({
        where: { organizationId: orgIN },
      });
      // Bound to Razorpay by the checkout; Razorpay makes its own customer at authentication.
      expect(inAccount).toMatchObject({ provider: 'RAZORPAY_BILLING', providerCustomerRef: null });
      inCustomer = `cust_${tag}_rzp`;
      const ref = `sub_${tag}_in`;
      const sub = razorpaySubscription({
        id: ref,
        customer: inCustomer,
        plan: `plan_${tag}_pro_in`,
        organizationId: orgIN,
        start: at(0),
        end: at(30),
      });
      rState.subs[ref] = sub;
      rState.invoices[`inv_${tag}_1`] = {
        id: `inv_${tag}_1`,
        subscription_id: ref,
        billing_start: Math.floor(at(0).getTime() / 1000),
        billing_end: Math.floor(at(30).getTime() / 1000),
      };
      rState.payments[`pay_${tag}_1`] = {
        id: `pay_${tag}_1`,
        status: 'captured',
        // The plan charges the price plus GST: Razorpay computes no tax.
        amount: withTax(inPrice.amountMinor),
        currency: 'INR',
        invoice_id: `inv_${tag}_1`,
        created_at: Math.floor(at(0).getTime() / 1000),
      };
      // A claim for a payment Razorpay reports only authorized: refused.
      rState.payments[`pay_${tag}_auth`] = {
        ...rState.payments[`pay_${tag}_1`],
        id: `pay_${tag}_auth`,
        status: 'authorized',
      };
      expect(
        await razorpayHook(
          razorpayEvent('subscription.charged', {
            subscription: sub,
            payment: { id: `pay_${tag}_auth` },
          }),
          'charged-auth',
        ),
      ).toMatchObject({ outcome: 'FAILED' });
      expect(await current(orgIN)).toBeNull();

      // A Razorpay subscription whose notes name an organization that never checked out with
      // Razorpay (orgUS pays through Stripe) grants nothing, even fully paid.
      const foreignRef = `sub_${tag}_foreign`;
      rState.subs[foreignRef] = {
        ...sub,
        id: foreignRef,
        notes: { ...(sub.notes as object), organizationId: orgUS },
      };
      rState.invoices[`inv_${tag}_f`] = {
        ...rState.invoices[`inv_${tag}_1`],
        id: `inv_${tag}_f`,
        subscription_id: foreignRef,
      };
      rState.payments[`pay_${tag}_f`] = {
        ...rState.payments[`pay_${tag}_1`],
        id: `pay_${tag}_f`,
        invoice_id: `inv_${tag}_f`,
      };
      const foreign = await razorpayHook(
        razorpayEvent('subscription.charged', {
          subscription: rState.subs[foreignRef],
          payment: { id: `pay_${tag}_f` },
        }),
        'charged-foreign',
      );
      expect(foreign).toMatchObject({ outcome: 'FAILED' });
      expect((foreign as { reason: string }).reason).toMatch(/no billing account/);

      const body = razorpayEvent('subscription.charged', {
        subscription: sub,
        payment: { id: `pay_${tag}_1` },
      });
      expect(await razorpayHook(body, 'charged-1')).toMatchObject({ outcome: 'PROCESSED' });
      expect(await razorpayHook(body, 'charged-1')).toMatchObject({ outcome: 'DUPLICATE' });
      expect((await current(orgIN))!.status).toBe('ACTIVE');

      rState.subs[ref] = { ...sub, status: 'halted' };
      expect(
        await razorpayHook(
          razorpayEvent('subscription.halted', { subscription: rState.subs[ref] }),
          'halted-1',
        ),
      ).toMatchObject({
        outcome: 'PROCESSED',
      });
      expect((await current(orgIN))!.status).toBe('GRACE');
      expect(dunning.some((d) => d.organizationId === orgIN && d.payload.stage === 'GRACE')).toBe(
        true,
      );
    },
  );

  maybe('Razorpay: a credit pack payment link grants credits once', async () => {
    const s = await controller.creditPackCheckout(ownerIN, orgIN, { packCode: 'EMAIL_5K' });
    expect(s.url).toMatch(/rzp\.test\/l\//);
    const purchase = await db!.creditPackPurchase.findFirstOrThrow({
      where: { organizationId: orgIN },
      orderBy: { createdAt: 'desc' },
    });
    // Telangana organizer, Karnataka platform: inter-state, so one IGST line.
    expect(purchase).toMatchObject({
      netMinor: 49_900,
      taxMinor: withTax(49_900) - 49_900,
      totalMinor: withTax(49_900),
      taxMode: 'MANUAL',
    });
    expect(purchase.taxLines).toEqual([
      expect.objectContaining({ label: 'IGST', rateBasisPoints: IN_RATE_BPS }),
    ]);
    // The price before tax alone is refused: Razorpay's charge must be net + GST.
    const short = razorpayPaymentLink({
      id: `plink_${tag}_short`,
      organizationId: orgIN,
      packCode: 'EMAIL_5K',
      amount: 49_900,
      at: at(2),
      purchaseRef: purchase.purchaseRef,
    });
    rState.links[`plink_${tag}_short`] = short;
    expect(
      await razorpayHook(
        razorpayEvent('payment_link.paid', { payment_link: short, payment: { id: 'pay_s' } }),
        'plink-short',
      ),
    ).toMatchObject({ outcome: 'FAILED' });
    const link = razorpayPaymentLink({
      id: `plink_${tag}_1`,
      organizationId: orgIN,
      packCode: 'EMAIL_5K',
      amount: withTax(49_900),
      at: at(2),
      purchaseRef: purchase.purchaseRef,
    });
    rState.links[`plink_${tag}_1`] = link;
    const body = razorpayEvent('payment_link.paid', {
      payment_link: link,
      payment: { id: 'pay_pl' },
    });
    expect(await razorpayHook(body, 'plink-1')).toMatchObject({ outcome: 'PROCESSED' });
    expect(await razorpayHook(body, 'plink-1-resend')).toMatchObject({ outcome: 'IGNORED' });
    const sum = await db!.usageLedger.aggregate({
      where: { organizationId: orgIN, key: 'campaigns.email_credits' },
      _sum: { delta: true },
    });
    expect(sum._sum.delta).toBe(5000);
    const account = await db!.organizerBillingAccount.findUniqueOrThrow({
      where: { organizationId: orgIN },
    });
    const packInvoice = await db!.organizerInvoice.findFirstOrThrow({
      where: { accountId: account.id, providerInvoiceRef: `plink_${tag}_1` },
    });
    // The invoice splits Razorpay's total back into net and GST, numbered in India's FY series.
    expect(packInvoice).toMatchObject({
      subtotalMinor: 49_900,
      taxMinor: withTax(49_900) - 49_900,
      totalMinor: withTax(49_900),
    });
    expect(packInvoice.number).toMatch(/^ETGB-\d{4}-\d{6}$/);
  });
});
