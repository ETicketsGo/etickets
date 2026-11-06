import { API_URL, ApiRequestError, api, tokenStore, type Paged } from '@eticketsgo/web-kit';
import { askForStepUp, reportMfaSetup } from './step-up-bridge';

/**
 * Platform fee policies: an exception to the booking fee schedule for one event or one
 * organizer (waive the fee, charge a fixed fee, or charge a different percentage).
 *
 * The types mirror the API (`/admin/platform-fee-policies`). The helpers below are pure, so the
 * money conversions and the words an operator reads are tested without a browser.
 */

export type FeePolicyScope = 'EVENT' | 'ORGANIZATION';
export type FeePolicyKind = 'WAIVE' | 'FIXED' | 'PERCENT' | 'COMBINED' | 'FIXED_PER_TICKET';
export type FeePolicyStatus =
  'ACTIVE' | 'INACTIVE' | 'EXPIRED' | 'EXHAUSTED' | 'PENDING_APPROVAL' | 'REJECTED' | 'WITHDRAWN';
export type FeePolicyEffectiveStatus = FeePolicyStatus | 'SCHEDULED';
export type FeeMode = 'CUSTOMER_PAYS' | 'ORGANIZER_PAYS' | 'SHARED';

export interface PlatformFeePolicyView {
  id: string;
  scope: FeePolicyScope;
  eventId: string | null;
  eventTitle: string | null;
  organizationId: string;
  organizationName: string | null;
  kind: FeePolicyKind;
  feeMinor: number | null;
  percentBps: number | null;
  minFeeMinor: number | null;
  maxFeeMinor: number | null;
  currency: string | null;
  startsAt: string;
  endsAt: string | null;
  maxOrders: number | null;
  usedOrders: number;
  bookingCount: number;
  status: FeePolicyStatus;
  effectiveStatus: FeePolicyEffectiveStatus;
  reason: string;
  approvalReference: string | null;
  createdByUserId: string;
  createdByName: string | null;
  createdAt: string;
  deactivatedAt: string | null;
  deactivatedByUserId: string | null;
  deactivationReason: string | null;
  approvedByUserId: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  approvalNote: string | null;
  rejectedByUserId: string | null;
  rejectedByName: string | null;
  rejectedAt: string | null;
  rejectionNote: string | null;
  /** A request to switch the policy off, waiting for a second administrator. */
  deactivationRequest: {
    requestedByUserId: string;
    requestedByName: string | null;
    requestedAt: string | null;
    reason: string | null;
  } | null;
  emergencyDeactivation: boolean;
  version: number;
}

export interface FeePolicyHistoryEntry {
  id: string;
  action:
    | 'CREATED'
    | 'APPROVED'
    | 'REJECTED'
    | 'WITHDRAWN'
    | 'DEACTIVATION_REQUESTED'
    | 'DEACTIVATION_REJECTED'
    | 'DEACTIVATION_WITHDRAWN'
    | 'DEACTIVATED'
    | 'EMERGENCY_DEACTIVATED'
    | 'EXHAUSTED'
    | 'REOPENED';
  actorUserId: string | null;
  actorName: string | null;
  reason: string | null;
  createdAt: string;
}

/** What on a policy waits for a second person: the policy itself, or switching it off. */
export type PendingDecision = 'POLICY' | 'DEACTIVATION';

export type PlatformFeePolicyDetail = PlatformFeePolicyView & {
  history: FeePolicyHistoryEntry[];
  pendingDecision: PendingDecision | null;
  /** Why the person looking may not decide on what is pending: they proposed it. */
  viewerBlockedReason: 'CREATOR' | 'REQUESTER' | null;
};

/** The estimated effect of the pending decision on recent orders, per currency. */
export interface FeePolicyImpact {
  policyId: string;
  mode: 'APPROVE' | 'DEACTIVATE';
  windowDays: number;
  orders: number;
  direction: 'INCREASE' | 'DECREASE' | 'MIXED' | 'NONE';
  currencies: Array<{
    currency: string;
    orders: number;
    beforeFeeMinor: number;
    afterFeeMinor: number;
    deltaMinor: number;
    higher: number;
    lower: number;
    unchanged: number;
    largestIncreaseMinor: number;
    largestDecreaseMinor: number;
  }>;
}

export interface FeeLines {
  bookingFeeMinor: number;
  paymentFeeMinor: number;
  customerFeeMinor: number;
  organizerFeeMinor: number;
  totalMinor: number;
}

export interface FeePolicyPreview {
  currency: string;
  subtotalMinor: number;
  feeMode: FeeMode;
  schedule: FeeLines;
  withPolicy: FeeLines;
  feeWaivedMinor: number;
  appliesToBasket: boolean;
  currentPolicy: PlatformFeePolicyView | null;
}

/** The terms, as the create and preview bodies carry them. */
export interface FeePolicyTerms {
  scope: FeePolicyScope;
  eventId?: string;
  organizationId?: string;
  kind: FeePolicyKind;
  feeMinor?: number;
  percentBps?: number;
  minFeeMinor?: number;
  maxFeeMinor?: number;
  currency?: string;
}

export interface CreateFeePolicyBody extends FeePolicyTerms {
  startsAt?: string;
  endsAt?: string;
  maxOrders?: number;
  reason: string;
  approvalReference?: string;
}

export interface PreviewFeePolicyBody extends FeePolicyTerms {
  currency: string;
  subtotalMinor: number;
  /** Paid tickets in the sample basket. Only a per-ticket fee (COMBINED, FIXED_PER_TICKET) reads it. */
  ticketCount?: number;
  feeMode?: FeeMode;
}

export interface FeePolicyListParams {
  scope?: FeePolicyScope;
  status?: FeePolicyEffectiveStatus;
  q?: string;
  organizationId?: string;
  eventId?: string;
  page?: number;
  pageSize?: number;
}

/* ── Requests ────────────────────────────────────────────────────────────────────── */

/*
  These endpoints are not in the shared `api` client yet, so this file sends them itself and
  keeps the shared client's behaviour where it matters: the bearer token, one silent session
  refresh on 401 (by asking `/auth/me` through the shared client, which refreshes), the step-up
  dialog on MFA_STEP_UP_REQUIRED with one repeat, and the API's own error sentence and code in
  an `ApiRequestError`, so `errorMessage` and the 409 handling read it like any other error.
*/
async function send<T>(
  path: string,
  init: RequestInit = {},
  tried: { refreshed?: boolean; steppedUp?: boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (tokenStore.access) headers.set('authorization', `Bearer ${tokenStore.access}`);
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) return data as T;

  const err = (data ?? {}) as {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
    correlationId?: string;
  };
  if (res.status === 401 && !tried.refreshed && tokenStore.refresh) {
    const ok = await api.auth.me().then(
      () => true,
      () => false,
    );
    if (ok) return send<T>(path, init, { ...tried, refreshed: true });
  }
  if (res.status === 403 && err.code === 'MFA_STEP_UP_REQUIRED' && !tried.steppedUp) {
    if (await askForStepUp()) return send<T>(path, init, { ...tried, steppedUp: true });
  }
  if (
    res.status === 403 &&
    (err.code === 'MFA_SETUP_REQUIRED' || err.code === 'MFA_NOT_CONFIGURED')
  ) {
    reportMfaSetup(err.code, err.message ?? '');
  }
  throw new ApiRequestError(
    err.code ?? 'ERROR',
    err.message ?? 'Request failed.',
    err.details,
    err.correlationId,
    res.status,
  );
}

function query(params: Record<string, unknown>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)] as [string, string]);
  const s = new URLSearchParams(entries).toString();
  return s ? `?${s}` : '';
}

const BASE = '/admin/platform-fee-policies';

export const feePolicyApi = {
  list: (params: FeePolicyListParams) =>
    send<Paged<PlatformFeePolicyView>>(`${BASE}${query({ ...params })}`),
  get: (id: string) => send<PlatformFeePolicyDetail>(`${BASE}/${encodeURIComponent(id)}`),
  preview: (body: PreviewFeePolicyBody) =>
    send<FeePolicyPreview>(`${BASE}/preview`, { method: 'POST', body: JSON.stringify(body) }),
  create: (body: CreateFeePolicyBody) =>
    send<PlatformFeePolicyView>(BASE, { method: 'POST', body: JSON.stringify(body) }),
  /** Asks to switch the policy off. A second administrator approves it. */
  deactivate: (id: string, body: { reason: string; version: number }) =>
    post(id, 'deactivate', body),
  impact: (id: string, days = 30) =>
    send<FeePolicyImpact>(`${BASE}/${encodeURIComponent(id)}/impact${query({ days })}`),
  approve: (id: string, body: { version: number; note?: string }) => post(id, 'approve', body),
  reject: (id: string, body: { version: number; note: string }) => post(id, 'reject', body),
  withdraw: (id: string, body: { version: number }) => post(id, 'withdraw', body),
  approveDeactivation: (id: string, body: { version: number; note?: string }) =>
    post(id, 'deactivation/approve', body),
  rejectDeactivation: (id: string, body: { version: number; note: string }) =>
    post(id, 'deactivation/reject', body),
  withdrawDeactivation: (id: string, body: { version: number }) =>
    post(id, 'deactivation/withdraw', body),
  emergencyDeactivate: (id: string, body: { version: number; reason: string }) =>
    post(id, 'emergency-deactivate', body),
};

function post(id: string, action: string, body: unknown) {
  return send<PlatformFeePolicyView>(`${BASE}/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** The policy a 409 says this one overlaps, when the API names it. */
export function conflictingPolicyId(err: unknown): string | null {
  if (!(err instanceof ApiRequestError)) return null;
  const id = err.details?.conflictingPolicyId;
  return typeof id === 'string' && id ? id : null;
}

/** A refusal because somebody else changed the record first, or it overlaps a live one. */
export function isConflict(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === 409 || err.code === 'CONFLICT');
}

/* ── Money and words ─────────────────────────────────────────────────────────────── */

/** Digits after the point in a currency (2 for INR and USD, 0 for JPY). */
export function currencyExponent(currency: string | null | undefined): number {
  if (!currency) return 2;
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** Minor units as a plain number with the currency code: 1000 INR -> "10.00 INR". ASCII. */
export function plainAmount(minor: number, currency: string | null | undefined): string {
  const exp = currencyExponent(currency);
  const value = (minor / 10 ** exp).toFixed(exp);
  return currency ? `${value} ${currency}` : value;
}

/**
 * A major-unit amount typed by a person, in minor units. Null for anything that is not a plain
 * non-negative number with at most the currency's decimals ("10", "10.5", "10.50").
 */
export function toMinorUnits(value: string, currency?: string | null): number | null {
  const exp = currencyExponent(currency);
  const v = value.trim();
  const pattern = exp === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${exp}})?$`);
  if (!pattern.test(v)) return null;
  return Math.round(Number(v) * 10 ** exp);
}

/** A percentage typed by a person (2.5) in basis points (250). Null when not a number. */
export function percentToBps(value: string): number | null {
  const v = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
}

/** Basis points as a percentage without trailing zeros: 250 -> "2.5", 500 -> "5". */
export function bpsToPercent(bps: number): string {
  return String(Number((bps / 100).toFixed(2)));
}

/** The policy's terms in a few words: "Fee waived", "Fixed fee 10.00 INR", "5% (min 2.00 ...)". */
export function termsLabel(
  p: Pick<
    PlatformFeePolicyView,
    'kind' | 'feeMinor' | 'percentBps' | 'minFeeMinor' | 'maxFeeMinor' | 'currency'
  >,
): string {
  if (p.kind === 'WAIVE') return 'Fee waived';
  if (p.kind === 'FIXED') return `Fixed fee ${plainAmount(p.feeMinor ?? 0, p.currency)}`;
  const pct = `${bpsToPercent(p.percentBps ?? 0)}%`;
  const exp = currencyExponent(p.currency);
  const n = (minor: number) => (minor / 10 ** exp).toFixed(exp);
  const bounds: string[] = [];
  if (p.minFeeMinor !== null) bounds.push(`min ${n(p.minFeeMinor)}`);
  if (p.maxFeeMinor !== null) bounds.push(`max ${n(p.maxFeeMinor)}`);
  const withBounds = (text: string) =>
    bounds.length === 0
      ? text
      : `${text} (${bounds.join(', ')}${p.currency ? ` ${p.currency}` : ''})`;
  if (p.kind === 'COMBINED') {
    return withBounds(`${pct} + ${plainAmount(p.feeMinor ?? 0, p.currency)} per ticket`);
  }
  if (p.kind === 'FIXED_PER_TICKET') {
    return withBounds(`${plainAmount(p.feeMinor ?? 0, p.currency)} per ticket`);
  }
  return withBounds(pct);
}

/** Which currencies the policy covers, in words. */
export function currencyScopeLabel(currency: string | null): string {
  return currency ? `${currency} orders only` : 'Any currency';
}

/** The order limit and use: "3 / 10 orders" or "No limit". */
export function ordersLabel(p: Pick<PlatformFeePolicyView, 'usedOrders' | 'maxOrders'>): string {
  return p.maxOrders === null ? 'No limit' : `${p.usedOrders} / ${p.maxOrders} orders`;
}

export const STATUS_LABEL: Record<FeePolicyEffectiveStatus, string> = {
  ACTIVE: 'Active',
  SCHEDULED: 'Scheduled',
  EXPIRED: 'Expired',
  EXHAUSTED: 'Used up',
  INACTIVE: 'Inactive',
  PENDING_APPROVAL: 'Waiting for approval',
  REJECTED: 'Not approved',
  WITHDRAWN: 'Withdrawn',
};

export const STATUS_TONE: Record<
  FeePolicyEffectiveStatus,
  'success' | 'info' | 'warning' | 'neutral'
> = {
  ACTIVE: 'success',
  SCHEDULED: 'info',
  EXPIRED: 'neutral',
  EXHAUSTED: 'warning',
  INACTIVE: 'neutral',
  PENDING_APPROVAL: 'warning',
  REJECTED: 'neutral',
  WITHDRAWN: 'neutral',
};

export const KIND_LABEL: Record<FeePolicyKind, string> = {
  WAIVE: 'Waive the booking fee',
  FIXED: 'Fixed booking fee',
  PERCENT: 'Percentage booking fee',
  COMBINED: 'Percentage plus a fixed fee per ticket',
  FIXED_PER_TICKET: 'Fixed fee per ticket',
};

export const HISTORY_LABEL: Record<FeePolicyHistoryEntry['action'], string> = {
  CREATED: 'Created and sent for approval',
  APPROVED: 'Approved',
  REJECTED: 'Not approved',
  WITHDRAWN: 'Withdrawn by its maker',
  DEACTIVATION_REQUESTED: 'Switch-off requested',
  DEACTIVATION_REJECTED: 'Switch-off not approved',
  DEACTIVATION_WITHDRAWN: 'Switch-off request withdrawn',
  DEACTIVATED: 'Switched off (approved)',
  EMERGENCY_DEACTIVATED: 'Switched off in an emergency',
  EXHAUSTED: 'Order limit reached',
  REOPENED: 'Reopened',
};

/**
 * Whether somebody can ask to switch the policy off: live now, or waiting to start, and no
 * request already waiting. The switch-off itself needs a second administrator.
 */
export function canDeactivate(
  p: Pick<PlatformFeePolicyView, 'effectiveStatus'> &
    Partial<Pick<PlatformFeePolicyView, 'deactivationRequest'>>,
): boolean {
  return (
    (p.effectiveStatus === 'ACTIVE' || p.effectiveStatus === 'SCHEDULED') && !p.deactivationRequest
  );
}

/** Whether the emergency switch-off applies: the policy is approved and not yet off. */
export function canEmergencyDeactivate(p: Pick<PlatformFeePolicyView, 'effectiveStatus'>): boolean {
  return (
    p.effectiveStatus === 'ACTIVE' ||
    p.effectiveStatus === 'SCHEDULED' ||
    p.effectiveStatus === 'EXHAUSTED'
  );
}

/** Which way buyers' booking fees move if the pending decision is approved, in words. */
export function impactDirectionLabel(direction: FeePolicyImpact['direction']): string {
  switch (direction) {
    case 'INCREASE':
      return 'Buyers would pay MORE in booking fees.';
    case 'DECREASE':
      return 'Buyers would pay LESS in booking fees.';
    case 'MIXED':
      return 'Some buyers would pay more and some less.';
    default:
      return 'No recent order would pay a different booking fee.';
  }
}

/* ── The form ────────────────────────────────────────────────────────────────────── */

/** The form as typed: strings, so a half-typed value does not fight the input. */
export interface FeePolicyDraft {
  scope: FeePolicyScope;
  targetId: string;
  kind: FeePolicyKind;
  fixedAmount: string;
  percent: string;
  minAmount: string;
  maxAmount: string;
  currency: string;
  /** `datetime-local` values in the operator's own time zone. Empty means now / no end. */
  startsAt: string;
  endsAt: string;
  maxOrders: string;
  reason: string;
  approvalReference: string;
}

export const BLANK_DRAFT: FeePolicyDraft = {
  scope: 'EVENT',
  targetId: '',
  kind: 'WAIVE',
  fixedAmount: '',
  percent: '',
  minAmount: '',
  maxAmount: '',
  currency: '',
  startsAt: '',
  endsAt: '',
  maxOrders: '',
  reason: '',
  approvalReference: '',
};

export const MIN_REASON = 10;

export type DraftErrors = Partial<Record<keyof FeePolicyDraft, string>>;

/** Whether the currency field must be filled for these terms. */
export function currencyRequired(d: Pick<FeePolicyDraft, 'kind' | 'minAmount' | 'maxAmount'>) {
  return (
    d.kind === 'FIXED' ||
    d.kind === 'COMBINED' ||
    d.kind === 'FIXED_PER_TICKET' ||
    (d.kind === 'PERCENT' && (!!d.minAmount.trim() || !!d.maxAmount.trim()))
  );
}

/** The terms in API form (used by the preview too), or the errors that stop them being sent. */
export function draftToTerms(d: FeePolicyDraft): { terms?: FeePolicyTerms; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const targetId = d.targetId.trim();
  if (!targetId) {
    errors.targetId = d.scope === 'EVENT' ? 'Choose an event.' : 'Choose an organizer.';
  }
  const currency = d.currency.trim().toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    errors.currency = 'Use a three-letter currency code, like INR or USD.';
  } else if (!currency && currencyRequired(d)) {
    errors.currency = 'Enter the currency for this amount.';
  }
  const terms: FeePolicyTerms = {
    scope: d.scope,
    ...(d.scope === 'EVENT' ? { eventId: targetId } : { organizationId: targetId }),
    kind: d.kind,
    ...(currency ? { currency } : {}),
  };
  if (d.kind === 'FIXED') {
    const fee = toMinorUnits(d.fixedAmount, currency);
    if (fee === null) errors.fixedAmount = 'Enter the fee as a number, like 10 or 10.50.';
    else terms.feeMinor = fee;
  }
  if (d.kind === 'COMBINED') {
    // A percentage of the order plus a fixed amount per paid ticket. Optional lowest and
    // highest fee for the whole order (owner decision 2026-10-29), checked below.
    const bps = percentToBps(d.percent);
    if (bps === null || bps <= 0 || bps > 10000) {
      errors.percent = 'Enter a percentage above 0 and up to 100, like 3.';
    } else terms.percentBps = bps;
    const fee = toMinorUnits(d.fixedAmount, currency);
    if (fee === null || fee <= 0) {
      errors.fixedAmount = 'Enter the fixed amount per ticket, like 5 or 5.50.';
    } else terms.feeMinor = fee;
  }
  if (d.kind === 'FIXED_PER_TICKET') {
    // A fixed amount for each paid ticket, and no percentage. Optional lowest and highest fee.
    const fee = toMinorUnits(d.fixedAmount, currency);
    if (fee === null) errors.fixedAmount = 'Enter the fee per ticket as a number, like 5 or 5.50.';
    else terms.feeMinor = fee;
  }
  if (d.kind === 'PERCENT') {
    const bps = percentToBps(d.percent);
    if (bps === null || bps <= 0 || bps > 10000) {
      errors.percent = 'Enter a percentage above 0 and up to 100, like 2.5.';
    } else terms.percentBps = bps;
  }
  if (d.kind === 'PERCENT' || d.kind === 'COMBINED' || d.kind === 'FIXED_PER_TICKET') {
    if (d.minAmount.trim()) {
      const min = toMinorUnits(d.minAmount, currency);
      if (min === null) errors.minAmount = 'Enter the lowest fee as a number.';
      else terms.minFeeMinor = min;
    }
    if (d.maxAmount.trim()) {
      const max = toMinorUnits(d.maxAmount, currency);
      if (max === null) errors.maxAmount = 'Enter the highest fee as a number.';
      else terms.maxFeeMinor = max;
    }
    if (
      terms.minFeeMinor !== undefined &&
      terms.maxFeeMinor !== undefined &&
      terms.maxFeeMinor < terms.minFeeMinor
    ) {
      errors.maxAmount = 'The highest fee must not be lower than the lowest fee.';
    }
  }
  return Object.keys(errors).length ? { errors } : { terms, errors };
}

/** The whole create body, or the errors. `now` is a parameter so the end-date check is testable. */
export function draftToCreateBody(
  d: FeePolicyDraft,
  now: Date = new Date(),
): { body?: CreateFeePolicyBody; errors: DraftErrors } {
  const { terms, errors } = draftToTerms(d);
  const all: DraftErrors = { ...errors };
  const starts = d.startsAt ? new Date(d.startsAt) : null;
  const ends = d.endsAt ? new Date(d.endsAt) : null;
  if (starts && Number.isNaN(starts.getTime())) all.startsAt = 'Enter a valid start date.';
  if (ends && Number.isNaN(ends.getTime())) all.endsAt = 'Enter a valid end date.';
  else if (ends && ends.getTime() <= (starts ?? now).getTime()) {
    all.endsAt = 'The end must be after the start.';
  }
  let maxOrders: number | undefined;
  if (d.maxOrders.trim()) {
    if (!/^\d+$/.test(d.maxOrders.trim()) || Number(d.maxOrders) < 1) {
      all.maxOrders = 'Enter a whole number of orders, 1 or more.';
    } else maxOrders = Number(d.maxOrders);
  }
  const reason = d.reason.trim();
  if (reason.length < MIN_REASON) {
    all.reason = `Write at least ${MIN_REASON} characters about why.`;
  }
  if (Object.keys(all).length || !terms) return { errors: all };
  const approvalReference = d.approvalReference.trim();
  return {
    body: {
      ...terms,
      ...(starts ? { startsAt: starts.toISOString() } : {}),
      ...(ends ? { endsAt: ends.toISOString() } : {}),
      ...(maxOrders !== undefined ? { maxOrders } : {}),
      reason,
      ...(approvalReference ? { approvalReference } : {}),
    },
    errors: {},
  };
}
