import { AdminPermission } from '@eticketsgo/shared-types';
import { ADMIN_PERMISSION_KEY } from '../common/decorators';
import { PlatformFeePoliciesController } from './platform-fee-policies.controller';
import {
  independenceFailure,
  pendingDecision,
  summariseImpact,
} from './platform-fee-policies.service';
import {
  effectiveFeePolicyStatus,
  feePolicyApplies,
  type FeePolicyRow,
} from '../pricing/fee-policy';

/**
 * Maker-checker on platform fee policies (AR-10): the pure rules and who may call what.
 * The database half (triggers, concurrency, the booking path) is in
 * fee-policy-approval.integration-postgres.spec.ts.
 */

const now = new Date('2026-11-06T12:00:00Z');
const row = (over: Partial<FeePolicyRow> = {}): FeePolicyRow => ({
  id: 'p1',
  scope: 'EVENT',
  eventId: 'e1',
  organizationId: 'o1',
  kind: 'WAIVE',
  currency: null,
  startsAt: new Date('2026-11-01T00:00:00Z'),
  endsAt: null,
  maxOrders: null,
  usedOrders: 0,
  status: 'ACTIVE',
  version: 1,
  ...over,
});

describe('a policy nobody approved never prices a sale', () => {
  it.each(['PENDING_APPROVAL', 'REJECTED', 'WITHDRAWN', 'INACTIVE'])('%s', (status) => {
    expect(feePolicyApplies(row({ status }), 'INR', now)).toBe(false);
  });
  it('an approved one does', () => {
    expect(feePolicyApplies(row(), 'INR', now)).toBe(true);
  });
  it('shows its own state whatever its window', () => {
    expect(effectiveFeePolicyStatus(row({ status: 'PENDING_APPROVAL' }), now)).toBe(
      'PENDING_APPROVAL',
    );
    // Even one whose window has passed: it never priced, so "expired" would be misleading.
    expect(
      effectiveFeePolicyStatus(
        row({ status: 'REJECTED', endsAt: new Date('2026-11-02T00:00:00Z') }),
        now,
      ),
    ).toBe('REJECTED');
  });
});

describe('independence is judged on identity, never on role', () => {
  const p = { createdByUserId: 'maker', deactivationRequestedByUserId: 'asker' };
  it('the creator may not decide on the policy', () => {
    expect(independenceFailure('maker', p, 'POLICY')).toBe('CREATOR');
    expect(independenceFailure('someoneElse', p, 'POLICY')).toBeNull();
  });
  it('the requester may not decide on the switch-off; the creator may', () => {
    expect(independenceFailure('asker', p, 'DEACTIVATION')).toBe('REQUESTER');
    expect(independenceFailure('maker', p, 'DEACTIVATION')).toBeNull();
  });
  it('names what is pending', () => {
    expect(
      pendingDecision({ status: 'PENDING_APPROVAL', deactivationRequestedByUserId: null }),
    ).toBe('POLICY');
    expect(pendingDecision({ status: 'ACTIVE', deactivationRequestedByUserId: 'a' })).toBe(
      'DEACTIVATION',
    );
    expect(pendingDecision({ status: 'ACTIVE', deactivationRequestedByUserId: null })).toBeNull();
    expect(pendingDecision({ status: 'INACTIVE', deactivationRequestedByUserId: 'a' })).toBeNull();
  });
});

describe('the impact estimate', () => {
  it('totals per currency, never across them, and names the direction', () => {
    const out = summariseImpact([
      { currency: 'INR', beforeMinor: 1_500, afterMinor: 0 },
      { currency: 'INR', beforeMinor: 2_000, afterMinor: 0 },
      { currency: 'USD', beforeMinor: 100, afterMinor: 100 },
    ]);
    expect(out.direction).toBe('DECREASE');
    expect(out.orders).toBe(3);
    expect(out.currencies).toEqual([
      expect.objectContaining({
        currency: 'INR',
        orders: 2,
        beforeFeeMinor: 3_500,
        afterFeeMinor: 0,
        deltaMinor: -3_500,
        lower: 2,
        largestDecreaseMinor: 2_000,
      }),
      expect.objectContaining({ currency: 'USD', unchanged: 1, deltaMinor: 0 }),
    ]);
  });
  it('an increase and a mix are reported as such', () => {
    expect(
      summariseImpact([{ currency: 'INR', beforeMinor: 0, afterMinor: 1_500 }]).direction,
    ).toBe('INCREASE');
    expect(
      summariseImpact([
        { currency: 'INR', beforeMinor: 0, afterMinor: 10 },
        { currency: 'INR', beforeMinor: 10, afterMinor: 0 },
      ]).direction,
    ).toBe('MIXED');
    expect(summariseImpact([]).direction).toBe('NONE');
  });
});

describe('who may call what', () => {
  const needs = (handler: keyof PlatformFeePoliciesController) =>
    Reflect.getMetadata(
      ADMIN_PERMISSION_KEY,
      PlatformFeePoliciesController.prototype[handler] as object,
    ) as string[];

  it('proposing needs PLATFORM_CONFIG; deciding needs FEE_SCHEDULE_APPROVE', () => {
    expect(needs('createPlatformFeePolicy')).toEqual([AdminPermission.PLATFORM_CONFIG]);
    expect(needs('deactivatePlatformFeePolicy')).toEqual([AdminPermission.PLATFORM_CONFIG]);
    expect(needs('withdrawPlatformFeePolicy')).toEqual([AdminPermission.PLATFORM_CONFIG]);
    expect(needs('withdrawPlatformFeePolicyDeactivation')).toEqual([
      AdminPermission.PLATFORM_CONFIG,
    ]);
    for (const h of [
      'approvePlatformFeePolicy',
      'rejectPlatformFeePolicy',
      'approvePlatformFeePolicyDeactivation',
      'rejectPlatformFeePolicyDeactivation',
    ] as const) {
      expect(needs(h)).toEqual([AdminPermission.FEE_SCHEDULE_APPROVE]);
    }
  });
  it('the emergency switch-off needs both', () => {
    expect(needs('emergencyDeactivatePlatformFeePolicy')).toEqual([
      AdminPermission.PLATFORM_CONFIG,
      AdminPermission.FEE_SCHEDULE_APPROVE,
    ]);
  });
  it('reads, including the impact estimate, need only the read duty', () => {
    expect(needs('impact')).toEqual([AdminPermission.PLATFORM_CONFIG_READ]);
    expect(needs('detail')).toEqual([AdminPermission.PLATFORM_CONFIG_READ]);
  });
});
