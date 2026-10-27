import { describe, expect, it } from 'vitest';
import { PROVISIONAL_PLAN_ENTITLEMENTS } from '@eticketsgo/shared-types';
import type { OrganizerBilling } from '@eticketsgo/web-kit';
import {
  ASK_DIALOG_TEXT,
  NO_INVOICES,
  PAID_PLANS_CLOSED,
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
    expect(
      upgradeAction({ billingEnabled: true, currentPlanCode: 'FREE' }, { ...pro, prices: [] }).kind,
    ).toBe('ask');
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
