import { Reflector } from '@nestjs/core';
import { Controller, Get } from '@nestjs/common';
import { BillingReadService, monthlyEquivalentMinor } from './billing-read.service';
import { billingCountryOf } from './billing-account';
import { formatInvoiceNumber, invoiceNumberScope } from './invoice-number';
import {
  BILLING_NOT_ENABLED_MESSAGE,
  DisabledBillingProvider,
  MockBillingProvider,
} from './provider/billing-provider';
import { EntitlementGuard, RequiresEntitlement } from './entitlements/requires-entitlement';

describe('billing metrics are computed from stored subscriptions only', () => {
  const stub = (current: unknown[] = [], invoices: unknown[] = [], counts: number[] = [0, 0]) => {
    let c = 0;
    return {
      organizerSubscription: {
        findMany: async () => current,
        count: async () => counts[c++] ?? 0,
      },
      organizerInvoice: { findMany: async () => invoices },
    };
  };
  const svc = (prisma: unknown) =>
    new BillingReadService(prisma as never, {} as never, {} as never, { get: () => 'false' } as never, new DisabledBillingProvider());

  it('with nothing paid, says zero honestly: no MRR rows, no revenue, churn unknown', async () => {
    const m = await svc(stub()).metrics(30);
    expect(m).toMatchObject({
      paidSubscriptions: 0,
      trials: 0,
      complimentary: 0,
      mrr: [],
      mrrByPlan: [],
      revenueByPlan: [],
      churn: { cancellations: 0, paidAtStart: 0, rate: null },
    });
  });

  it('counts trials and complimentary plans but never as revenue, and never adds currencies', async () => {
    const price = (amountMinor: number, currency: string, interval: 'MONTH' | 'YEAR') => ({
      amountMinor,
      currency,
      interval,
    });
    const current = [
      { status: 'ACTIVE', source: 'PROVIDER', plan: { code: 'PRO' }, price: price(99900, 'INR', 'MONTH') },
      { status: 'PAST_DUE', source: 'PROVIDER', plan: { code: 'PRO' }, price: price(999000, 'INR', 'YEAR') },
      { status: 'ACTIVE', source: 'PROVIDER', plan: { code: 'PREMIUM' }, price: price(4900, 'USD', 'MONTH') },
      { status: 'TRIALING', source: 'TRIAL', plan: { code: 'PRO' }, price: null },
      { status: 'COMPLIMENTARY', source: 'ADMIN_COMPLIMENTARY', plan: { code: 'PREMIUM' }, price: null },
    ];
    const m = await svc(stub(current, [], [1, 4])).metrics(30);
    expect(m.paidSubscriptions).toBe(3);
    expect(m.trials).toBe(1);
    expect(m.complimentary).toBe(1);
    expect(m.mrr).toEqual(
      expect.arrayContaining([
        { currency: 'INR', mrrMinor: 99900 + 83250, subscriptions: 2, arrMinor: (99900 + 83250) * 12 },
        { currency: 'USD', mrrMinor: 4900, subscriptions: 1, arrMinor: 4900 * 12 },
      ]),
    );
    expect(m.churn).toEqual({ cancellations: 1, paidAtStart: 4, rate: 0.25 });
  });

  it('spreads a yearly price over twelve months', () => {
    expect(monthlyEquivalentMinor(1900, 'MONTH')).toBe(1900);
    expect(monthlyEquivalentMinor(19000, 'YEAR')).toBe(1583);
  });
});

describe('billing country follows the organizer, never a guess', () => {
  it.each([
    ['India', 'IN'],
    ['in', 'IN'],
    ['United States', 'US'],
    ['USA', 'US'],
    ['', null],
    [null, null],
    ['Atlantis', null],
  ])('%s -> %s', (raw, expected) => {
    expect(billingCountryOf(raw as string | null)).toBe(expected);
  });
});

describe('invoice number shape', () => {
  it('is ETG-BIL-<YEAR>-<SEQ>, six digits at least, on its own counter scope', () => {
    expect(formatInvoiceNumber(2026, 1)).toBe('ETG-BIL-2026-000001');
    expect(formatInvoiceNumber(2026, 1234567)).toBe('ETG-BIL-2026-1234567');
    expect(invoiceNumberScope(2026)).toBe('BIL-2026');
  });
});

describe('billing providers', () => {
  it('the disabled provider refuses checkout, webhooks and payment lookups in plain words', async () => {
    const p = new DisabledBillingProvider();
    expect(p.enabled).toBe(false);
    for (const call of [
      () => p.createCheckout(),
      () => p.verifyWebhook(),
      () => p.fetchPayment(),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'BILLING_NOT_ENABLED' });
    }
    expect(BILLING_NOT_ENABLED_MESSAGE).toMatch(/^[\x20-\x7e]+$/);
  });

  it('the test double refuses an event whose signature does not match', async () => {
    const p = new MockBillingProvider('s3cret');
    const body = JSON.stringify({ providerEventId: 'e1', type: 'PAYMENT_CAPTURED', organizationId: 'o1' });
    await expect(p.verifyWebhook(body, { 'x-mock-billing-signature': 'nope' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      p.verifyWebhook(body, { 'x-mock-billing-signature': new MockBillingProvider('other').sign(body) }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const ok = await p.verifyWebhook(body, { 'x-mock-billing-signature': p.sign(body) });
    expect(ok).toMatchObject({ provider: 'MOCK', providerEventId: 'e1' });
    // Verified signature, but no payment the provider knows of: a claim only.
    expect((await p.fetchPayment('pay_unknown')).verified).toBe(false);
  });
});

describe('@RequiresEntitlement checks membership first, then the entitlement, on the server', () => {
  @Controller('t')
  class Probe {
    @Get(':organizationId/send')
    @RequiresEntitlement('campaigns.create')
    send() {
      return 'sent';
    }
  }

  function ctx(params: Record<string, string>) {
    return {
      getHandler: () => Probe.prototype.send,
      getClass: () => Probe,
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: 'u1', roles: ['ORGANIZER_OWNER'] }, params }),
      }),
    } as never;
  }

  it('refuses a non-member before it looks at any plan', async () => {
    const entitlements = { assert: jest.fn() };
    const guard = new EntitlementGuard(
      new Reflector(),
      { assertMember: jest.fn().mockRejectedValue(Object.assign(new Error('no'), { code: 'TENANT_FORBIDDEN' })) } as never,
      entitlements as never,
    );
    await expect(guard.canActivate(ctx({ organizationId: 'o2' }))).rejects.toMatchObject({ code: 'TENANT_FORBIDDEN' });
    expect(entitlements.assert).not.toHaveBeenCalled();
  });

  it('refuses a member whose plan lacks it, and lets one whose plan has it through', async () => {
    const assertMember = jest.fn().mockResolvedValue(undefined);
    const refusing = new EntitlementGuard(new Reflector(), { assertMember } as never, {
      assert: jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'ENTITLEMENT_REQUIRED' })),
    } as never);
    await expect(refusing.canActivate(ctx({ organizationId: 'o1' }))).rejects.toMatchObject({
      code: 'ENTITLEMENT_REQUIRED',
    });
    const allowing = new EntitlementGuard(new Reflector(), { assertMember } as never, {
      assert: jest.fn().mockResolvedValue(undefined),
    } as never);
    await expect(allowing.canActivate(ctx({ organizationId: 'o1' }))).resolves.toBe(true);
    expect(assertMember).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'o1', undefined);
  });

  it('refuses when the route names no organization', async () => {
    const guard = new EntitlementGuard(new Reflector(), { assertMember: jest.fn() } as never, {} as never);
    await expect(guard.canActivate(ctx({}))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
