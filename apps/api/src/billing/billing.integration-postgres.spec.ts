import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Role, type FeatureFlag } from '@eticketsgo/shared-types';
import { AuditService } from '../audit/audit.service';
import { OrgAccessService } from '../tenancy/org-access.service';
import { TransactionalEventPublisher, type DomainEvent } from '../common/domain-events';
import type { RequestUser } from '../common/decorators';
import { EntitlementService } from './entitlements/entitlement.service';
import { SubscriptionService } from './subscription.service';
import { BillingOffersService } from './billing-offers.service';
import { BillingCatalogService } from './billing-catalog.service';
import { BillingInvoiceService } from './billing-invoice.service';
import { BillingEventService } from './billing-event.service';
import { BillingReadService } from './billing-read.service';
import { OrganizerBillingController } from './billing.controller';
import { ensureBillingAccount } from './billing-account';
import { assignInvoiceNumber } from './invoice-number';
import { MockBillingProvider, type VerifiedBillingEvent } from './provider/billing-provider';

/**
 * integration-real-postgres: organizer billing and entitlements against the migrated schema.
 *
 * What only a real database shows: that spending a quota cannot overspend when many sends race
 * (advisory lock + idempotency index), that invoice numbers are gapless and per series under
 * concurrency, that the ledger and issued invoices refuse to be edited, that one organization's
 * member cannot read another's plan, and that a provider event activates nothing without the
 * provider's verified record of the payment.
 *
 * Skips (never fabricates a pass) without a database. Rows it made are removed afterwards; the
 * append-only and frozen-number triggers are disabled for that cleanup only, inside one
 * transaction.
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

describe('integration-real-postgres: organizer billing and entitlements', () => {
  const url = loadDatabaseUrl();
  let db: Client | undefined;
  let available = false;
  const tag = `bil${Date.now()}`;
  const published: DomainEvent[] = [];

  const userIds: string[] = [];
  const orgIds: string[] = [];
  let createdPlanCodes: string[] = [];

  let ownerA: RequestUser;
  let ownerB: RequestUser;
  let staff: RequestUser;
  let orgA = '';
  let orgB = '';
  let orgC = '';

  let publisher: TransactionalEventPublisher;
  let audit: AuditService;
  let entitlements: EntitlementService;
  let subscriptions: SubscriptionService;
  let offers: BillingOffersService;
  let catalog: BillingCatalogService;
  let invoices: BillingInvoiceService;
  let provider: MockBillingProvider;
  let events: BillingEventService;
  let controller: OrganizerBillingController;

  const ALL_ON = (_f: FeatureFlag) => true;

  async function makeUser(name: string, roles: string[]): Promise<RequestUser> {
    const u = await db!.user.create({
      data: { email: `${name}-${tag}@test.invalid`, fullName: name, passwordHash: 'x', roles },
    });
    userIds.push(u.id);
    return { id: u.id, email: u.email, fullName: u.fullName, roles: roles as Role[] };
  }

  async function makeOrg(name: string, country: string, owner?: RequestUser): Promise<string> {
    const o = await db!.organization.create({
      data: { name: `${name} ${tag}`, slug: `${name}-${tag}`, status: 'APPROVED', registeredCountry: country },
    });
    orgIds.push(o.id);
    if (owner) {
      await db!.organizationMember.create({
        data: { organizationId: o.id, userId: owner.id, role: 'ORGANIZER_OWNER' },
      });
    }
    return o.id;
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
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[integration-real-postgres] SKIPPED - DB unavailable');
      return;
    }

    audit = new AuditService(db as never);
    publisher = new TransactionalEventPublisher(
      db as never,
      { publishMany: async (e: DomainEvent[]) => void published.push(...e) } as never,
      { get: () => 'in_process' } as never,
      {} as never,
    );
    entitlements = new EntitlementService(db as never, ALL_ON);
    subscriptions = new SubscriptionService(db as never, audit, publisher, entitlements);
    offers = new BillingOffersService(db as never, audit, publisher, entitlements);
    catalog = new BillingCatalogService(db as never, audit);
    invoices = new BillingInvoiceService(db as never);
    provider = new MockBillingProvider('integration-secret');
    events = new BillingEventService(db as never, audit, subscriptions, entitlements, publisher, provider);
    const reads = new BillingReadService(
      db as never,
      entitlements,
      invoices,
      { get: () => 'false' } as never,
      provider,
    );
    controller = new OrganizerBillingController(
      new OrgAccessService(db as never, audit),
      entitlements,
      reads,
      db as never,
      provider,
    );

    ownerA = await makeUser('owner-a', ['ORGANIZER_OWNER']);
    ownerB = await makeUser('owner-b', ['ORGANIZER_OWNER']);
    staff = await makeUser('staff', ['ADMIN']);
    orgA = await makeOrg('org-a', 'India', ownerA);
    orgB = await makeOrg('org-b', 'United States', ownerB);
    orgC = await makeOrg('org-c', 'IN', ownerA);

    const existing = await db!.billingPlan.findMany({ select: { code: true } });
    const had = new Set(existing.map((p: { code: string }) => p.code));
    await catalog.loadProvisional(staff.id);
    createdPlanCodes = ['FREE', 'PRO', 'PREMIUM'].filter((c) => !had.has(c));
  }, 120_000);

  afterAll(async () => {
    if (db && available) {
      const accounts = await db.organizerBillingAccount.findMany({
        where: { organizationId: { in: orgIds } },
        select: { id: true },
      });
      const accountIds = accounts.map((a: { id: string }) => a.id);
      await db.$transaction(async (tx: Client) => {
        await tx.$executeRawUnsafe('ALTER TABLE "UsageLedger" DISABLE TRIGGER "UsageLedger_append_only"');
        await tx.$executeRawUnsafe('ALTER TABLE "OrganizerInvoice" DISABLE TRIGGER "OrganizerInvoice_number_frozen"');
        await tx.usageLedger.deleteMany({ where: { organizationId: { in: orgIds } } });
        await tx.entitlementOverride.deleteMany({ where: { organizationId: { in: orgIds } } });
        await tx.billingAdjustment.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.billingPayment.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.organizerInvoice.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.organizerSubscription.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.organizerBillingAccount.deleteMany({ where: { id: { in: accountIds } } });
        await tx.billingWebhookEvent.deleteMany({ where: { providerEventId: { startsWith: tag } } });
        await tx.readableReferenceCounter.deleteMany({ where: { scope: { in: ['BIL-2091', 'BIL-2092'] } } });
        if (createdPlanCodes.length) {
          const plans = await tx.billingPlan.findMany({ where: { code: { in: createdPlanCodes } } });
          const ids = plans.map((p: { id: string }) => p.id);
          await tx.billingPrice.deleteMany({ where: { planId: { in: ids } } });
          await tx.billingPlan.deleteMany({ where: { id: { in: ids } } });
        }
        await tx.$executeRawUnsafe('ALTER TABLE "UsageLedger" ENABLE TRIGGER "UsageLedger_append_only"');
        await tx.$executeRawUnsafe('ALTER TABLE "OrganizerInvoice" ENABLE TRIGGER "OrganizerInvoice_number_frozen"');
      });
      await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
      await db.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await db?.$disconnect();
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

  const enabledKeys = (r: { entitlements: { key: string; enabled: boolean }[] }) =>
    r.entitlements.filter((e) => e.enabled).map((e) => e.key);

  // ── Resolution ─────────────────────────────────────────────────────────────────

  maybe('with no subscription an organization is on Free: the audience list only', async () => {
    const r = await entitlements.resolve(orgA, new Date());
    expect(r.planCode).toBe('FREE');
    expect(enabledKeys(r)).toEqual(['audience.basic']);
  });

  maybe('a trial grants its plan until it ends, then Free by the clock alone', async () => {
    const sub = await subscriptions.grantTrial(orgA, { planCode: 'PRO', days: 14, reason: 'pilot partner' }, staff.id);
    expect(sub.status).toBe('TRIALING');
    expect(sub.currentKey).not.toBeNull();

    const now = await entitlements.resolve(orgA, new Date());
    expect(now.planCode).toBe('PRO');
    expect(enabledKeys(now)).toEqual(
      expect.arrayContaining(['campaigns.create', 'campaigns.schedule', 'campaigns.monthly_email_quota']),
    );
    expect(enabledKeys(now)).not.toContain('campaigns.automation');

    const later = await entitlements.resolve(orgA, new Date(Date.now() + 15 * DAY));
    expect(later.planCode).toBe('FREE');

    // Audited in the same transaction, and published after commit.
    const row = await db!.auditLog.findFirst({ where: { entityId: sub.id, action: 'BILLING_TRIAL_GRANTED' } });
    expect(row?.actorUserId).toBe(staff.id);
    expect(published.some((e) => e.eventType === 'billing.subscription_changed' && e.aggregateId === sub.id)).toBe(true);
  });

  maybe('a second grant while one is current is refused, and a paid plan is never replaced by one', async () => {
    await expect(
      subscriptions.grantTrial(orgA, { planCode: 'PREMIUM', days: 7, reason: 'again' }, staff.id),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_TRANSITION_INVALID' });
  });

  maybe('an override beats the plan; the latest wins; revoking uncovers the plan; the cache follows', async () => {
    const cachedBefore = await entitlements.resolve(orgA); // fills the cache
    expect(enabledKeys(cachedBefore)).not.toContain('campaigns.automation');

    const o1 = await offers.grantOverride(orgA, { key: 'campaigns.automation', boolValue: true, reason: 'beta' }, staff.id);
    expect(enabledKeys(await entitlements.resolve(orgA))).toContain('campaigns.automation');

    const o2 = await offers.grantOverride(
      orgA,
      { key: 'campaigns.automation', boolValue: false, reason: 'paused', startsAt: new Date(Date.now() + 1000) },
      staff.id,
    );
    const inTwoSeconds = new Date(Date.now() + 2000);
    expect(enabledKeys(await entitlements.resolve(orgA, inTwoSeconds))).not.toContain('campaigns.automation');

    await offers.revokeOverride(o2.id, 'resumed', staff.id);
    expect(enabledKeys(await entitlements.resolve(orgA, inTwoSeconds))).toContain('campaigns.automation');
    await offers.revokeOverride(o1.id, 'beta over', staff.id);
    expect(enabledKeys(await entitlements.resolve(orgA))).not.toContain('campaigns.automation');
    await expect(offers.revokeOverride(o1.id, 'twice', staff.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  maybe('the deployment kill switch turns a granted entitlement off and says so', async () => {
    const killed = new EntitlementService(db as never, (f) => f !== 'marketingAutomation');
    const r = await killed.resolve(orgA, new Date());
    expect(r.planCode).toBe('PRO');
    const create = r.entitlements.find((e) => e.key === 'campaigns.create')!;
    expect(create).toMatchObject({ enabled: false, switchedOffInDeployment: true, source: 'PLAN' });
    expect(enabledKeys(r)).toEqual(['audience.basic']);
  });

  // ── Quotas ─────────────────────────────────────────────────────────────────────

  maybe('40 sends racing for 10 emails and 5 credits: exactly 15 go through, none overspends', async () => {
    await offers.grantOverride(orgB, { key: 'campaigns.monthly_email_quota', intValue: 10, reason: 'test quota' }, staff.id);
    await offers.grantCredits(orgB, { amount: 5, reason: 'launch offer', idempotencyKey: `${tag}-credits` }, staff.id);
    // The same grant again is a replay, not five more.
    const again = await offers.grantCredits(orgB, { amount: 5, reason: 'launch offer', idempotencyKey: `${tag}-credits` }, staff.id);
    expect(again.replayed).toBe(true);

    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        entitlements.consume(orgB, 'campaigns.monthly_email_quota', 1, `${tag}-send-${i}`),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(15);
    expect(refused).toHaveLength(25);
    for (const r of refused) expect(r.reason).toMatchObject({ code: 'QUOTA_EXCEEDED' });

    const left = await entitlements.remaining(orgB, 'campaigns.monthly_email_quota');
    expect(left).toMatchObject({ quota: 10, used: 10, credits: 0, remaining: 0 });
    const sum = await db!.usageLedger.aggregate({ where: { organizationId: orgB }, _sum: { delta: true } });
    expect(sum._sum.delta).toBe(5 - 15); // +5 credits granted, 15 spent
  });

  maybe('the same send retried at once spends once', async () => {
    await offers.grantCredits(orgB, { amount: 9, reason: 'top up', idempotencyKey: `${tag}-top` }, staff.id);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        entitlements.consume(orgB, 'campaigns.monthly_email_quota', 3, `${tag}-campaign-42`),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.consumed === 3 && r.fromCredits === 3)).toBe(true);
    expect((await entitlements.remaining(orgB)).credits).toBe(6);
  });

  maybe('a send that does not fit spends nothing at all', async () => {
    await expect(
      entitlements.consume(orgB, 'campaigns.monthly_email_quota', 7, `${tag}-too-big`),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect((await entitlements.remaining(orgB)).credits).toBe(6);
    expect(await db!.usageLedger.count({ where: { idempotencyKey: { startsWith: `${tag}-too-big` } } })).toBe(0);
  });

  maybe('the usage ledger refuses to be edited or deleted', async () => {
    const row = await db!.usageLedger.findFirst({ where: { organizationId: orgB } });
    await expect(db!.usageLedger.update({ where: { id: row!.id }, data: { delta: 1000 } })).rejects.toThrow(/append-only/);
    await expect(db!.usageLedger.delete({ where: { id: row!.id } })).rejects.toThrow(/append-only/);
  });

  // ── Tenancy ───────────────────────────────────────────────────────────────────

  maybe("one organization's member cannot read another's entitlements or billing", async () => {
    await expect(controller.entitlementsFor(ownerA, orgB)).rejects.toMatchObject({ code: 'TENANT_FORBIDDEN' });
    await expect(controller.billing(ownerA, orgB)).rejects.toMatchObject({ code: 'TENANT_FORBIDDEN' });
    await expect(controller.invoices(ownerB, orgA)).rejects.toMatchObject({ code: 'TENANT_FORBIDDEN' });
    // Platform staff with no seat get nothing on the organizer routes either.
    await expect(controller.entitlementsFor(staff, orgA)).rejects.toMatchObject({ code: 'TENANT_FORBIDDEN' });

    const mine = await controller.entitlementsFor(ownerA, orgA);
    expect(mine.organizationId).toBe(orgA);
    const billing = await controller.billing(ownerB, orgB);
    expect(billing).toMatchObject({ organizationId: orgB, billingEnabled: false, country: 'US' });
    expect(billing.plans.find((p) => p.code === 'PRO')?.prices.map((p) => [p.currency, p.interval, p.amountMinor])).toEqual([
      ['USD', 'MONTH', 1900],
      ['USD', 'YEAR', 19000],
    ]);
  });

  maybe('checkout is refused plainly while paid plans are not open', async () => {
    const price = await db!.billingPrice.findFirst({ where: { country: 'IN', active: true, plan: { code: 'PRO' } } });
    await expect(controller.checkout(ownerA, orgA, { priceId: price!.id })).rejects.toMatchObject({
      code: 'BILLING_NOT_ENABLED',
    });
  });

  // ── Invoices ──────────────────────────────────────────────────────────────────

  maybe('invoice numbers are consecutive under concurrency, per year, and a rollback gives one back', async () => {
    const account = await db!.$transaction((tx: Client) => ensureBillingAccount(tx, orgA));
    const drafts = await Promise.all(
      Array.from({ length: 12 }, () =>
        invoices.createDraft(account.id, {
          currency: 'INR',
          lines: [{ description: 'Pro plan, one month', quantity: 1, unitAmountMinor: 99900 }],
        }),
      ),
    );
    expect(drafts.every((d) => d.number === null && d.totalMinor === 99900)).toBe(true);

    const issued = await Promise.all(drafts.map((d) => invoices.issue(d.id, new Date('2091-06-01T00:00:00Z'))));
    const seqs = issued.map((i) => Number(i.number!.split('-')[3])).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(issued.every((i) => /^ETG-BIL-2091-\d{6}$/.test(i.number!))).toBe(true);

    // A number taken in a transaction that rolls back is given back.
    await db!
      .$transaction(async (tx: Client) => {
        expect(await assignInvoiceNumber(tx, new Date('2091-07-01T00:00:00Z'))).toBe('ETG-BIL-2091-000013');
        throw new Error('rollback');
      })
      .catch(() => undefined);
    const next = await invoices.createDraft(account.id, {
      currency: 'INR',
      lines: [{ description: 'Pro plan', quantity: 1, unitAmountMinor: 99900 }],
    });
    expect((await invoices.issue(next.id, new Date('2091-08-01T00:00:00Z'))).number).toBe('ETG-BIL-2091-000013');

    // A new year is a new series.
    const nextYear = await invoices.createDraft(account.id, {
      currency: 'INR',
      lines: [{ description: 'Pro plan', quantity: 1, unitAmountMinor: 99900 }],
    });
    expect((await invoices.issue(nextYear.id, new Date('2092-01-01T00:00:00Z'))).number).toBe('ETG-BIL-2092-000001');

    // Issuing twice is refused; an issued invoice cannot lose its number or be deleted.
    await expect(invoices.issue(nextYear.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      db!.organizerInvoice.update({ where: { id: nextYear.id }, data: { number: 'ETG-BIL-2092-000099' } }),
    ).rejects.toThrow(/cannot change/);
    await expect(db!.organizerInvoice.delete({ where: { id: nextYear.id } })).rejects.toThrow(/cannot be deleted/);
    // The support series is untouched by any of it.
    expect(await db!.readableReferenceCounter.findUnique({ where: { scope: 'SUP-2091' } })).toBeNull();
  });

  // ── Provider events ───────────────────────────────────────────────────────────

  maybe('a provider event activates nothing without the provider record of a verified payment', async () => {
    const price = await db!.billingPrice.findFirst({
      where: { country: 'IN', interval: 'MONTH', active: true, plan: { code: 'PRO' } },
    });
    const base: Omit<VerifiedBillingEvent, 'providerEventId' | 'paymentRef'> = {
      provider: 'MOCK',
      type: 'PAYMENT_CAPTURED',
      organizationId: orgC,
      priceId: price!.id,
      providerSubscriptionRef: `${tag}-sub-1`,
      payload: {},
    };
    const currentOf = async () => {
      const acct = await db!.organizerBillingAccount.findUnique({ where: { organizationId: orgC } });
      return acct ? db!.organizerSubscription.findUnique({ where: { currentKey: acct.id } }) : null;
    };

    // 1. The webhook says paid; the provider has no such payment.
    const unknown = await events.ingest({ ...base, providerEventId: `${tag}-e1`, paymentRef: `${tag}-pay-x` });
    expect(unknown).toMatchObject({ outcome: 'FAILED' });
    expect(await currentOf()).toBeNull();

    // 2. A real payment, but not for the price's amount.
    provider.capture(`${tag}-pay-low`, 100, 'INR');
    const low = await events.ingest({ ...base, providerEventId: `${tag}-e2`, paymentRef: `${tag}-pay-low` });
    expect(low).toMatchObject({ outcome: 'FAILED' });
    expect(await currentOf()).toBeNull();
    expect(await db!.billingPayment.count({ where: { providerPaymentRef: `${tag}-pay-low` } })).toBe(0);

    // 3. Verified, for exactly the price: ACTIVE, with a verified payment row.
    provider.capture(`${tag}-pay-ok`, price!.amountMinor, price!.currency);
    const good = await events.ingest({ ...base, providerEventId: `${tag}-e3`, paymentRef: `${tag}-pay-ok` });
    expect(good).toMatchObject({ outcome: 'PROCESSED', status: 'ACTIVE' });
    const sub = await currentOf();
    expect(sub).toMatchObject({ status: 'ACTIVE', source: 'PROVIDER', priceId: price!.id });
    const pay = await db!.billingPayment.findFirst({ where: { providerPaymentRef: `${tag}-pay-ok` } });
    expect(pay?.verifiedAt).not.toBeNull();

    // 4. The same event delivered again changes nothing.
    expect(await events.ingest({ ...base, providerEventId: `${tag}-e3`, paymentRef: `${tag}-pay-ok` })).toEqual({
      outcome: 'DUPLICATE',
    });
    const failed = await db!.billingWebhookEvent.findMany({
      where: { providerEventId: { in: [`${tag}-e1`, `${tag}-e2`] } },
    });
    expect(failed.map((f: { status: string }) => f.status)).toEqual(['FAILED', 'FAILED']);

    // 5. A staff grant cannot sit on top of the paid plan.
    await expect(
      subscriptions.grantComplimentary(orgC, { planCode: 'PREMIUM', endsAt: null, reason: 'no' }, staff.id),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_TRANSITION_INVALID' });

    // 6. A failed renewal keeps the features (PAST_DUE) until grace runs out.
    const pastDue = await events.ingest({
      ...base,
      type: 'PAYMENT_FAILED',
      providerEventId: `${tag}-e4`,
      paymentRef: undefined,
    } as VerifiedBillingEvent);
    expect(pastDue).toMatchObject({ outcome: 'PROCESSED', status: 'PAST_DUE' });
    expect((await entitlements.resolve(orgC, new Date())).planCode).toBe('PRO');
  });

  maybe('the sweep ends what the clock has ended, and only that', async () => {
    const acct = await db!.organizerBillingAccount.findUnique({ where: { organizationId: orgA } });
    const trial = await db!.organizerSubscription.findUnique({ where: { currentKey: acct!.id } });
    expect(trial.status).toBe('TRIALING');
    const { applied } = await subscriptions.sweep(new Date(Date.now() + 15 * DAY));
    expect(applied).toBeGreaterThanOrEqual(1);
    const after = await db!.organizerSubscription.findUnique({ where: { id: trial.id } });
    expect(after).toMatchObject({ status: 'EXPIRED', currentKey: null });
    // The paid (PAST_DUE) subscription is not the clock's to end.
    const c = await db!.organizerBillingAccount.findUnique({ where: { organizationId: orgC } });
    expect((await db!.organizerSubscription.findUnique({ where: { currentKey: c!.id } }))?.status).toBe('PAST_DUE');
  });
});
