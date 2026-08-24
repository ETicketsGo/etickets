import { PaymentEnv } from '@prisma/client';

/**
 * Which provider serves which currency, per environment.
 *
 * Extracted so the destructive seed and the idempotent bootstrap cannot drift. Routing is a
 * DATABASE decision, not an environment variable — `PAYMENT_PROVIDER_NAME` selects which
 * adapter is constructed, while these rows decide which provider a given currency actually
 * resolves to at checkout. Both have to be right, and readiness reports them separately
 * (`PAYMENT_MOCK_ONLY` / `RAZORPAY_NOT_CONFIGURED` versus `NO_INR_ROUTE`).
 */
export interface RouteSpec {
  env: PaymentEnv;
  country: string;
  currency: string;
  method: string;
  provider: string;
  failoverProvider?: string;
  priority: number;
}

/** Environments where the simulated gateway is permitted. Mirrors `isDummyAllowed`. */
export const DUMMY_ENVS = [PaymentEnv.LOCAL, PaymentEnv.DEV, PaymentEnv.QA] as const;

/** Environments served by real gateways: UAT (sandbox keys) and above. */
export const REAL_ENVS = [PaymentEnv.UAT, PaymentEnv.STAGING, PaymentEnv.PRODUCTION] as const;

/**
 * Currencies the platform intends to sell in, each stated explicitly.
 *
 * ── WHY THESE ARE NOT LEFT TO THE WILDCARD ────────────────────────────────────────
 * The catch-all row already sends everything that is not INR to Stripe, so a US or
 * Canadian sale would have worked. It would have worked by ACCIDENT: nothing recorded that
 * we meant to sell in those currencies, nothing failed if the fallback provider stopped
 * supporting one of them, and no test would have noticed. A launch market that is served
 * only by a default is a market nobody decided to enter.
 *
 * Stating each one makes the intent auditable, makes readiness able to report a missing
 * route per market, and makes the wildcard mean what it should: "an unplanned currency
 * reached checkout", which is a thing worth noticing rather than silently charging for.
 */
export const LAUNCH_CURRENCIES = ['INR', 'USD', 'CAD'] as const;
export type LaunchCurrency = (typeof LAUNCH_CURRENCIES)[number];

/** Which provider serves each launch currency, and what it falls over to. */
const CURRENCY_PROVIDERS: Record<LaunchCurrency, { provider: string; failover?: string }> = {
  // India settles through Razorpay; Stripe is the failover because it also supports INR.
  INR: { provider: 'razorpay', failover: 'stripe' },
  // Stripe serves both North American currencies. No failover: Razorpay does not settle
  // USD or CAD, and naming a provider that cannot take the payment would turn a clean
  // "provider unavailable" into a confusing decline at the gateway.
  USD: { provider: 'stripe' },
  CAD: { provider: 'stripe' },
};

/**
 * The routes one environment needs.
 *
 * Keyed on CURRENCY rather than country, so routing does not depend on how a venue's
 * country happens to be spelled. Launch currencies come first (priority 10) and the
 * wildcard last, so an explicit row always wins.
 */
export function routesFor(env: PaymentEnv): RouteSpec[] {
  if ((DUMMY_ENVS as readonly PaymentEnv[]).includes(env)) {
    return [{ env, country: '*', currency: '*', method: '*', provider: 'dummy', priority: 100 }];
  }
  return [
    ...LAUNCH_CURRENCIES.map((currency) => ({
      env,
      country: '*',
      currency,
      method: '*',
      provider: CURRENCY_PROVIDERS[currency].provider,
      ...(CURRENCY_PROVIDERS[currency].failover
        ? { failoverProvider: CURRENCY_PROVIDERS[currency].failover }
        : {}),
      priority: 10,
    })),
    { env, country: '*', currency: '*', method: '*', provider: 'stripe', priority: 100 },
  ];
}
