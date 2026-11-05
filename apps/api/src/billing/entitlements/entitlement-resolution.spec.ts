import { PROVISIONAL_PLAN_ENTITLEMENTS, type FeatureFlag } from '@eticketsgo/shared-types';
import {
  resolveEntitlements,
  winningOverrides,
  type OverrideValue,
} from './entitlement-resolution';

const NOW = new Date('2026-10-27T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (d: number) => new Date(NOW.getTime() + d * DAY);
const ALL_ON = () => true;

let seq = 0;
function override(patch: Partial<OverrideValue> & { key: string }): OverrideValue {
  seq += 1;
  return {
    id: `o${seq}`,
    boolValue: null,
    intValue: null,
    startsAt: at(-1),
    endsAt: null,
    revokedAt: null,
    createdAt: new Date(at(-1).getTime() + seq),
    ...patch,
  };
}

const get = (rows: ReturnType<typeof resolveEntitlements>, key: string) =>
  rows.find((r) => r.key === key)!;

describe('entitlement resolution: plan, then overrides, then the deployment switch', () => {
  it('a plan grants what it lists and nothing else', () => {
    const rows = resolveEntitlements({
      plan: PROVISIONAL_PLAN_ENTITLEMENTS.PRO,
      overrides: [],
      at: NOW,
      featureEnabled: ALL_ON,
    });
    expect(get(rows, 'campaigns.create')).toMatchObject({ enabled: true, source: 'PLAN' });
    expect(get(rows, 'campaigns.monthly_email_quota')).toMatchObject({
      enabled: true,
      limit: 2000,
    });
    expect(get(rows, 'campaigns.automation')).toMatchObject({ enabled: false, source: 'DEFAULT' });
    expect(get(rows, 'billing.premium_support').enabled).toBe(false);
  });

  it('Free is the audience list only', () => {
    const rows = resolveEntitlements({
      plan: PROVISIONAL_PLAN_ENTITLEMENTS.FREE,
      overrides: [],
      at: NOW,
      featureEnabled: ALL_ON,
    });
    expect(rows.filter((r) => r.enabled).map((r) => r.key)).toEqual(['audience.basic']);
  });

  it('an override beats the plan, both ways', () => {
    const rows = resolveEntitlements({
      plan: PROVISIONAL_PLAN_ENTITLEMENTS.PRO,
      overrides: [
        override({ key: 'campaigns.automation', boolValue: true }),
        override({ key: 'campaigns.create', boolValue: false }),
        override({ key: 'campaigns.monthly_email_quota', intValue: 5000 }),
      ],
      at: NOW,
      featureEnabled: ALL_ON,
    });
    expect(get(rows, 'campaigns.automation')).toMatchObject({ enabled: true, source: 'OVERRIDE' });
    expect(get(rows, 'campaigns.create')).toMatchObject({ enabled: false, source: 'OVERRIDE' });
    expect(get(rows, 'campaigns.monthly_email_quota').limit).toBe(5000);
  });

  it('the latest live override wins; revoking it uncovers the earlier one', () => {
    const early = override({
      key: 'campaigns.monthly_email_quota',
      intValue: 3000,
      startsAt: at(-5),
    });
    const late = override({
      key: 'campaigns.monthly_email_quota',
      intValue: 9000,
      startsAt: at(-2),
    });
    expect(winningOverrides([late, early], NOW).get(early.key)?.id).toBe(late.id);
    const revoked = { ...late, revokedAt: at(-1) };
    expect(winningOverrides([revoked, early], NOW).get(early.key)?.id).toBe(early.id);
  });

  it('on the same start, the one created later wins', () => {
    const a = override({ key: 'audience.advanced', boolValue: true, startsAt: at(-1) });
    const b = override({ key: 'audience.advanced', boolValue: false, startsAt: at(-1) });
    expect(winningOverrides([b, a], NOW).get('audience.advanced')?.id).toBe(b.id);
  });

  it('an override applies only inside its window', () => {
    const o = override({
      key: 'audience.advanced',
      boolValue: true,
      startsAt: at(1),
      endsAt: at(3),
    });
    const res = (when: Date) =>
      get(
        resolveEntitlements({ plan: [], overrides: [o], at: when, featureEnabled: ALL_ON }),
        'audience.advanced',
      ).enabled;
    expect(res(NOW)).toBe(false); // not started
    expect(res(at(2))).toBe(true);
    expect(res(at(3))).toBe(false); // endsAt is exclusive
  });

  it('a revocation in the future does not end it yet', () => {
    const o = override({ key: 'audience.advanced', boolValue: true, revokedAt: at(1) });
    expect(
      get(
        resolveEntitlements({ plan: [], overrides: [o], at: NOW, featureEnabled: ALL_ON }),
        'audience.advanced',
      ).enabled,
    ).toBe(true);
  });

  it('the deployment switch takes away, whatever the plan or an override says, and says so', () => {
    const off = (flag: FeatureFlag) => flag !== 'marketingAutomation';
    const rows = resolveEntitlements({
      plan: PROVISIONAL_PLAN_ENTITLEMENTS.PREMIUM,
      overrides: [override({ key: 'campaigns.automation', boolValue: true })],
      at: NOW,
      featureEnabled: off,
    });
    expect(get(rows, 'campaigns.create')).toMatchObject({
      enabled: false,
      switchedOffInDeployment: true,
    });
    expect(get(rows, 'campaigns.automation')).toMatchObject({
      enabled: false,
      source: 'OVERRIDE',
      switchedOffInDeployment: true,
    });
    expect(get(rows, 'campaigns.monthly_email_quota')).toMatchObject({ enabled: false, limit: 0 });
    // No switch on these: untouched.
    expect(get(rows, 'audience.basic').enabled).toBe(true);
    expect(get(rows, 'billing.premium_support').enabled).toBe(true);
  });

  it('a switched-off key the plan never granted is not reported as switched off', () => {
    const rows = resolveEntitlements({
      plan: PROVISIONAL_PLAN_ENTITLEMENTS.FREE,
      overrides: [],
      at: NOW,
      featureEnabled: () => false,
    });
    expect(get(rows, 'campaigns.create').switchedOffInDeployment).toBe(false);
  });

  it('ignores keys it does not know and treats a non-positive number as none', () => {
    const rows = resolveEntitlements({
      plan: [
        { key: 'no.such.key', boolValue: true },
        { key: 'campaigns.monthly_email_quota', intValue: -5 },
      ],
      overrides: [],
      at: NOW,
      featureEnabled: ALL_ON,
    });
    expect(rows.find((r) => (r.key as string) === 'no.such.key')).toBeUndefined();
    expect(get(rows, 'campaigns.monthly_email_quota')).toMatchObject({ enabled: false, limit: 0 });
  });
});
