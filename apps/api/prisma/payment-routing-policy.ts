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

/**
 * Which providers can actually settle each launch currency, best first.
 *
 * An ordered list rather than a primary and a failover, because which of them is REACHABLE
 * depends on what the environment has been given keys for — see `routesFor`. Razorpay cannot
 * settle USD or CAD, so it never appears in those lists: naming a provider that cannot take
 * the payment turns a clean "provider unavailable" into a confusing decline at the gateway.
 */
const CURRENCY_PROVIDERS: Record<LaunchCurrency, readonly string[]> = {
  INR: ['razorpay', 'stripe'],
  USD: ['stripe'],
  CAD: ['stripe'],
};

/** The provider that takes anything outside the launch currencies, best first. */
const WILDCARD_PROVIDERS: readonly string[] = ['stripe'];

/**
 * What an environment can actually charge with.
 *
 * ── WHY THIS IS AN ARGUMENT AND NOT A LIST OF ENVIRONMENT NAMES ────────────────────
 * This file used to answer "which provider serves INR here?" from the environment's NAME:
 * LOCAL, DEV and QA got a single wildcard row to the simulated gateway, and UAT and above got
 * Razorpay and Stripe. That encoded an assumption about how each environment is wired, and the
 * wiring drifted from it in BOTH directions:
 *
 *   QA  was given real Razorpay test keys, and still routed everything to `dummy` — so the
 *       launch gate's matrix said the platform had no India row while INR payments were in
 *       fact being taken through Razorpay. The gate could never report GO, and the one
 *       screen built to answer "where does INR settle?" was answering it wrongly.
 *   UAT was given NO provider keys at all, and still routed INR to `razorpay` and everything
 *       else to `stripe` — pointing at two gateways it cannot authenticate against. That is
 *       worse than having no route: the failure moves from readiness, where somebody would
 *       see it, to the gateway, where a customer does.
 *
 * Deriving the rows from what the environment HAS cannot drift, because there is nothing left
 * to drift from. An environment with no way to take a currency gets no row for it, and
 * readiness reports `NO_INR_ROUTE` — which is true, and actionable, and says what to fix.
 */
export interface AvailableProviders {
  razorpay: boolean;
  stripe: boolean;
  /** The simulated gateway. Permitted only where `isDummyAllowed` says so. */
  dummy: boolean;
}

/**
 * Read what this environment is wired with from its own configuration.
 *
 * Presence of a credential, not a mode: a key that is set but wrong is a problem readiness
 * reports, and one this function must not pre-empt by pretending the provider is absent.
 */
export function providersFromEnvironment(
  env: PaymentEnv,
  read: (key: string) => string | undefined = (k) => process.env[k],
): AvailableProviders {
  const set = (key: string) => (read(key) ?? '').trim().length > 0;
  return {
    razorpay: set('RAZORPAY_KEY_ID') && set('RAZORPAY_KEY_SECRET'),
    stripe: set('STRIPE_SECRET_KEY'),
    dummy: (DUMMY_ENVS as readonly PaymentEnv[]).includes(env),
  };
}

/** The first provider in `preference` this environment can actually reach. */
function reachable(preference: readonly string[], available: AvailableProviders): string[] {
  return preference.filter((p) => available[p as keyof AvailableProviders] === true);
}

/**
 * The routes one environment needs, given what it can actually charge with.
 *
 * Keyed on CURRENCY rather than country, so routing does not depend on how a venue's country
 * happens to be spelled. Launch currencies come first (priority 10) and the wildcard last, so
 * an explicit row always wins.
 *
 * A currency with no reachable provider falls back to the simulated gateway where that is
 * permitted, and otherwise gets NO ROW AT ALL. The empty case is deliberate and is the whole
 * point of the rewrite: a missing route is a fact readiness can report, while a route to a
 * gateway we hold no keys for is a fact nobody learns until a customer is standing at it.
 */
export function routesFor(env: PaymentEnv, available?: AvailableProviders): RouteSpec[] {
  const have = available ?? providersFromEnvironment(env);
  const routes: RouteSpec[] = [];

  for (const currency of LAUNCH_CURRENCIES) {
    const [provider, failoverProvider] = reachable(CURRENCY_PROVIDERS[currency], have);
    const chosen = provider ?? (have.dummy ? 'dummy' : undefined);
    if (!chosen) continue;
    routes.push({
      env,
      country: '*',
      currency,
      method: '*',
      provider: chosen,
      // Only a real second provider is a failover. Falling a real gateway over to the
      // simulated one would turn an outage into silently un-taken money.
      ...(provider && failoverProvider ? { failoverProvider } : {}),
      priority: 10,
    });
  }

  const [wildcard] = reachable(WILDCARD_PROVIDERS, have);
  const chosenWildcard = wildcard ?? (have.dummy ? 'dummy' : undefined);
  if (chosenWildcard) {
    routes.push({
      env,
      country: '*',
      currency: '*',
      method: '*',
      provider: chosenWildcard,
      priority: 100,
    });
  }

  return routes;
}
