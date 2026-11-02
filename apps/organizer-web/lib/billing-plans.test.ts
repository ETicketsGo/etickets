import { describe, expect, it } from 'vitest';
import { PROVISIONAL_PLAN_ENTITLEMENTS } from '@eticketsgo/shared-types';
import type { OrganizerBilling } from '@eticketsgo/web-kit';
import {
  ASK_DIALOG_TEXT,
  CANCEL_DIALOG_TEXT,
  DISPUTED_NOTICE,
  NO_INVOICES,
  PAID_PLANS_CLOSED,
  PAYMENT_CONFIRMED,
  PAYMENT_NOT_CONFIRMED_YET,
  RETURN_MESSAGES,
  CHECKOUT_EXPIRED,
  CHECKOUT_FAILED,
  CHECKOUT_PROCESSING,
  PAY_IN_NEW_TAB,
  PAYMENT_TAB_BLOCKED,
  QUOTE_MISMATCH,
  REFRESH_STATUS_LABEL,
  checkoutReturn,
  checkoutStatusPanel,
  purchasablePrices,
  quoteCanContinue,
  quoteRows,
  paidPlanConfirmed,
  paidPlanControls,
  planFeatureLines,
  planStatusSentence,
  priceLabel,
  upgradeAction,
  usageSentence,
} from './billing-plans';

const sub = (patch: Partial<NonNullable<OrganizerBilling['subscription']>>) => ({
  status: 'ACTIVE' as const,
  source: 'PROVIDER' as const,
  planCode: 'PRO' as const,
  currentPeriodEnd: '2026-11-30T12:00:00Z',
  trialEndsAt: null,
  graceEndsAt: null,
  cancelAtPeriodEnd: false,
  scheduledPlanCode: null,
  ...patch,
});

const ASCII = /^[\x20-\x7e]*$/;

describe('Billing & plans words', () => {
  it('says Free plainly when there is no subscription', () => {
    expect(planStatusSentence({ subscription: null, currentPlanCode: 'FREE' })).toMatch(
      /Free plan/,
    );
  });

  it('names the trial and its end', () => {
    const s = planStatusSentence({
      subscription: sub({ status: 'TRIALING', trialEndsAt: '2026-11-10T12:00:00Z' }),
      currentPlanCode: 'PRO',
    });
    expect(s).toBe('You are trying Pro free of charge until 10 November 2026.');
  });

  it('says when a free period has ended even if the status has not caught up', () => {
    expect(
      planStatusSentence({ subscription: sub({ status: 'TRIALING' }), currentPlanCode: 'FREE' }),
    ).toMatch(/free period has ended/);
  });

  it('covers complimentary, renewal, cancelling, payment failed and grace', () => {
    const sentences = [
      sub({ status: 'COMPLIMENTARY', currentPeriodEnd: null, source: 'ADMIN_COMPLIMENTARY' }),
      sub({ status: 'ACTIVE' }),
      sub({ status: 'ACTIVE', cancelAtPeriodEnd: true }),
      sub({ status: 'PAST_DUE' }),
      sub({ status: 'GRACE', graceEndsAt: '2026-12-05T12:00:00Z' }),
    ].map((s) => planStatusSentence({ subscription: s, currentPlanCode: 'PRO' }));
    expect(sentences).toEqual([
      'ETicketsGo gave you Pro free of charge.',
      'Your Pro plan renews on 30 November 2026.',
      'Your Pro plan ends on 30 November 2026. It will not renew.',
      'Your last Pro payment did not go through. You keep Pro while it is tried again.',
      'Your Pro payment did not go through. You keep Pro until 5 December 2026.',
    ]);
    for (const s of sentences) expect(s).toMatch(ASCII);
  });

  it('lists what a plan includes, with the email number', () => {
    expect(
      planFeatureLines({
        entitlements: PROVISIONAL_PLAN_ENTITLEMENTS.PRO.map((e) => ({
          key: e.key,
          boolValue: e.boolValue ?? null,
          intValue: e.intValue ?? null,
        })),
      }),
    ).toEqual([
      'Audience list',
      'Email campaigns',
      'Scheduled sending',
      'Campaign results',
      '2,000 campaign emails a month',
    ]);
  });

  it('prices read per month or per year', () => {
    expect(
      priceLabel({
        id: 'p',
        interval: 'MONTH',
        amountMinor: 1900,
        currency: 'USD',
        trialDays: null,
      }),
    ).toMatch(/19\.00 a month$/);
    expect(
      priceLabel({
        id: 'p',
        interval: 'YEAR',
        amountMinor: 19000,
        currency: 'USD',
        trialDays: null,
      }),
    ).toMatch(/190\.00 a year$/);
  });

  it('an Indian price says GST is added on top, without naming a rate', () => {
    const label = priceLabel({
      id: 'p',
      interval: 'MONTH',
      amountMinor: 99900,
      currency: 'INR',
      trialDays: null,
    });
    expect(label).toMatch(/999 a month \+ applicable GST$/);
    expect(label).not.toMatch(/18|%/);
    expect(
      priceLabel({
        id: 'p',
        interval: 'YEAR',
        amountMinor: 999000,
        currency: 'INR',
        trialDays: null,
      }),
    ).toMatch(/9,990 a year \+ applicable GST$/);
  });

  it('never offers a dead button: closed billing asks, open billing with a price checks out', () => {
    const pro = {
      code: 'PRO' as const,
      prices: [
        {
          id: 'p',
          interval: 'MONTH' as const,
          amountMinor: 99900,
          currency: 'INR',
          trialDays: null,
        },
      ],
    };
    expect(upgradeAction({ billingEnabled: false, currentPlanCode: 'FREE' }, pro)).toEqual({
      kind: 'ask',
      label: 'Ask about Pro',
    });
    expect(upgradeAction({ billingEnabled: true, currentPlanCode: 'FREE' }, pro)).toEqual({
      kind: 'checkout',
      label: 'Upgrade to Pro',
    });
    // Open, but nothing of this plan can be bought here: a plain sentence, no button.
    expect(
      upgradeAction({ billingEnabled: true, currentPlanCode: 'FREE' }, { ...pro, prices: [] }),
    ).toEqual({ kind: 'unavailable', label: 'Pro is not available to buy yet in your country.' });
    expect(upgradeAction({ billingEnabled: false, currentPlanCode: 'PRO' }, pro).kind).toBe(
      'current',
    );
    expect(
      upgradeAction({ billingEnabled: false, currentPlanCode: 'PRO' }, { code: 'FREE', prices: [] })
        .kind,
    ).toBe('none');
  });

  it('counts usage in words', () => {
    expect(
      usageSentence({
        key: 'k',
        periodKey: '2026-10',
        quota: 0,
        used: 0,
        credits: 0,
        remaining: 0,
      }),
    ).toBe('Your plan includes no campaign emails.');
    expect(
      usageSentence({
        key: 'k',
        periodKey: '2026-10',
        quota: 2000,
        used: 150,
        credits: 500,
        remaining: 2350,
      }),
    ).toBe('150 of 2,000 emails used this month, 500 extra credits. 2,350 left.');
  });

  it('writes every fixed sentence in plain ASCII', () => {
    for (const s of [PAID_PLANS_CLOSED, ASK_DIALOG_TEXT, NO_INVOICES]) expect(s).toMatch(ASCII);
  });
});

describe('paying through a provider', () => {
  it('reads the redirect as a hint only', () => {
    expect(checkoutReturn('?checkout=success')).toBe('plan-success');
    expect(checkoutReturn('?checkout=cancelled')).toBe('plan-cancelled');
    expect(checkoutReturn('?credits=success')).toBe('credits-success');
    expect(checkoutReturn('?portal=returned')).toBe('portal');
    expect(checkoutReturn('')).toBeNull();
    expect(checkoutReturn('?checkout=paid')).toBeNull();
  });

  it('calls a plan confirmed only when the server reports a provider plan ACTIVE', () => {
    expect(paidPlanConfirmed({ subscription: sub({}) })).toBe(true);
    expect(paidPlanConfirmed({ subscription: null })).toBe(false);
    expect(paidPlanConfirmed({ subscription: sub({ status: 'PAST_DUE' }) })).toBe(false);
    // A staff trial is not a payment, whatever the redirect said.
    expect(paidPlanConfirmed({ subscription: sub({ status: 'TRIALING', source: 'TRIAL' }) })).toBe(
      false,
    );
  });

  it('offers the portal only for Stripe, and cancel only while the plan still renews', () => {
    expect(paidPlanControls({ subscription: sub({}), provider: 'STRIPE_BILLING' })).toEqual({
      portal: true,
      cancel: true,
    });
    expect(paidPlanControls({ subscription: sub({}), provider: 'RAZORPAY_BILLING' })).toEqual({
      portal: false,
      cancel: true,
    });
    expect(
      paidPlanControls({
        subscription: sub({ cancelAtPeriodEnd: true }),
        provider: 'STRIPE_BILLING',
      }),
    ).toEqual({ portal: true, cancel: false });
    expect(
      paidPlanControls({
        subscription: sub({ status: 'COMPLIMENTARY', source: 'ADMIN_COMPLIMENTARY' }),
        provider: 'NONE',
      }),
    ).toEqual({ portal: false, cancel: false });
  });

  it('hides Premium when its price has no provider plan here', () => {
    const premium = {
      code: 'PREMIUM' as const,
      prices: [
        {
          id: 'pm',
          interval: 'MONTH' as const,
          amountMinor: 249900,
          currency: 'INR',
          trialDays: null,
          purchasable: false,
        },
        {
          id: 'py',
          interval: 'YEAR' as const,
          amountMinor: 2499000,
          currency: 'INR',
          trialDays: null,
          purchasable: false,
        },
      ],
    };
    expect(upgradeAction({ billingEnabled: true, currentPlanCode: 'PRO' }, premium)).toEqual({
      kind: 'unavailable',
      label: 'Premium is not available to buy yet in your country.',
    });
    // One interval set up, the other not: only that one is offered.
    const oneReady = {
      ...premium,
      prices: [{ ...premium.prices[0], purchasable: true }, premium.prices[1]],
    };
    expect(upgradeAction({ billingEnabled: true, currentPlanCode: 'PRO' }, oneReady).kind).toBe(
      'checkout',
    );
    expect(purchasablePrices(oneReady).map((p) => p.id)).toEqual(['pm']);
  });

  it('shows the quote itemised, with each rate from the server, and the total', () => {
    const quote = {
      priceId: 'p',
      interval: 'MONTH' as const,
      currency: 'INR',
      mode: 'MANUAL' as const,
      netMinor: 99900,
      taxMinor: 17982,
      totalMinor: 117882,
      lines: [
        { label: 'CGST', rateBasisPoints: 900, amountMinor: 8991 },
        { label: 'SGST', rateBasisPoints: 900, amountMinor: 8991 },
      ],
      placeOfSupply: 'Telangana',
      interState: false,
      providerChargeMinor: 117882,
      chargeMatches: true,
    };
    const rows = quoteRows(quote);
    expect(rows.map((r) => r.label)).toEqual([
      'Plan price',
      'CGST (9%)',
      'SGST (9%)',
      'Total a month',
    ]);
    expect(rows[0].amount).toMatch(/999$/);
    expect(rows[3].amount).toMatch(/1,178\.82/);
    expect(rows[3].total).toBe(true);
    expect(quoteCanContinue(quote)).toBe(true);
    const igst = quoteRows({
      ...quote,
      lines: [{ label: 'IGST', rateBasisPoints: 1800, amountMinor: 17982 }],
    });
    expect(igst.map((r) => r.label)).toEqual(['Plan price', 'IGST (18%)', 'Total a month']);
  });

  it('will not continue when the provider would charge something other than the quote', () => {
    const base = {
      priceId: 'p',
      interval: 'MONTH' as const,
      currency: 'INR',
      mode: 'MANUAL' as const,
      netMinor: 99900,
      taxMinor: 17982,
      totalMinor: 117882,
      lines: [],
      placeOfSupply: null,
      interState: null,
    };
    expect(quoteCanContinue({ ...base, providerChargeMinor: 99900, chargeMatches: false })).toBe(
      false,
    );
    // Not read (Stripe, or the provider was unreachable): the server still checks at checkout.
    expect(quoteCanContinue({ ...base, providerChargeMinor: null, chargeMatches: null })).toBe(
      true,
    );
  });

  it('confirms a payment made in another tab only from the server', () => {
    expect(checkoutStatusPanel(null)).toEqual({
      message: PAY_IN_NEW_TAB,
      done: false,
      confirmed: false,
    });
    expect(checkoutStatusPanel({ state: 'PENDING', planActive: false }).confirmed).toBe(false);
    expect(checkoutStatusPanel({ state: 'PROCESSING', planActive: false })).toEqual({
      message: CHECKOUT_PROCESSING,
      done: false,
      confirmed: false,
    });
    // An "ACTIVE" that the server does not back with a live plan is not a confirmation.
    expect(checkoutStatusPanel({ state: 'ACTIVE', planActive: false }).confirmed).toBe(false);
    expect(checkoutStatusPanel({ state: 'ACTIVE', planActive: true })).toEqual({
      message: PAYMENT_CONFIRMED,
      done: true,
      confirmed: true,
    });
    expect(checkoutStatusPanel({ state: 'FAILED', planActive: false }).message).toBe(
      CHECKOUT_FAILED,
    );
    expect(checkoutStatusPanel({ state: 'EXPIRED', planActive: false }).message).toBe(
      CHECKOUT_EXPIRED,
    );
    // The address bar is not an input: a redirect hint maps to a message, never to a status.
    expect(checkoutReturn('?checkout=success&status=active')).toBe('plan-success');
    expect(checkoutStatusPanel(null).confirmed).toBe(false);
  });

  it('writes every payment sentence in plain ASCII', () => {
    for (const s of [
      PAY_IN_NEW_TAB,
      CHECKOUT_PROCESSING,
      CHECKOUT_FAILED,
      CHECKOUT_EXPIRED,
      PAYMENT_TAB_BLOCKED,
      QUOTE_MISMATCH,
      REFRESH_STATUS_LABEL,
      PAYMENT_CONFIRMED,
      PAYMENT_NOT_CONFIRMED_YET,
      CANCEL_DIALOG_TEXT,
      DISPUTED_NOTICE,
      ...Object.values(RETURN_MESSAGES),
    ]) {
      expect(s).toMatch(ASCII);
    }
  });
});
