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

// ── Paying through a provider ──────────────────────────────────────────────────────

export type CheckoutReturn =
  'plan-success' | 'plan-cancelled' | 'credits-success' | 'credits-cancelled' | 'portal' | null;

/**
 * What the provider's redirect says the organizer just did. A HINT for which message to show
 * while the page asks the server; it is never taken as proof of payment.
 */
export function checkoutReturn(search: string): CheckoutReturn {
  const q = new URLSearchParams(search);
  if (q.get('checkout') === 'success') return 'plan-success';
  if (q.get('checkout') === 'cancelled') return 'plan-cancelled';
  if (q.get('credits') === 'success') return 'credits-success';
  if (q.get('credits') === 'cancelled') return 'credits-cancelled';
  if (q.get('portal')) return 'portal';
  return null;
}

/** True once the SERVER says a paid plan is live: only a verified provider payment does that. */
export function paidPlanConfirmed(billing: Pick<OrganizerBilling, 'subscription'>): boolean {
  const s = billing.subscription;
  return !!s && s.source === 'PROVIDER' && s.status === 'ACTIVE';
}

/** Which self-service controls a paid plan offers: the Stripe portal, and cancelling. */
export function paidPlanControls(billing: Pick<OrganizerBilling, 'subscription' | 'provider'>): {
  portal: boolean;
  cancel: boolean;
} {
  const s = billing.subscription;
  const paid = !!s && s.source === 'PROVIDER' && ['ACTIVE', 'PAST_DUE', 'GRACE'].includes(s.status);
  return {
    portal: paid && billing.provider === 'STRIPE_BILLING',
    cancel: paid && !s!.cancelAtPeriodEnd,
  };
}

/** How long the return page keeps asking the server before it says "not confirmed yet". */
export const CONFIRM_POLL_MS = 3_000;
export const CONFIRM_POLL_LIMIT = 40;

export const RETURN_MESSAGES: Record<Exclude<CheckoutReturn, null>, string> = {
  'plan-success':
    'Thanks. We are confirming your payment with the payment provider. Your plan starts as soon as the payment is confirmed.',
  'plan-cancelled': 'You did not finish paying. Nothing was charged and your plan has not changed.',
  'credits-success':
    'Thanks. We are confirming your payment. Your credits appear here as soon as the payment is confirmed.',
  'credits-cancelled': 'You did not finish paying. Nothing was charged.',
  portal: 'Changes you made with the payment provider can take a minute to show here.',
};

export const PAYMENT_CONFIRMED = 'Your payment is confirmed. Your plan is active.';

export const PAYMENT_NOT_CONFIRMED_YET =
  'We have not received confirmation of your payment yet. This can take a few minutes. If you were charged and your plan does not start within an hour, contact ETicketsGo support.';

export const CANCEL_DIALOG_TEXT =
  'Your plan stays active until the end of the period you paid for. It does not renew after that, and your organization moves to the Free plan.';

export const DISPUTED_NOTICE =
  'A payment on this account is disputed with your bank or card issuer. ETicketsGo support will contact you.';

export function usageSentence(u: OrganizerBilling['usage']): string {
  if (u.quota === 0 && u.credits === 0) return 'Your plan includes no campaign emails.';
  const parts = [
    `${u.used.toLocaleString('en-US')} of ${u.quota.toLocaleString('en-US')} emails used this month`,
  ];
  if (u.credits > 0) parts.push(`${u.credits.toLocaleString('en-US')} extra credits`);
  return `${parts.join(', ')}. ${u.remaining.toLocaleString('en-US')} left.`;
}
