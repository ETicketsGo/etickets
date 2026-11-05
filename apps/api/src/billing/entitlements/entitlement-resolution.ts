import {
  ALL_ENTITLEMENT_KEYS,
  ENTITLEMENT_DEFINITIONS,
  isEntitlementKey,
  type EntitlementKey,
  type EntitlementSource,
  type FeatureFlag,
  type ResolvedEntitlement,
} from '@eticketsgo/shared-types';

/** A plan's stated value for one key (a PlanEntitlement row, or the built-in Free plan). */
export interface PlanValue {
  key: string;
  boolValue?: boolean | null;
  intValue?: number | null;
}

/** An EntitlementOverride row, as far as resolution cares. */
export interface OverrideValue {
  id: string;
  key: string;
  boolValue: boolean | null;
  intValue: number | null;
  startsAt: Date;
  endsAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/** Whether an override applies at `at`: started, not ended, not revoked. */
export function overrideLive(o: OverrideValue, at: Date): boolean {
  const t = at.getTime();
  if (o.startsAt.getTime() > t) return false;
  if (o.endsAt && o.endsAt.getTime() <= t) return false;
  if (o.revokedAt && o.revokedAt.getTime() <= t) return false;
  return true;
}

/**
 * For each key, the override that wins at `at`: among the live ones, the one that started
 * latest; on a tie, the one created latest. A later grant replaces an earlier one without the
 * earlier one having to be revoked, and revoking the later one uncovers the earlier one again.
 */
export function winningOverrides(
  overrides: readonly OverrideValue[],
  at: Date,
): Map<string, OverrideValue> {
  const out = new Map<string, OverrideValue>();
  for (const o of overrides) {
    if (!overrideLive(o, at)) continue;
    const prev = out.get(o.key);
    const later =
      !prev ||
      o.startsAt.getTime() > prev.startsAt.getTime() ||
      (o.startsAt.getTime() === prev.startsAt.getTime() &&
        o.createdAt.getTime() > prev.createdAt.getTime());
    if (later) out.set(o.key, o);
  }
  return out;
}

/**
 * Plan -> overrides -> deployment kill switch, for every known key.
 *
 * A key the plan does not mention is off (or 0). A kill switch only ever takes away: it turns a
 * granted entitlement off and reports that it did (`switchedOffInDeployment`), so a page can say
 * "included in your plan, not switched on yet" instead of pretending the plan lacks it.
 */
export function resolveEntitlements(input: {
  plan: readonly PlanValue[];
  overrides: readonly OverrideValue[];
  at: Date;
  featureEnabled: (flag: FeatureFlag) => boolean;
}): ResolvedEntitlement[] {
  const planByKey = new Map<string, PlanValue>();
  for (const p of input.plan) if (isEntitlementKey(p.key)) planByKey.set(p.key, p);
  const winners = winningOverrides(input.overrides, input.at);

  return ALL_ENTITLEMENT_KEYS.map((key: EntitlementKey): ResolvedEntitlement => {
    const def = ENTITLEMENT_DEFINITIONS[key];
    const override = winners.get(key);
    const plan = planByKey.get(key);
    const source: EntitlementSource = override ? 'OVERRIDE' : plan ? 'PLAN' : 'DEFAULT';
    const stated = override ?? plan;

    let enabled: boolean;
    let limit: number | null;
    if (def.kind === 'int') {
      const n = stated?.intValue ?? 0;
      limit = Number.isInteger(n) && n > 0 ? n : 0;
      enabled = limit > 0;
    } else {
      limit = null;
      enabled = stated?.boolValue === true;
    }

    const killed = !!def.killSwitch && !input.featureEnabled(def.killSwitch);
    const switchedOffInDeployment = killed && enabled;
    if (killed) {
      enabled = false;
      if (def.kind === 'int') limit = 0;
    }
    return { key, kind: def.kind, enabled, limit, source, switchedOffInDeployment };
  });
}
