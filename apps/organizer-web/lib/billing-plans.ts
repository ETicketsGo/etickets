import {
  ENTITLEMENT_DEFINITIONS,
  isEntitlementKey,
  money,
  type BillingPlanCode,
} from '@eticketsgo/shared-types';
import type { BillingPlanPrice, BillingPlanSummary, OrganizerBilling } from '@eticketsgo/web-kit';

/**
 * The words on Billing & plans, kept out of the page so they are tested.
 *
 * Plain ASCII English (house rule). Nothing here pretends paid plans are open: while
 * `billingEnabled` is false every upgrade path says so and offers to contact support.
 */

export const PLAN_NAMES: Record<BillingPlanCode, string> = {
  FREE: 'Free',
  PRO: 'Pro',
  PREMIUM: 'Premium',
};

const date = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

/** One sentence under the current plan's name: why the organization has it, and until when. */
export function planStatusSentence(
  billing: Pick<OrganizerBilling, 'subscription' | 'currentPlanCode'>,
): string {
  const s = billing.subscription;
  if (!s || billing.currentPlanCode === 'FREE') {
    if (s && (s.status === 'TRIALING' || s.status === 'COMPLIMENTARY')) {
      return 'Your free period has ended. You are on the Free plan.';
    }
    return 'You are on the Free plan. Selling tickets is never part of a plan.';
  }
  const plan = PLAN_NAMES[s.planCode];
  switch (s.status) {
    case 'TRIALING':
      return `You are trying ${plan} free of charge until ${date(s.trialEndsAt)}.`;
    case 'COMPLIMENTARY':
      return s.currentPeriodEnd
        ? `ETicketsGo gave you ${plan} free of charge until ${date(s.currentPeriodEnd)}.`
        : `ETicketsGo gave you ${plan} free of charge.`;
    case 'ACTIVE':
      return s.cancelAtPeriodEnd
        ? `Your ${plan} plan ends on ${date(s.currentPeriodEnd)}. It will not renew.`
        : `Your ${plan} plan renews on ${date(s.currentPeriodEnd)}.`;
    case 'PAST_DUE':
      return `Your last ${plan} payment did not go through. You keep ${plan} while it is tried again.`;
    case 'GRACE':
      return `Your ${plan} payment did not go through. You keep ${plan} until ${date(s.graceEndsAt)}.`;
    default:
      return `You are on the ${plan} plan.`;
  }
}

/** "Rs 999 a month" style labels, using the shared money format. */
export function priceLabel(price: BillingPlanPrice): string {
  return `${money(price.amountMinor, price.currency)} ${price.interval === 'YEAR' ? 'a year' : 'a month'}`;
}

/** The lines a plan card lists, in catalogue order: "2,000 campaign emails a month", "Email campaigns". */
export function planFeatureLines(plan: Pick<BillingPlanSummary, 'entitlements'>): string[] {
  const lines: string[] = [];
  for (const e of plan.entitlements) {
    if (!isEntitlementKey(e.key)) continue;
    const def = ENTITLEMENT_DEFINITIONS[e.key];
    if (def.kind === 'int') {
      if ((e.intValue ?? 0) > 0) {
        lines.push(`${(e.intValue as number).toLocaleString('en-US')} campaign emails a month`);
      }
    } else if (e.boolValue) {
      lines.push(def.label);
    }
  }
  return lines;
}

/** What an upgrade button says and does while paid plans are closed or open. */
export function upgradeAction(
  billing: Pick<OrganizerBilling, 'billingEnabled' | 'currentPlanCode'>,
  plan: Pick<BillingPlanSummary, 'code' | 'prices'>,
): { kind: 'current' | 'none' | 'ask' | 'checkout'; label: string } {
  if (plan.code === billing.currentPlanCode) return { kind: 'current', label: 'Your plan' };
  if (plan.code === 'FREE') return { kind: 'none', label: '' };
  const name = PLAN_NAMES[plan.code];
  if (!billing.billingEnabled || plan.prices.length === 0) {
    return { kind: 'ask', label: `Ask about ${name}` };
  }
  return { kind: 'checkout', label: `Upgrade to ${name}` };
}

export const PAID_PLANS_CLOSED =
  'Paid plans are not open yet. Everything you use today stays free. Prices shown here are provisional and can change before paid plans open.';

export const ASK_DIALOG_TEXT =
  'Paid plans are not open yet, so there is nothing to pay for now. Tell us what you want to do and we will contact you about a plan or a free trial.';

export const NO_INVOICES = 'No invoices yet. Invoices start when you pay for a plan.';

export function usageSentence(u: OrganizerBilling['usage']): string {
  if (u.quota === 0 && u.credits === 0) return 'Your plan includes no campaign emails.';
  const parts = [
    `${u.used.toLocaleString('en-US')} of ${u.quota.toLocaleString('en-US')} emails used this month`,
  ];
  if (u.credits > 0) parts.push(`${u.credits.toLocaleString('en-US')} extra credits`);
  return `${parts.join(', ')}. ${u.remaining.toLocaleString('en-US')} left.`;
}
