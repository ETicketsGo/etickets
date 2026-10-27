import { FeeMode } from '@eticketsgo/shared-types';
import { calculateFees, DEFAULT_FEE_TIERS } from './fee-calculator';
import {
  appliedFeePolicy,
  calculateFeesWithPolicy,
  currenciesCollide,
  effectiveFeePolicyStatus,
  feePolicyApplies,
  policyFeeTiers,
  selectFeePolicy,
  windowsOverlap,
  type FeePolicyRow,
} from './fee-policy';
import type { TaxRuleInput } from './tax-calculator';

/**
 * Platform fee overrides and waivers, the arithmetic and the choice.
 *
 * The rules under test: a policy replaces the BOOKING fee only (payment processing and tax are
 * never waived), precedence is event > organizer > schedule, a policy that does not apply now
 * falls through to the next level, a free order stays free, and an override never charges more
 * than the schedule.
 */

const NOW = new Date('2026-11-01T10:00:00Z');
const HOUR = 3_600_000;

function policy(over: Partial<FeePolicyRow> = {}): FeePolicyRow {
  return {
    id: 'p1',
    scope: 'ORGANIZATION',
    eventId: null,
    organizationId: 'org1',
    kind: 'WAIVE',
    feeMinor: null,
    percentBps: null,
    minFeeMinor: null,
    maxFeeMinor: null,
    currency: null,
    startsAt: new Date(NOW.getTime() - HOUR),
    endsAt: null,
    maxOrders: null,
    usedOrders: 0,
    status: 'ACTIVE',
    version: 1,
    createdAt: new Date(NOW.getTime() - HOUR),
    ...over,
  };
}

const ctx = { eventId: 'ev1', organizationId: 'org1', at: NOW };

function priced(
  p: FeePolicyRow | null,
  subtotalMinor: number,
  feeMode: FeeMode = FeeMode.CUSTOMER_PAYS,
) {
  return calculateFeesWithPolicy({
    subtotalMinor,
    feeMode,
    currency: 'INR',
    baseTiers: DEFAULT_FEE_TIERS,
    policy: p ? { ...p, applied: appliedFeePolicy(p) } : null,
  });
}

describe('policyFeeTiers - one synthetic band per kind', () => {
  it('WAIVE is an explicit zero band, never an empty list (empty means "use the defaults")', () => {
    const tiers = policyFeeTiers({ kind: 'WAIVE' });
    expect(tiers).toEqual([{ minMinor: 0, maxMinor: null, feeMinor: 0, type: 'FLAT' }]);
    // The trap the explicit band avoids: an empty list is the default schedule.
    expect(
      calculateFees({ subtotalMinor: 50_000, feeMode: FeeMode.CUSTOMER_PAYS, tiers: [] })
        .bookingFeeMinor,
    ).toBe(0);
    expect(
      calculateFees({ subtotalMinor: 50_000, feeMode: FeeMode.CUSTOMER_PAYS, tiers })
        .bookingFeeMinor,
    ).toBe(0);
  });

  it('FIXED charges its amount on every order size', () => {
    const tiers = policyFeeTiers({ kind: 'FIXED', feeMinor: 300 });
    for (const subtotal of [100, 50_000, 5_000_000]) {
      expect(
        calculateFees({ subtotalMinor: subtotal, feeMode: FeeMode.CUSTOMER_PAYS, tiers })
          .bookingFeeMinor,
      ).toBe(300);
    }
  });

  it('PERCENT takes its share, held between floor and ceiling', () => {
    const tiers = policyFeeTiers({
      kind: 'PERCENT',
      percentBps: 100,
      minFeeMinor: 200,
      maxFeeMinor: 1_000,
    });
    const fee = (s: number) =>
      calculateFees({ subtotalMinor: s, feeMode: FeeMode.CUSTOMER_PAYS, tiers }).bookingFeeMinor;
    expect(fee(10_000)).toBe(200); // 1% = 100, floor 200
    expect(fee(50_000)).toBe(500); // 1%
    expect(fee(500_000)).toBe(1_000); // 1% = 5000, ceiling 1000
  });

  it('refuses an unknown kind rather than pricing with it', () => {
    expect(() => policyFeeTiers({ kind: 'HALF' })).toThrow(/Unknown platform fee policy kind/);
  });
});

describe('a waiver removes the booking fee and nothing else', () => {
  it('payment processing is still charged, on the net plus the (now zero) booking fee', () => {
    const schedule = priced(null, 50_000);
    const waived = priced(policy(), 50_000);
    expect(schedule.fees.bookingFeeMinor).toBe(1_500);
    expect(waived.fees.bookingFeeMinor).toBe(0);
    // 2% of 50,000 + 0. Not waived.
    expect(waived.fees.paymentFeeMinor).toBe(1_000);
    expect(waived.fees.customerFeeMinor).toBe(1_000);
    expect(waived.fees.totalMinor).toBe(51_000);
    expect(waived.baseBookingFeeMinor).toBe(1_500);
    expect(waived.feeWaivedMinor).toBe(1_500);
    expect(waived.policy).toEqual({
      id: 'p1',
      kind: 'WAIVE',
      scope: 'ORGANIZATION',
      version: 1,
      maxOrders: null,
    });
  });

  it('tax on fees is computed on the fee actually charged after the waiver', () => {
    const gstOnFees: TaxRuleInput[] = [
      { label: 'GST on fees', rateBasisPoints: 1_800, appliesTo: 'FEES' } as TaxRuleInput,
    ];
    const out = calculateFeesWithPolicy({
      subtotalMinor: 50_000,
      feeMode: FeeMode.CUSTOMER_PAYS,
      currency: 'INR',
      baseTiers: DEFAULT_FEE_TIERS,
      taxRules: gstOnFees,
      policy: { ...policy(), applied: appliedFeePolicy(policy()) },
    });
    // 18% of the 1,000 payment fee. Not of 2,500 (the fee before the waiver), not zero.
    expect(out.fees.taxMinor).toBe(180);
    expect(out.fees.taxLines.every((l) => l.amountMinor >= 0)).toBe(true);
  });

  it('ORGANIZER_PAYS: the organizer absorbs the payment fee only; the customer pays the ticket', () => {
    const out = priced(policy(), 50_000, FeeMode.ORGANIZER_PAYS);
    expect(out.fees.customerFeeMinor).toBe(0);
    expect(out.fees.organizerFeeMinor).toBe(1_000);
    expect(out.fees.totalMinor).toBe(50_000);
    expect(priced(null, 50_000, FeeMode.ORGANIZER_PAYS).fees.organizerFeeMinor).toBe(2_530);
  });

  it('SHARED splits only what is left', () => {
    const out = priced(policy(), 50_000, FeeMode.SHARED);
    expect(out.fees.customerFeeMinor + out.fees.organizerFeeMinor).toBe(1_000);
  });
});

describe('an order with nothing to pay stays at zero, and spends no redemption', () => {
  it('a free order (subtotal 0) has no fee and records no policy, even under a FIXED override', () => {
    const out = priced(policy({ kind: 'FIXED', feeMinor: 500, currency: 'INR' }), 0);
    expect(out.fees.totalMinor).toBe(0);
    expect(out.fees.bookingFeeMinor).toBe(0);
    expect(out.fees.paymentFeeMinor).toBe(0);
    expect(out.policy).toBeNull();
  });

  it('a 100% discount is the same', () => {
    const out = calculateFeesWithPolicy({
      subtotalMinor: 10_000,
      discountMinor: 10_000,
      feeMode: FeeMode.CUSTOMER_PAYS,
      baseTiers: DEFAULT_FEE_TIERS,
      policy: { ...policy(), applied: appliedFeePolicy(policy()) },
    });
    expect(out.fees.totalMinor).toBe(0);
    expect(out.policy).toBeNull();
  });
});

describe('an override only ever lowers the fee', () => {
  it('a FIXED fee above the schedule band is not charged; the schedule is, and no policy is recorded', () => {
    // Rs 199 order: the schedule charges Rs 5. A "reduced" fixed Rs 10 must not raise it.
    const out = priced(policy({ kind: 'FIXED', feeMinor: 1_000, currency: 'INR' }), 19_900);
    expect(out.fees.bookingFeeMinor).toBe(500);
    expect(out.policy).toBeNull();
  });

  it('a FIXED fee below the band is charged', () => {
    const out = priced(policy({ kind: 'FIXED', feeMinor: 1_000, currency: 'INR' }), 150_000);
    expect(out.fees.bookingFeeMinor).toBe(1_000);
    expect(out.feeWaivedMinor).toBe(1_000);
  });
});

describe('selectFeePolicy - precedence and fallback', () => {
  const org = policy({ id: 'org-waive' });
  const event = policy({
    id: 'ev-fixed',
    scope: 'EVENT',
    eventId: 'ev1',
    kind: 'FIXED',
    feeMinor: 700,
    currency: 'INR',
  });

  it('event beats organizer beats schedule', () => {
    expect(selectFeePolicy([org, event], 'INR', ctx)?.id).toBe('ev-fixed');
    expect(selectFeePolicy([org], 'INR', ctx)?.id).toBe('org-waive');
    expect(selectFeePolicy([], 'INR', ctx)).toBeNull();
  });

  it('an event override REPLACES an organizer waiver (it does not stack with it)', () => {
    const chosen = selectFeePolicy([org, event], 'INR', ctx)!;
    const out = priced(chosen, 150_000);
    expect(out.fees.bookingFeeMinor).toBe(700);
  });

  it('a policy for another event or organizer is ignored', () => {
    expect(selectFeePolicy([policy({ scope: 'EVENT', eventId: 'other' })], 'INR', ctx)).toBeNull();
    expect(selectFeePolicy([policy({ organizationId: 'org2' })], 'INR', ctx)).toBeNull();
  });

  it('date bounds: not before startsAt, not at or after endsAt (exclusive)', () => {
    expect(feePolicyApplies(policy({ startsAt: new Date(NOW.getTime() + 1) }), 'INR', NOW)).toBe(
      false,
    );
    expect(feePolicyApplies(policy({ startsAt: NOW }), 'INR', NOW)).toBe(true);
    expect(feePolicyApplies(policy({ endsAt: NOW }), 'INR', NOW)).toBe(false);
    expect(feePolicyApplies(policy({ endsAt: new Date(NOW.getTime() + 1) }), 'INR', NOW)).toBe(
      true,
    );
  });

  it('an expired event policy falls back to the organizer policy, and that to the schedule', () => {
    const expiredEvent = { ...event, endsAt: new Date(NOW.getTime() - 1) };
    expect(selectFeePolicy([org, expiredEvent], 'INR', ctx)?.id).toBe('org-waive');
    const expiredOrg = { ...org, endsAt: new Date(NOW.getTime() - 1) };
    expect(selectFeePolicy([expiredOrg, expiredEvent], 'INR', ctx)).toBeNull();
  });

  it('an exhausted or inactive policy falls back the same way', () => {
    const used = { ...event, maxOrders: 3, usedOrders: 3 };
    expect(selectFeePolicy([org, used], 'INR', ctx)?.id).toBe('org-waive');
    expect(selectFeePolicy([org, { ...event, status: 'EXHAUSTED' }], 'INR', ctx)?.id).toBe(
      'org-waive',
    );
    expect(selectFeePolicy([org, { ...event, status: 'INACTIVE' }], 'INR', ctx)?.id).toBe(
      'org-waive',
    );
  });

  it('a policy in another currency does not apply; one with no currency applies to any', () => {
    expect(selectFeePolicy([event], 'USD', ctx)).toBeNull();
    expect(selectFeePolicy([org], 'USD', ctx)?.id).toBe('org-waive');
  });
});

describe('conflicts and status', () => {
  it('windows overlap only in the future', () => {
    const past = {
      startsAt: new Date(NOW.getTime() - 10 * HOUR),
      endsAt: new Date(NOW.getTime() - HOUR),
    };
    const open = { startsAt: new Date(NOW.getTime() - 20 * HOUR), endsAt: null };
    const later = {
      startsAt: new Date(NOW.getTime() + 5 * HOUR),
      endsAt: new Date(NOW.getTime() + 6 * HOUR),
    };
    const before = { startsAt: NOW, endsAt: new Date(NOW.getTime() + 5 * HOUR) };
    expect(windowsOverlap(past, open, NOW)).toBe(false);
    expect(windowsOverlap(open, later, NOW)).toBe(true);
    // Touching ends do not overlap: endsAt is exclusive.
    expect(windowsOverlap(before, later, NOW)).toBe(false);
  });

  it('currencies collide when either is open or both match', () => {
    expect(currenciesCollide(null, 'INR')).toBe(true);
    expect(currenciesCollide('inr', 'INR')).toBe(true);
    expect(currenciesCollide('USD', 'INR')).toBe(false);
  });

  it('effective status derives expiry and exhaustion without a writer', () => {
    expect(effectiveFeePolicyStatus(policy(), NOW)).toBe('ACTIVE');
    expect(
      effectiveFeePolicyStatus(policy({ startsAt: new Date(NOW.getTime() + HOUR) }), NOW),
    ).toBe('SCHEDULED');
    expect(effectiveFeePolicyStatus(policy({ endsAt: NOW }), NOW)).toBe('EXPIRED');
    expect(effectiveFeePolicyStatus(policy({ maxOrders: 2, usedOrders: 2 }), NOW)).toBe(
      'EXHAUSTED',
    );
    expect(effectiveFeePolicyStatus(policy({ status: 'INACTIVE', endsAt: NOW }), NOW)).toBe(
      'INACTIVE',
    );
  });
});
