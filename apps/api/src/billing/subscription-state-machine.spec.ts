import type { SubscriptionStatus } from '@eticketsgo/shared-types';
import {
  RENEWAL_TOLERANCE_MS,
  SubscriptionTransitionError,
  dueTimedEvent,
  grantsEntitlements,
  transition,
  type PaymentEvidence,
  type SubscriptionEvent,
  type SubscriptionSnapshot,
} from './subscription-state-machine';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-27T12:00:00Z');
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const PAID: PaymentEvidence = {
  verified: true,
  provider: 'MOCK',
  paymentRef: 'pay_1',
  amountMinor: 99900,
  currency: 'INR',
};

function snap(status: SubscriptionStatus, patch: Partial<SubscriptionSnapshot> = {}) {
  const base: SubscriptionSnapshot = {
    status,
    source:
      status === 'COMPLIMENTARY'
        ? 'ADMIN_COMPLIMENTARY'
        : status === 'TRIALING'
          ? 'TRIAL'
          : 'PROVIDER',
    planId: 'pro',
    currentPeriodStart: at(-10),
    currentPeriodEnd: at(20),
    cancelAtPeriodEnd: false,
    trialEndsAt: status === 'TRIALING' ? at(4) : null,
    graceEndsAt: status === 'GRACE' ? at(5) : null,
    scheduledPlanId: null,
    cancelledAt: null,
    endedAt: null,
  };
  return { ...base, ...patch };
}

const ALL: SubscriptionStatus[] = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'GRACE',
  'CANCELLED',
  'EXPIRED',
  'COMPLIMENTARY',
];

/**
 * The full table: for each event, the states it is legal from and the state it leads to.
 * Every (state, event) pair NOT listed must be refused - the second block checks that, so a
 * move added to the code without a row here fails the build.
 */
const TABLE: Array<{
  event: SubscriptionEvent;
  from: Array<SubscriptionStatus | null>;
  to: SubscriptionStatus;
  patch?: (s: SubscriptionStatus | null) => Partial<SubscriptionSnapshot>;
  creates?: (s: SubscriptionStatus | null) => boolean;
}> = [
  {
    event: { type: 'START_TRIAL', planId: 'premium', trialEndsAt: at(14) },
    from: [null, 'CANCELLED', 'EXPIRED'],
    to: 'TRIALING',
    creates: () => true,
  },
  {
    event: { type: 'TRIAL_ENDED' },
    from: ['TRIALING'],
    to: 'EXPIRED',
    patch: () => ({ trialEndsAt: at(-1) }),
  },
  {
    event: { type: 'ACTIVATE', planId: 'pro', periodStart: NOW, periodEnd: at(30), evidence: PAID },
    from: [null, 'CANCELLED', 'EXPIRED', 'TRIALING', 'COMPLIMENTARY'],
    to: 'ACTIVE',
    creates: (s) => s === null || s === 'CANCELLED' || s === 'EXPIRED',
  },
  {
    event: { type: 'RENEW', periodEnd: at(50), evidence: PAID },
    from: ['ACTIVE', 'PAST_DUE', 'GRACE'],
    to: 'ACTIVE',
  },
  { event: { type: 'PAYMENT_FAILED' }, from: ['ACTIVE', 'PAST_DUE'], to: 'PAST_DUE' },
  { event: { type: 'ENTER_GRACE', graceEndsAt: at(7) }, from: ['PAST_DUE'], to: 'GRACE' },
  {
    event: { type: 'GRACE_ENDED' },
    from: ['GRACE'],
    to: 'EXPIRED',
    patch: () => ({ graceEndsAt: at(-1) }),
  },
  {
    event: { type: 'CANCEL_AT_PERIOD_END' },
    from: ['ACTIVE', 'PAST_DUE'],
    to: '__same__' as never,
  },
  {
    event: { type: 'RESUME' },
    from: ['ACTIVE'],
    to: 'ACTIVE',
    patch: () => ({ cancelAtPeriodEnd: true }),
  },
  {
    event: { type: 'PERIOD_ENDED' },
    from: ['ACTIVE'],
    to: 'CANCELLED',
    patch: () => ({ cancelAtPeriodEnd: true, currentPeriodEnd: at(-1) }),
  },
  { event: { type: 'SCHEDULE_PLAN_CHANGE', planId: 'premium' }, from: ['ACTIVE'], to: 'ACTIVE' },
  {
    event: { type: 'CANCEL_SCHEDULED_CHANGE' },
    from: ['ACTIVE'],
    to: 'ACTIVE',
    patch: () => ({ scheduledPlanId: 'premium' }),
  },
  {
    event: { type: 'CHANGE_PLAN_NOW', planId: 'premium', evidence: PAID },
    from: ['ACTIVE'],
    to: 'ACTIVE',
  },
  {
    event: { type: 'GRANT_COMPLIMENTARY', planId: 'premium', endsAt: at(30) },
    from: [null, 'CANCELLED', 'EXPIRED', 'TRIALING'],
    to: 'COMPLIMENTARY',
    creates: (s) => s !== 'TRIALING',
  },
  {
    event: { type: 'COMPLIMENTARY_ENDED' },
    from: ['COMPLIMENTARY'],
    to: 'EXPIRED',
    patch: () => ({ currentPeriodEnd: at(-1) }),
  },
  { event: { type: 'REVOKE' }, from: ['TRIALING', 'COMPLIMENTARY'], to: 'EXPIRED' },
  {
    event: { type: 'CANCEL_NOW' },
    from: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE', 'COMPLIMENTARY'],
    to: 'CANCELLED',
  },
];

describe('the subscription state machine', () => {
  describe('legal moves', () => {
    for (const row of TABLE) {
      for (const from of row.from) {
        it(`${from ?? 'none'} --${row.event.type}--> ${row.to === ('__same__' as never) ? from : row.to}`, () => {
          const current = from === null ? null : snap(from, row.patch?.(from));
          const { next, creates } = transition(current, row.event, NOW);
          expect(next.status).toBe(row.to === ('__same__' as never) ? from : row.to);
          expect(creates).toBe(row.creates ? row.creates(from) : false);
        });
      }
    }
  });

  describe('every other move is refused', () => {
    for (const row of TABLE) {
      const illegal = [null, ...ALL].filter((s) => !row.from.includes(s));
      for (const from of illegal) {
        it(`${from ?? 'none'} refuses ${row.event.type}`, () => {
          const current = from === null ? null : snap(from, row.patch?.(from));
          expect(() => transition(current, row.event, NOW)).toThrow(SubscriptionTransitionError);
        });
      }
    }
  });

  describe('a paid plan needs verified payment evidence', () => {
    const bad: Array<[string, PaymentEvidence | null]> = [
      ['no evidence', null],
      ['an unverified provider event', { ...PAID, verified: false }],
      ['no payment reference', { ...PAID, paymentRef: '' }],
      ['a zero amount', { ...PAID, amountMinor: 0 }],
      ['a negative amount', { ...PAID, amountMinor: -1 }],
      ['a fractional amount', { ...PAID, amountMinor: 1.5 }],
      ['no currency', { ...PAID, currency: '' }],
    ];
    it.each(bad)('ACTIVATE refuses %s', (_name, evidence) => {
      try {
        transition(
          null,
          { type: 'ACTIVATE', planId: 'pro', periodStart: NOW, periodEnd: at(30), evidence },
          NOW,
        );
        throw new Error('expected a refusal');
      } catch (e) {
        expect((e as SubscriptionTransitionError).code).toBe('PAYMENT_NOT_VERIFIED');
      }
    });
    it.each(bad)('RENEW refuses %s', (_name, evidence) => {
      expect(() =>
        transition(snap('ACTIVE'), { type: 'RENEW', periodEnd: at(50), evidence }, NOW),
      ).toThrow(/verified payment/);
    });
    it.each(bad)('CHANGE_PLAN_NOW refuses %s', (_name, evidence) => {
      expect(() =>
        transition(snap('ACTIVE'), { type: 'CHANGE_PLAN_NOW', planId: 'premium', evidence }, NOW),
      ).toThrow(/verified payment/);
    });
    it('a trial does not turn into a paid plan without a payment', () => {
      expect(() =>
        transition(
          snap('TRIALING'),
          { type: 'ACTIVATE', planId: 'pro', periodStart: NOW, periodEnd: at(30), evidence: null },
          NOW,
        ),
      ).toThrow(SubscriptionTransitionError);
    });
  });

  describe('the details of each move', () => {
    it('renewal starts at the old period end, applies a scheduled change and clears grace', () => {
      const { next } = transition(
        snap('GRACE', { scheduledPlanId: 'premium' }),
        { type: 'RENEW', periodEnd: at(50), evidence: PAID },
        NOW,
      );
      expect(next.currentPeriodStart).toEqual(at(20));
      expect(next.planId).toBe('premium');
      expect(next.scheduledPlanId).toBeNull();
      expect(next.graceEndsAt).toBeNull();
    });

    it('a subscription set to cancel at period end does not renew', () => {
      expect(() =>
        transition(
          snap('ACTIVE', { cancelAtPeriodEnd: true }),
          { type: 'RENEW', periodEnd: at(50), evidence: PAID },
          NOW,
        ),
      ).toThrow(/does not renew/);
    });

    it('cancel at period end keeps the subscription active and drops a scheduled change', () => {
      const { next } = transition(
        snap('ACTIVE', { scheduledPlanId: 'premium' }),
        { type: 'CANCEL_AT_PERIOD_END' },
        NOW,
      );
      expect(next.status).toBe('ACTIVE');
      expect(next.cancelAtPeriodEnd).toBe(true);
      expect(next.scheduledPlanId).toBeNull();
    });

    it('clock moves refuse to run early', () => {
      expect(() => transition(snap('TRIALING'), { type: 'TRIAL_ENDED' }, NOW)).toThrow(
        /not been reached/,
      );
      expect(() => transition(snap('GRACE'), { type: 'GRACE_ENDED' }, NOW)).toThrow(
        /not been reached/,
      );
      expect(() => transition(snap('COMPLIMENTARY'), { type: 'COMPLIMENTARY_ENDED' }, NOW)).toThrow(
        /not been reached/,
      );
      expect(() =>
        transition(snap('ACTIVE', { cancelAtPeriodEnd: true }), { type: 'PERIOD_ENDED' }, NOW),
      ).toThrow(/not been reached/);
      // An open-ended complimentary plan never ends by the clock.
      expect(() =>
        transition(
          snap('COMPLIMENTARY', { currentPeriodEnd: null }),
          { type: 'COMPLIMENTARY_ENDED' },
          NOW,
        ),
      ).toThrow(SubscriptionTransitionError);
    });

    it('ending stamps endedAt, and cancelledAt only for a cancellation', () => {
      const expired = transition(snap('TRIALING'), { type: 'REVOKE' }, NOW).next;
      expect(expired.endedAt).toEqual(NOW);
      expect(expired.cancelledAt).toBeNull();
      const cancelled = transition(snap('ACTIVE'), { type: 'CANCEL_NOW' }, NOW).next;
      expect(cancelled.cancelledAt).toEqual(NOW);
    });

    it('a staff grant never sits on top of a paid subscription', () => {
      for (const s of ['ACTIVE', 'PAST_DUE', 'GRACE'] as const) {
        expect(() =>
          transition(
            snap(s),
            { type: 'GRANT_COMPLIMENTARY', planId: 'premium', endsAt: null },
            NOW,
          ),
        ).toThrow(/cannot take GRANT_COMPLIMENTARY/);
      }
    });

    it('refuses windows that are already over', () => {
      expect(() =>
        transition(null, { type: 'START_TRIAL', planId: 'pro', trialEndsAt: at(-1) }, NOW),
      ).toThrow(SubscriptionTransitionError);
      expect(() =>
        transition(null, { type: 'GRANT_COMPLIMENTARY', planId: 'pro', endsAt: NOW }, NOW),
      ).toThrow(SubscriptionTransitionError);
      expect(() =>
        transition(snap('PAST_DUE'), { type: 'ENTER_GRACE', graceEndsAt: at(-1) }, NOW),
      ).toThrow(SubscriptionTransitionError);
    });
  });

  describe('which states grant the plan', () => {
    it.each<[string, SubscriptionSnapshot, Date, boolean]>([
      ['a trial before its end', snap('TRIALING'), NOW, true],
      ['a trial after its end', snap('TRIALING'), at(5), false],
      ['an active plan in its period', snap('ACTIVE'), NOW, true],
      [
        'an active plan just past its period (renewal late)',
        snap('ACTIVE'),
        new Date(at(20).getTime() + RENEWAL_TOLERANCE_MS - 1),
        true,
      ],
      [
        'an active plan past the tolerance',
        snap('ACTIVE'),
        new Date(at(20).getTime() + RENEWAL_TOLERANCE_MS),
        false,
      ],
      [
        'an active plan cancelling, past its period',
        snap('ACTIVE', { cancelAtPeriodEnd: true }),
        at(20),
        false,
      ],
      ['past due', snap('PAST_DUE'), at(25), true],
      ['grace before its end', snap('GRACE'), at(4), true],
      ['grace at its end', snap('GRACE'), at(5), false],
      ['complimentary before its end', snap('COMPLIMENTARY'), NOW, true],
      ['complimentary after its end', snap('COMPLIMENTARY'), at(21), false],
      [
        'open-ended complimentary',
        snap('COMPLIMENTARY', { currentPeriodEnd: null }),
        at(999),
        true,
      ],
      ['cancelled', snap('CANCELLED'), NOW, false],
      ['expired', snap('EXPIRED'), NOW, false],
      ['anything before it starts', snap('ACTIVE'), at(-11), false],
    ])('%s', (_name, s, when, expected) => {
      expect(grantsEntitlements(s, when)).toBe(expected);
    });
  });

  describe('the sweep finds the clock move that is due', () => {
    it.each<[string, SubscriptionSnapshot, string | null]>([
      ['trial over', snap('TRIALING', { trialEndsAt: at(-1) }), 'TRIAL_ENDED'],
      ['trial running', snap('TRIALING'), null],
      ['grace over', snap('GRACE', { graceEndsAt: at(-1) }), 'GRACE_ENDED'],
      [
        'complimentary over',
        snap('COMPLIMENTARY', { currentPeriodEnd: at(-1) }),
        'COMPLIMENTARY_ENDED',
      ],
      ['open-ended complimentary', snap('COMPLIMENTARY', { currentPeriodEnd: null }), null],
      [
        'cancelling period over',
        snap('ACTIVE', { cancelAtPeriodEnd: true, currentPeriodEnd: at(-1) }),
        'PERIOD_ENDED',
      ],
      // A renewing subscription past its period waits for the provider; the clock does not end it.
      ['renewing period over', snap('ACTIVE', { currentPeriodEnd: at(-1) }), null],
    ])('%s', (_name, s, expected) => {
      expect(dueTimedEvent(s, NOW)?.type ?? null).toBe(expected);
    });
  });
});
