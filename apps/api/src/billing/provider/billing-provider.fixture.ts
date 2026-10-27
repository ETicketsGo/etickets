import { createHmac } from 'node:crypto';
import Stripe from 'stripe';
import type { RazorpayBillingApi } from './razorpay-subscriptions.provider';
import {
  RAZORPAY_PURPOSE_CREDIT_PACK,
  RAZORPAY_PURPOSE_SUBSCRIPTION,
} from './razorpay-subscriptions.provider';
import { STRIPE_PURPOSE_CREDIT_PACK, STRIPE_PURPOSE_SUBSCRIPTION } from './stripe-billing.provider';

/**
 * Recorded-shape provider objects and offline fake clients for the billing provider tests.
 *
 * The payload shapes follow the providers' documented objects (Stripe API 2026-06-24.dahlia:
 * invoice `parent.subscription_details`, `lines[].pricing.price_details`, subscription item
 * periods; Razorpay webhook envelope `{ event, payload: { subscription, payment } }`). Nothing
 * here touches the network: signatures are made with the SDK's own test helper (Stripe) or the
 * documented HMAC (Razorpay), and every "provider API" call is answered from `state`.
 */
type Obj = Record<string, unknown>;
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

export const STRIPE_TEST_WEBHOOK_SECRET = 'whsec_test_billing_fixture';
export const RAZORPAY_TEST_WEBHOOK_SECRET = 'rzp_billing_fixture_webhook_secret';

// ── Stripe ───────────────────────────────────────────────────────────────────────

export interface StripeState {
  subs: Record<string, Obj>;
  invoices: Record<string, Obj>;
  sessions: Record<string, Obj>;
  disputes: Record<string, Obj>;
  calls: { method: string; args: unknown[] }[];
  /** When set, every read throws this (to simulate the provider being unreachable). */
  failReads?: Error | null;
  /** Tax Rates created on the account (our TaxRule rates, tax-exclusive). */
  taxRates?: Obj[];
}

export function stripeState(): StripeState {
  return { subs: {}, invoices: {}, sessions: {}, disputes: {}, calls: [], failReads: null };
}

/** Offline Stripe client: real webhook verification, provider objects from `state`. */
export function fakeStripe(state: StripeState): Stripe {
  const real = new Stripe('sk_test_offline_fixture');
  const read = async <T>(v: T | undefined, what: string): Promise<T> => {
    if (state.failReads) throw state.failReads;
    if (!v)
      throw Object.assign(new Error(`No such ${what}`), { type: 'StripeInvalidRequestError' });
    return JSON.parse(JSON.stringify(v)) as T;
  };
  const log = (method: string, args: unknown[]) => state.calls.push({ method, args });
  return {
    webhooks: real.webhooks,
    customers: {
      create: async (...args: unknown[]) => {
        log('customers.create', args);
        return { id: `cus_${state.calls.length}` };
      },
    },
    checkout: {
      sessions: {
        create: async (...args: unknown[]) => {
          log('checkout.sessions.create', args);
          const id = `cs_test_${state.calls.length}`;
          return { id, url: `https://checkout.stripe.test/${id}` };
        },
        retrieve: async (id: string) => read(state.sessions[id], 'checkout session'),
      },
    },
    billingPortal: {
      sessions: {
        create: async (...args: unknown[]) => {
          log('billingPortal.sessions.create', args);
          return { url: 'https://billing.stripe.test/session' };
        },
      },
    },
    subscriptions: {
      retrieve: async (id: string) => read(state.subs[id], 'subscription'),
      update: async (id: string, p: Obj) => {
        log('subscriptions.update', [id, p]);
        const s = await read(state.subs[id], 'subscription');
        state.subs[id] = { ...s, ...p };
        return state.subs[id];
      },
    },
    invoices: { retrieve: async (id: string) => read(state.invoices[id], 'invoice') },
    disputes: { retrieve: async (id: string) => read(state.disputes[id], 'dispute') },
    taxRates: {
      list: async () => ({ data: JSON.parse(JSON.stringify(state.taxRates ?? [])) }),
      create: async (p: Obj) => {
        log('taxRates.create', [p]);
        const rate = { id: `txr_${state.calls.length}`, ...p };
        (state.taxRates ??= []).push(rate);
        return rate;
      },
    },
  } as unknown as Stripe;
}

export function stripeSubscription(o: {
  id: string;
  customer: string;
  price: string;
  organizationId: string;
  status?: string;
  start: Date;
  end: Date;
  cancelAtPeriodEnd?: boolean;
  latestInvoice?: Obj | null;
}): Obj {
  return {
    id: o.id,
    object: 'subscription',
    customer: o.customer,
    status: o.status ?? 'active',
    cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    metadata: { organizationId: o.organizationId, etg_purpose: STRIPE_PURPOSE_SUBSCRIPTION },
    latest_invoice: o.latestInvoice ?? null,
    items: {
      data: [
        {
          price: { id: o.price },
          current_period_start: unix(o.start),
          current_period_end: unix(o.end),
        },
      ],
    },
  };
}

export function stripeInvoice(o: {
  id: string;
  customer: string;
  subscription: string;
  organizationId: string;
  price: string;
  amount: number;
  currency: string;
  start: Date;
  end: Date;
  status?: string;
  tax?: number;
  /** When Stripe says it was paid; the invoice number series follows this date. */
  paidAt?: Date;
}): Obj {
  const tax = o.tax ?? 0;
  return {
    id: o.id,
    object: 'invoice',
    customer: o.customer,
    status: o.status ?? 'paid',
    currency: o.currency.toLowerCase(),
    subtotal: o.amount,
    total_excluding_tax: o.amount,
    total_taxes: tax ? [{ amount: tax }] : [],
    amount_paid: o.amount + tax,
    status_transitions: { paid_at: unix(o.paidAt ?? o.start) },
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: o.subscription,
        metadata: { organizationId: o.organizationId, etg_purpose: STRIPE_PURPOSE_SUBSCRIPTION },
      },
    },
    lines: {
      data: [
        {
          amount: o.amount,
          pricing: { type: 'price_details', price_details: { price: o.price, product: 'prod_x' } },
          period: { start: unix(o.start), end: unix(o.end) },
        },
      ],
    },
  };
}

export function stripeCreditPackSession(o: {
  id: string;
  customer: string | null;
  organizationId: string;
  packCode: string;
  amount: number;
  currency: string;
  paid?: boolean;
  at?: Date;
  /** Our CreditPackPurchase reference, as the checkout wrote it into the metadata. */
  purchaseRef?: string;
  /** The tax Stripe added on top of `amount`. */
  tax?: number;
}): Obj {
  return {
    id: o.id,
    object: 'checkout.session',
    mode: 'payment',
    status: o.paid === false ? 'open' : 'complete',
    payment_status: o.paid === false ? 'unpaid' : 'paid',
    customer: o.customer,
    amount_subtotal: o.amount,
    amount_total: o.amount + (o.tax ?? 0),
    total_details: { amount_tax: o.tax ?? 0 },
    currency: o.currency.toLowerCase(),
    created: unix(o.at ?? new Date()),
    metadata: {
      organizationId: o.organizationId,
      packCode: o.packCode,
      ...(o.purchaseRef ? { purchaseRef: o.purchaseRef } : {}),
      etg_purpose: STRIPE_PURPOSE_CREDIT_PACK,
    },
  };
}

/** A Stripe event envelope around `object`. */
export function stripeEvent(id: string, type: string, object: Obj, created = new Date()): Obj {
  return {
    id,
    object: 'event',
    api_version: '2026-06-24.dahlia',
    created: unix(created),
    type,
    data: { object },
  };
}

/** The raw body and a valid `stripe-signature` header for it (the SDK's own test helper). */
export function signStripe(event: Obj, secret = STRIPE_TEST_WEBHOOK_SECRET) {
  const raw = JSON.stringify(event);
  const header = new Stripe('sk_test_offline_fixture').webhooks.generateTestHeaderString({
    payload: raw,
    secret,
  });
  return { raw, headers: { 'stripe-signature': header } };
}

// ── Razorpay ─────────────────────────────────────────────────────────────────────

export interface RazorpayState {
  subs: Record<string, Obj>;
  payments: Record<string, Obj>;
  invoices: Record<string, Obj>;
  plans: Record<string, Obj>;
  links: Record<string, Obj>;
  calls: { method: string; args: unknown[] }[];
  failCreate?: { statusCode: number; error: { description: string } } | null;
}

export function razorpayState(): RazorpayState {
  return {
    subs: {},
    payments: {},
    invoices: {},
    plans: {},
    links: {},
    calls: [],
    failCreate: null,
  };
}

export function fakeRazorpay(state: RazorpayState): RazorpayBillingApi {
  const read = async (v: Obj | undefined) => {
    if (!v) throw { statusCode: 400, error: { description: 'The id provided does not exist' } };
    return JSON.parse(JSON.stringify(v)) as Obj;
  };
  const log = (method: string, args: unknown[]) => state.calls.push({ method, args });
  return {
    plans: { fetch: async (id) => read(state.plans[id]) },
    subscriptions: {
      create: async (p) => {
        log('subscriptions.create', [p]);
        if (state.failCreate) throw state.failCreate;
        const id = `sub_${state.calls.length}`;
        return { id, short_url: `https://rzp.test/i/${id}`, status: 'created' };
      },
      fetch: async (id) => read(state.subs[id]),
      cancel: async (id, atCycleEnd) => {
        log('subscriptions.cancel', [id, atCycleEnd]);
        return read(state.subs[id]);
      },
    },
    payments: { fetch: async (id) => read(state.payments[id]) },
    invoices: { fetch: async (id) => read(state.invoices[id]) },
    paymentLink: {
      create: async (p) => {
        log('paymentLink.create', [p]);
        const id = `plink_${state.calls.length}`;
        return { id, short_url: `https://rzp.test/l/${id}` };
      },
      fetch: async (id) => read(state.links[id]),
    },
  };
}

export function razorpaySubscription(o: {
  id: string;
  customer: string;
  plan: string;
  organizationId: string;
  status?: string;
  start: Date;
  end: Date;
}): Obj {
  return {
    id: o.id,
    entity: 'subscription',
    plan_id: o.plan,
    customer_id: o.customer,
    status: o.status ?? 'active',
    current_start: unix(o.start),
    current_end: unix(o.end),
    notes: { organizationId: o.organizationId, etg_purpose: RAZORPAY_PURPOSE_SUBSCRIPTION },
  };
}

export function razorpayPaymentLink(o: {
  id: string;
  organizationId: string;
  packCode: string;
  /** Everything charged: Razorpay computes no tax, so this is net + our tax. */
  amount: number;
  paid?: boolean;
  at?: Date;
  purchaseRef?: string;
}): Obj {
  return {
    id: o.id,
    status: o.paid === false ? 'created' : 'paid',
    amount: o.amount,
    amount_paid: o.paid === false ? 0 : o.amount,
    currency: 'INR',
    updated_at: unix(o.at ?? new Date()),
    notes: {
      organizationId: o.organizationId,
      packCode: o.packCode,
      ...(o.purchaseRef ? { purchaseRef: o.purchaseRef } : {}),
      etg_purpose: RAZORPAY_PURPOSE_CREDIT_PACK,
    },
  };
}

/** A Razorpay webhook envelope: `{ entity: event, event, payload: { <key>: { entity } } }`. */
export function razorpayEvent(
  event: string,
  entities: Record<string, Obj>,
  created = new Date(),
): Obj {
  return {
    entity: 'event',
    account_id: 'acc_fixture',
    event,
    contains: Object.keys(entities),
    payload: Object.fromEntries(Object.entries(entities).map(([k, v]) => [k, { entity: v }])),
    created_at: unix(created),
  };
}

export function signRazorpay(body: Obj, eventId: string, secret = RAZORPAY_TEST_WEBHOOK_SECRET) {
  const raw = JSON.stringify(body);
  return {
    raw,
    headers: {
      'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'),
      'x-razorpay-event-id': eventId,
    },
  };
}
