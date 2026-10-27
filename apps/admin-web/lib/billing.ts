import { ENTITLEMENT_DEFINITIONS, isEntitlementKey } from '@eticketsgo/shared-types';
import type { BadgeTone } from '@eticketsgo/web-kit';

/**
 * Words and number rules for the Billing & subscriptions pages.
 *
 * Display and input only. The API decides what an organization may use; nothing here grants
 * or refuses anything. Every string is plain ASCII English (billing.test.ts holds that).
 */

/** Subscription states in the words a person would say. */
export const SUBSCRIPTION_STATUS_WORDS: Record<string, string> = {
  TRIALING: 'Trial',
  ACTIVE: 'Active',
  PAST_DUE: 'Payment failed',
  GRACE: 'Grace period',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Ended',
  COMPLIMENTARY: 'Free of charge',
};

export const SUBSCRIPTION_STATUSES = Object.keys(SUBSCRIPTION_STATUS_WORDS);

export function subscriptionStatusWords(status: string | null | undefined): string {
  if (!status) return 'No subscription';
  return SUBSCRIPTION_STATUS_WORDS[status] ?? status;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  TRIALING: 'info',
  ACTIVE: 'success',
  PAST_DUE: 'error',
  GRACE: 'warning',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
  COMPLIMENTARY: 'info',
};

export function subscriptionStatusTone(status: string | null | undefined): BadgeTone {
  return (status && STATUS_TONE[status]) || 'neutral';
}

/** Where a subscription came from. */
export const SUBSCRIPTION_SOURCE_WORDS: Record<string, string> = {
  PROVIDER: 'Paid by the organizer',
  ADMIN_COMPLIMENTARY: 'Given free by staff',
  TRIAL: 'Trial',
};

export function subscriptionSourceWords(source: string | null | undefined): string {
  if (!source) return '-';
  return SUBSCRIPTION_SOURCE_WORDS[source] ?? source;
}

/** Where a resolved entitlement's value came from. */
export const ENTITLEMENT_SOURCE_WORDS: Record<string, string> = {
  PLAN: 'Plan',
  OVERRIDE: 'Single feature grant',
  DEFAULT: 'Default',
};

export const LEDGER_REASON_WORDS: Record<string, string> = {
  CONSUMPTION: 'Used',
  CREDIT_GRANT: 'Credits given',
  CREDIT_REVERSAL: 'Credits taken back',
  ADJUSTMENT: 'Correction',
};

export const ADJUSTMENT_KIND_WORDS: Record<string, string> = {
  CREDIT_NOTE: 'Credit note',
  REFUND: 'Refund',
  DISCOUNT: 'Discount',
};

export const INTERVAL_WORDS: Record<string, string> = {
  MONTH: 'Monthly',
  YEAR: 'Yearly',
};

export const PLAN_WORDS: Record<string, string> = {
  FREE: 'Free',
  PRO: 'Pro',
  PREMIUM: 'Premium',
};

export function planWords(code: string | null | undefined): string {
  if (!code) return '-';
  return PLAN_WORDS[code] ?? code;
}

/** The label of an entitlement key, or the key itself when it is not one we know. */
export function entitlementLabel(key: string): string {
  return isEntitlementKey(key) ? ENTITLEMENT_DEFINITIONS[key].label : key;
}

export function entitlementKind(key: string): 'bool' | 'int' {
  return isEntitlementKey(key) ? ENTITLEMENT_DEFINITIONS[key].kind : 'bool';
}

/** A plan or override value in words: "On", "Off", or the number. */
export function entitlementValueText(v: {
  key: string;
  boolValue: boolean | null;
  intValue: number | null;
}): string {
  if (entitlementKind(v.key) === 'int') {
    return v.intValue == null ? '-' : v.intValue.toLocaleString('en-US');
  }
  if (v.boolValue == null) return '-';
  return v.boolValue ? 'On' : 'Off';
}

// ── Numbers ────────────────────────────────────────────────────────────────────

/** Decimal places of a currency's minor unit: 2 for INR and USD, 0 for JPY. */
export function currencyExponent(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * An amount typed in major units ("999", "19.50") as minor units (99900, 1950).
 *
 * Parsed as text, never through floating point: 19.99 * 100 is 1998.9999999999998. Returns
 * null for anything that is not a plain non-negative amount with at most the currency's
 * decimal places.
 */
export function majorToMinor(input: string, currency: string): number | null {
  const text = input.trim().replace(/,/g, '');
  const exponent = currencyExponent(currency);
  const pattern = exponent > 0 ? new RegExp(`^(\\d+)(?:\\.(\\d{1,${exponent}}))?$`) : /^(\d+)$/;
  const match = pattern.exec(text);
  if (!match) return null;
  const whole = match[1];
  const fraction = (match[2] ?? '').padEnd(exponent, '0');
  const minor = Number(`${whole}${fraction}`);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Minor units back to the text a person would type: 99900 INR -> "999", 1950 USD -> "19.50". */
export function minorToMajorInput(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  if (exponent === 0) return String(minor);
  const scale = 10 ** exponent;
  const whole = Math.floor(minor / scale);
  const fraction = minor % scale;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(exponent, '0')}`;
}

/**
 * A percentage off as basis points: "10" -> 1000, "12.5" -> 1250. At most two decimal
 * places, more than 0 and at most 100. Null otherwise.
 */
export function percentToBps(input: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (bps < 1 || bps > 10_000) return null;
  return bps;
}

/** Basis points as a percentage for display: 1250 -> "12.5%". */
export function bpsText(bps: number): string {
  return `${(bps / 100).toString()}%`;
}

/** A whole number from a text box, or null. */
export function wholeNumber(input: string): number | null {
  const text = input.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

// ── Reasons ────────────────────────────────────────────────────────────────────

export const REASON_MIN = 3;

/** The error under a reason box, or undefined when the reason is long enough. */
export function reasonProblem(reason: string): string | undefined {
  return reason.trim().length >= REASON_MIN ? undefined : 'Say why, in a few words.';
}

/** A calendar day from a date input ("2026-11-30") as the end of that day in UTC, or null. */
export function endOfDayIso(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return `${day}T23:59:59.000Z`;
}

/** A calendar day from a date input as the start of that day in UTC, or null. */
export function startOfDayIso(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return `${day}T00:00:00.000Z`;
}

// ── Copy ───────────────────────────────────────────────────────────────────────

export const BILLING_COPY = {
  provisional:
    'The owner confirmed these prices on 2026-10-27. Prices are before tax, and a year costs ten months. Nobody can pay for a plan until paid plans open.',
  readOnly:
    'You can see billing but not change it. Changing plans and prices needs the Billing manage duty.',
  noPaid: 'No paid subscriptions yet. Paid plans are not open.',
  noCatalog:
    'The plan catalogue is not loaded. Until it is, every organization is on the Free plan.',
  noInvoices: 'No invoices. Invoices start when paid plans open.',
  loadExplains:
    'This adds the provisional Free, Pro and Premium plans and their prices. It is safe to run again. It overwrites nothing that is already there.',
  switchedOff: 'Switched off in this deployment',
} as const;
