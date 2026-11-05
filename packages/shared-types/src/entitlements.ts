import type { FeatureFlag } from './features';

/**
 * What an organization may use, decided per organization at request time.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Until now the only switch was a compile-time feature flag (`features.ts`): the same answer for
 * every organization in a deployment. A paid plan, a trial, a complimentary grant or a one-off
 * override needs an answer per organization, so the API resolves one (EntitlementService):
 *
 *   1. the plan of the organization's current subscription (FREE when it has none);
 *   2. entitlement overrides granted by staff - time-bounded, latest wins, revocable;
 *   3. the deployment kill switch: when the feature flag named in `killSwitch` is off, the
 *      entitlement is off, whatever the plan or an override says.
 *
 * The keys are stable strings. A key is never renamed: stored overrides and plan rows name it.
 */
export const EntitlementKey = {
  AUDIENCE_BASIC: 'audience.basic',
  AUDIENCE_ADVANCED: 'audience.advanced',
  CAMPAIGNS_CREATE: 'campaigns.create',
  CAMPAIGNS_SCHEDULE: 'campaigns.schedule',
  CAMPAIGNS_AUTOMATION: 'campaigns.automation',
  CAMPAIGNS_ANALYTICS_BASIC: 'campaigns.analytics.basic',
  CAMPAIGNS_ANALYTICS_ADVANCED: 'campaigns.analytics.advanced',
  /** Numeric: emails a month included in the plan. Resets every calendar month (UTC). */
  CAMPAIGNS_MONTHLY_EMAIL_QUOTA: 'campaigns.monthly_email_quota',
  /**
   * Whether the organization may BUY extra email credits. Not a gate on spending them: credits
   * granted by staff are spent after the monthly quota by anybody who may send campaigns.
   */
  CAMPAIGNS_EXTRA_CREDITS: 'campaigns.extra_credits',
  BILLING_PREMIUM_SUPPORT: 'billing.premium_support',
} as const;

export type EntitlementKey = (typeof EntitlementKey)[keyof typeof EntitlementKey];

export const ALL_ENTITLEMENT_KEYS = Object.values(EntitlementKey) as EntitlementKey[];

export type EntitlementKind = 'bool' | 'int';

export interface EntitlementDefinition {
  kind: EntitlementKind;
  /** Plain ASCII words for a person. */
  label: string;
  description: string;
  /**
   * The deployment feature flag that switches this entitlement off everywhere when it is off.
   * Absent: no deployment switch applies.
   */
  killSwitch?: FeatureFlag;
}

export const ENTITLEMENT_DEFINITIONS: Record<EntitlementKey, EntitlementDefinition> = {
  'audience.basic': {
    kind: 'bool',
    label: 'Audience list',
    description: 'See the people who bought from you and who agreed to hear from you.',
  },
  'audience.advanced': {
    kind: 'bool',
    label: 'Audience segments',
    description: 'Group your audience by what they bought, when and where.',
    killSwitch: 'organizerCrm',
  },
  'campaigns.create': {
    kind: 'bool',
    label: 'Email campaigns',
    description: 'Write and send an email to your audience.',
    killSwitch: 'marketingAutomation',
  },
  'campaigns.schedule': {
    kind: 'bool',
    label: 'Scheduled sending',
    description: 'Choose when a campaign is sent.',
    killSwitch: 'marketingAutomation',
  },
  'campaigns.automation': {
    kind: 'bool',
    label: 'Automated emails',
    description: 'Emails that send themselves, for example before an event starts.',
    killSwitch: 'marketingAutomation',
  },
  'campaigns.analytics.basic': {
    kind: 'bool',
    label: 'Campaign results',
    description: 'How many emails were delivered and opened.',
    killSwitch: 'marketingAutomation',
  },
  'campaigns.analytics.advanced': {
    kind: 'bool',
    label: 'Campaign sales results',
    description: 'Which campaigns led to ticket sales.',
    killSwitch: 'marketingAutomation',
  },
  'campaigns.monthly_email_quota': {
    kind: 'int',
    label: 'Emails each month',
    description: 'Campaign emails included every month. Unused emails do not carry over.',
    killSwitch: 'marketingAutomation',
  },
  'campaigns.extra_credits': {
    kind: 'bool',
    label: 'Buy extra email credits',
    description: 'Buy more emails than the monthly amount. Opens when paid plans open.',
    killSwitch: 'marketingAutomation',
  },
  'billing.premium_support': {
    kind: 'bool',
    label: 'Priority support',
    description: 'Your support requests are answered first.',
  },
};

/** The ledger key that holds extra email credits (granted or bought, spent after the quota). */
export const EMAIL_CREDITS_LEDGER_KEY = 'campaigns.email_credits';

export function isEntitlementKey(value: string): value is EntitlementKey {
  return (ALL_ENTITLEMENT_KEYS as string[]).includes(value);
}

// ── Plans ─────────────────────────────────────────────────────────────────────────

export const BillingPlanCode = {
  FREE: 'FREE',
  PRO: 'PRO',
  PREMIUM: 'PREMIUM',
} as const;
export type BillingPlanCode = (typeof BillingPlanCode)[keyof typeof BillingPlanCode];

export const BillingInterval = { MONTH: 'MONTH', YEAR: 'YEAR' } as const;
export type BillingInterval = (typeof BillingInterval)[keyof typeof BillingInterval];

export const SubscriptionStatus = {
  TRIALING: 'TRIALING',
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  GRACE: 'GRACE',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  COMPLIMENTARY: 'COMPLIMENTARY',
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export const SubscriptionSource = {
  PROVIDER: 'PROVIDER',
  ADMIN_COMPLIMENTARY: 'ADMIN_COMPLIMENTARY',
  TRIAL: 'TRIAL',
} as const;
export type SubscriptionSource = (typeof SubscriptionSource)[keyof typeof SubscriptionSource];

/** One entitlement as a plan or an override states it. */
export interface EntitlementValue {
  key: EntitlementKey;
  boolValue?: boolean | null;
  intValue?: number | null;
}

/**
 * The catalogue the loader writes. Prices CONFIRMED by the owner on 2026-10-27; the names keep
 * "PROVISIONAL" because stored audit rows and the admin endpoint name it. Loaded only by an
 * explicit admin action, never at boot and never in a migration. Prices in minor units: INR
 * paise, USD cents, BEFORE tax (tax is added at checkout from the PLATFORM_SERVICES rules).
 *
 * Premium-only (owner decision 2026-10-27): audience.advanced (segments), campaigns.automation
 * and campaigns.analytics.advanced. Pro has none of the three.
 */
export const PROVISIONAL_PLAN_ENTITLEMENTS: Record<BillingPlanCode, EntitlementValue[]> = {
  FREE: [{ key: 'audience.basic', boolValue: true }],
  PRO: [
    { key: 'audience.basic', boolValue: true },
    { key: 'campaigns.create', boolValue: true },
    { key: 'campaigns.schedule', boolValue: true },
    { key: 'campaigns.analytics.basic', boolValue: true },
    { key: 'campaigns.monthly_email_quota', intValue: 2000 },
  ],
  PREMIUM: [
    { key: 'audience.basic', boolValue: true },
    { key: 'audience.advanced', boolValue: true },
    { key: 'campaigns.create', boolValue: true },
    { key: 'campaigns.schedule', boolValue: true },
    { key: 'campaigns.automation', boolValue: true },
    { key: 'campaigns.analytics.basic', boolValue: true },
    { key: 'campaigns.analytics.advanced', boolValue: true },
    { key: 'campaigns.monthly_email_quota', intValue: 10000 },
    { key: 'billing.premium_support', boolValue: true },
  ],
};

export interface ProvisionalMonthlyPrice {
  plan: BillingPlanCode;
  country: string;
  currency: string;
  amountMinor: number;
}

export const PROVISIONAL_MONTHLY_PRICES: ProvisionalMonthlyPrice[] = [
  { plan: 'FREE', country: 'IN', currency: 'INR', amountMinor: 0 },
  { plan: 'FREE', country: 'US', currency: 'USD', amountMinor: 0 },
  { plan: 'PRO', country: 'IN', currency: 'INR', amountMinor: 99900 },
  { plan: 'PRO', country: 'US', currency: 'USD', amountMinor: 1900 },
  { plan: 'PREMIUM', country: 'IN', currency: 'INR', amountMinor: 299900 },
  { plan: 'PREMIUM', country: 'US', currency: 'USD', amountMinor: 4900 },
];

/** Annual price = monthly x (12 - free months). Default: two months free. */
export const DEFAULT_ANNUAL_FREE_MONTHS = 2;

/**
 * Owner decision 2026-10-27: an ANNUAL price is EXACTLY ten times the monthly one
 * (India Pro INR 9,990, Premium INR 29,990; USA Pro USD 190, Premium USD 490). The loader always
 * uses this; it is not a parameter.
 */
export const ANNUAL_PRICE_MULTIPLIER = 12 - DEFAULT_ANNUAL_FREE_MONTHS;

export function annualAmountMinor(
  monthlyMinor: number,
  freeMonths: number = DEFAULT_ANNUAL_FREE_MONTHS,
): number {
  if (!Number.isInteger(freeMonths) || freeMonths < 0 || freeMonths > 11) {
    throw new Error('freeMonths must be a whole number from 0 to 11');
  }
  return monthlyMinor * (12 - freeMonths);
}

/** The calendar month (UTC) a monthly quota is counted in: "2026-10". */
export function monthlyPeriodKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ── What the API answers ──────────────────────────────────────────────────────────

export type EntitlementSource = 'PLAN' | 'OVERRIDE' | 'DEFAULT';

export interface ResolvedEntitlement {
  key: EntitlementKey;
  kind: EntitlementKind;
  /** The effective value after the kill switch. */
  enabled: boolean;
  /** For numeric entitlements: the effective number (0 when switched off). */
  limit: number | null;
  /** Where the value before the kill switch came from. */
  source: EntitlementSource;
  /** True when the plan or an override grants it but this deployment has it switched off. */
  switchedOffInDeployment: boolean;
}

export interface OrganizationEntitlements {
  organizationId: string;
  planCode: BillingPlanCode;
  subscriptionStatus: SubscriptionStatus | null;
  resolvedAt: string;
  entitlements: ResolvedEntitlement[];
}
