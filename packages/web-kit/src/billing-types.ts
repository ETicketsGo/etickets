/**
 * Response shapes of the organizer billing API, as the consoles read them.
 *   organizer: GET /organizations/:id/billing, /entitlements, /billing/invoices
 *   admin:     /admin/billing/*
 * The vocabulary (plan codes, statuses, entitlement keys) is `@eticketsgo/shared-types`
 * `entitlements.ts`.
 */
import type {
  BillingPlanCode,
  OrganizationEntitlements,
  ResolvedEntitlement,
  SubscriptionSource,
  SubscriptionStatus,
} from '@eticketsgo/shared-types';

export interface BillingUsage {
  key: string;
  periodKey: string;
  quota: number;
  used: number;
  credits: number;
  remaining: number;
}

export interface BillingPlanPrice {
  id: string;
  interval: 'MONTH' | 'YEAR';
  amountMinor: number;
  currency: string;
  trialDays: number | null;
}

export interface BillingPlanSummary {
  code: BillingPlanCode;
  name: string;
  description: string | null;
  entitlements: { key: string; boolValue: boolean | null; intValue: number | null }[];
  /** Active prices in the organization's country only. Empty when none are set there. */
  prices: BillingPlanPrice[];
}

export interface OrganizerBilling {
  organizationId: string;
  /** False while paid plans are not open: no checkout can start. */
  billingEnabled: boolean;
  catalogLoaded: boolean;
  pricesProvisional: boolean;
  /** ISO alpha-2 of the organization's registered country, or null when unknown. */
  country: string | null;
  currentPlanCode: BillingPlanCode;
  subscription: {
    status: SubscriptionStatus;
    source: SubscriptionSource;
    planCode: BillingPlanCode;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    graceEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
    scheduledPlanCode: BillingPlanCode | null;
  } | null;
  entitlements: ResolvedEntitlement[];
  usage: BillingUsage;
  plans: BillingPlanSummary[];
  /** Who takes this account's payments, once it has paid through one. */
  provider?: BillingProviderName;
  /** The provider that serves this country (STRIPE_BILLING for US, RAZORPAY_BILLING for IN). */
  providerForCountry?: BillingProviderName;
  /** A payment on this account is disputed (chargeback): staff are reviewing it. */
  disputed?: boolean;
  /** One-time email credit packs on sale in this country, at this country's price. */
  creditPacks?: CreditPackOffer[];
}

export type BillingProviderName = 'NONE' | 'MOCK' | 'STRIPE_BILLING' | 'RAZORPAY_BILLING';

export interface CreditPackOffer {
  code: string;
  name: string;
  credits: number;
  currency: string;
  amountMinor: number;
}

/** A hosted provider page to send the organizer to. Nothing is granted until it is paid. */
export interface BillingCheckoutSession {
  provider: BillingProviderName;
  sessionRef: string;
  url: string;
}

export interface OrganizerInvoiceRow {
  id: string;
  number: string | null;
  status: 'DRAFT' | 'OPEN' | 'PAID' | 'VOID' | 'REFUNDED';
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  issuedAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export type { OrganizationEntitlements };

// ── Admin ──────────────────────────────────────────────────────────────────────

export interface AdminBillingPrice {
  id: string;
  planId: string;
  country: string;
  currency: string;
  interval: 'MONTH' | 'YEAR';
  amountMinor: number;
  trialDays: number | null;
  providerPriceRefTest: string | null;
  providerPriceRefLive: string | null;
  active: boolean;
  createdAt: string;
}

export interface AdminBillingPlan {
  id: string;
  code: BillingPlanCode;
  name: string;
  description: string | null;
  active: boolean;
  sortOrder: number;
  prices: AdminBillingPrice[];
  entitlements: { id: string; key: string; boolValue: boolean | null; intValue: number | null }[];
}

export interface AdminSubscriptionRow {
  id: string;
  organizationId: string;
  organizationName: string | null;
  country: string;
  planCode: BillingPlanCode;
  status: SubscriptionStatus;
  source: SubscriptionSource;
  current: boolean;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  price: { amountMinor: number; currency: string; interval: 'MONTH' | 'YEAR' } | null;
  createdAt: string;
}

export interface AdminSubscriptionPage {
  total: number;
  page: number;
  pageSize: number;
  items: AdminSubscriptionRow[];
}

export interface AdminSubscriptionDetail {
  id: string;
  status: SubscriptionStatus;
  source: SubscriptionSource;
  plan: { code: BillingPlanCode; name: string };
  price: { amountMinor: number; currency: string; interval: 'MONTH' | 'YEAR' } | null;
  scheduledPlan: { code: BillingPlanCode } | null;
  currentPeriodStart: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  currentKey: string | null;
  note: string | null;
  createdAt: string;
  endedAt: string | null;
}

export interface AdminLedgerRow {
  id: string;
  key: string;
  delta: number;
  reason: 'CONSUMPTION' | 'CREDIT_GRANT' | 'CREDIT_REVERSAL' | 'ADJUSTMENT';
  periodKey: string;
  note: string | null;
  createdAt: string;
}

export interface AdminOverrideRow {
  id: string;
  key: string;
  boolValue: boolean | null;
  intValue: number | null;
  startsAt: string;
  endsAt: string | null;
  reason: string;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
}

export interface AdminAdjustmentRow {
  id: string;
  kind: 'CREDIT_NOTE' | 'REFUND' | 'DISCOUNT';
  amountMinor: number | null;
  percentOffBps: number | null;
  currency: string | null;
  startsAt: string;
  endsAt: string | null;
  reason: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface AdminBillingAccountDetail {
  organization: { id: string; name: string; status: string; registeredCountry: string | null };
  account: {
    id: string;
    country: string;
    currency: string;
    provider: string;
    billingEmail: string | null;
    taxId: string | null;
  } | null;
  currentSubscription: AdminSubscriptionDetail | null;
  subscriptions: AdminSubscriptionDetail[];
  invoices: (OrganizerInvoiceRow & { createdAt: string })[];
  payments: {
    id: string;
    provider: string;
    providerPaymentRef: string | null;
    amountMinor: number;
    currency: string;
    status: string;
    verifiedAt: string | null;
    createdAt: string;
  }[];
  adjustments: AdminAdjustmentRow[];
  overrides: AdminOverrideRow[];
  ledger: AdminLedgerRow[];
  entitlements: OrganizationEntitlements;
  usage: BillingUsage;
}

export interface AdminBillingMetrics {
  windowDays: number;
  from: string;
  to: string;
  currentByStatus: Record<string, number>;
  paidSubscriptions: number;
  trials: number;
  complimentary: number;
  mrr: { currency: string; mrrMinor: number; arrMinor: number; subscriptions: number }[];
  mrrByPlan: { planCode: string; currency: string; mrrMinor: number; subscriptions: number }[];
  revenueByPlan: { planCode: string; currency: string; totalMinor: number; invoices: number }[];
  churn: { cancellations: number; paidAtStart: number; rate: number | null };
}
