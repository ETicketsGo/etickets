import { CURRENCY_PROVIDERS } from './marketplace';

/**
 * Which provider serves which currency, and what an environment can actually charge with.
 *
 * ── WHY THIS LIVES HERE AND NOT IN `apps/api/prisma` ───────────────────────────────
 * It used to live beside the seeds, which meant only the seeds could read it. The API's own
 * `rootDir` is `src`, so nothing in the running application could import the policy that decides
 * where money is taken - and the one job that could was a one-shot Railway service that, on
 * production, reports SUCCESS and never starts a container. A fresh production therefore had no
 * way at all to obtain the rows it refuses to boot without.
 *
 * So the pure policy sits in shared-types, where both the seeds and the API can read the SAME
 * copy. `apps/api/prisma/payment-routing-policy.ts` re-exports it with `PaymentEnv` types, and
 * the API's boot-time bootstrap uses it directly. The file it came from already warned that two
 * copies drift - and they had, once, which is how the route table came to advertise a CAD row no
 * Canadian checkout could use. One table, every reader.
 *
 * `env` is a plain string here on purpose: shared-types must not depend on the generated Prisma
 * client. Callers that have `PaymentEnv` pass it straight in.
 */

/** One routing row, before it becomes a `PaymentRoute`. */
export interface PaymentRouteSpec {
  env: string;
  country: string;
  currency: string;
  method: string;
  provider: string;
  failoverProvider?: string;
  priority: number;
}

/** Environments where the simulated gateway is permitted. Mirrors `isDummyAllowed`. */
export const DUMMY_PAYMENT_ENVS = ['LOCAL', 'DEV', 'QA'] as const;

/**
 * Currencies the platform intends to sell in, each stated explicitly.
 *
 * The catch-all row already sends everything that is not INR to Stripe, so a US or Canadian sale
 * would have worked - by ACCIDENT. Nothing recorded that we meant to sell in those currencies,
 * nothing failed if the fallback provider stopped supporting one, and no test would have noticed.
 * A launch market served only by a default is a market nobody decided to enter.
 */
export const LAUNCH_CURRENCIES = ['INR', 'USD', 'CAD'] as const;
export type LaunchCurrency = (typeof LAUNCH_CURRENCIES)[number];

/** The provider that takes anything outside the launch currencies, best first. */
const WILDCARD_PROVIDERS: readonly string[] = ['stripe'];

/** What an environment can actually charge with. */
export interface AvailablePaymentProviders {
  razorpay: boolean;
  stripe: boolean;
  /** The simulated gateway. Permitted only where `DUMMY_PAYMENT_ENVS` says so. */
  dummy: boolean;
}

/**
 * Read what this environment is wired with from its own configuration.
 *
 * Presence of a credential, not a mode: a key that is set but wrong is a problem readiness
 * reports, and one this must not pre-empt by pretending the provider is absent.
 *
 * Razorpay needs BOTH halves. A key id with no secret authenticates against nothing, and
 * enabling it on the strength of the id alone produces a row that passes validation and fails at
 * the gateway.
 */
export function providersFromEnvironment(
  env: string,
  read: (key: string) => string | undefined,
): AvailablePaymentProviders {
  const set = (key: string) => (read(key) ?? '').trim().length > 0;
  return {
    razorpay: set('RAZORPAY_KEY_ID') && set('RAZORPAY_KEY_SECRET'),
    stripe: set('STRIPE_SECRET_KEY'),
    dummy: (DUMMY_PAYMENT_ENVS as readonly string[]).includes(env.toUpperCase()),
  };
}

/** The first provider in `preference` this environment can actually reach. */
function reachable(
  preference: readonly string[] | undefined,
  available: AvailablePaymentProviders,
): string[] {
  return (preference ?? []).filter(
    (p) => available[p as keyof AvailablePaymentProviders] === true,
  );
}

/**
 * The routes one environment needs, given what it can actually charge with.
 *
 * Keyed on CURRENCY rather than country, so routing does not depend on how a venue's country
 * happens to be spelled. Launch currencies come first (priority 10) and the wildcard last, so an
 * explicit row always wins.
 *
 * A currency with no reachable provider gets NO ROW AT ALL where the simulated gateway is not
 * permitted. That is deliberate: a missing route is a fact readiness can report, while a route to
 * a gateway we hold no keys for is a fact nobody learns until a customer is standing at it.
 */
export function paymentRoutesFor(
  env: string,
  available: AvailablePaymentProviders,
): PaymentRouteSpec[] {
  const routes: PaymentRouteSpec[] = [];

  for (const currency of LAUNCH_CURRENCIES) {
    const [provider, failoverProvider] = reachable(CURRENCY_PROVIDERS[currency], available);
    const chosen = provider ?? (available.dummy ? 'dummy' : undefined);
    if (!chosen) continue;
    routes.push({
      env,
      country: '*',
      currency,
      method: '*',
      provider: chosen,
      // Only a real second provider is a failover. Falling a real gateway over to the simulated
      // one would turn an outage into silently un-taken money.
      ...(provider && failoverProvider ? { failoverProvider } : {}),
      priority: 10,
    });
  }

  const [wildcard] = reachable(WILDCARD_PROVIDERS, available);
  const chosenWildcard = wildcard ?? (available.dummy ? 'dummy' : undefined);
  if (chosenWildcard) {
    routes.push({ env, country: '*', currency: '*', method: '*', provider: chosenWildcard, priority: 100 });
  }

  return routes;
}

/**
 * LIVE or TEST, from the credentials rather than from the environment's name.
 *
 * ── WHY THIS TAKES EVERY KEY AND NOT JUST THE SECRET ───────────────────────────────
 * It used to read one value, `secret ?? publicKey`, and that is wrong for Razorpay: a Razorpay
 * secret is an opaque string with no marker at all, and only the KEY ID carries `rzp_live_` or
 * `rzp_test_`. So a genuine live Razorpay credential was classified TEST - and the validator then
 * refuses to start ("enabled in PRODUCTION but still in TEST mode"), which is a production that
 * cannot boot for a reason that has nothing to do with its configuration.
 *
 * Stripe hid the bug, because `sk_live_`/`sk_test_` puts the marker on the secret, so reading the
 * secret first happened to work for the one provider anybody had tested with.
 *
 * Any key carrying `_live_` makes it LIVE. An unrecognised prefix everywhere is TEST: of the two
 * ways to be wrong, treating a live key as test is caught immediately by the validator, while the
 * reverse would quietly assert that a sandbox key moves real money.
 */
export function paymentKeyMode(...keys: Array<string | undefined>): 'LIVE' | 'TEST' {
  return keys.some((k) => /_live_/.test(k ?? '')) ? 'LIVE' : 'TEST';
}

/** The environment variable holding each provider's PUBLIC identifier. */
export const PAYMENT_PUBLIC_KEY_ENV: Record<string, string> = {
  stripe: 'STRIPE_PUBLISHABLE_KEY',
  razorpay: 'RAZORPAY_KEY_ID',
};

/** The environment variable holding each provider's SECRET. Never stored, only read. */
export const PAYMENT_SECRET_KEY_ENV: Record<string, string> = {
  stripe: 'STRIPE_SECRET_KEY',
  razorpay: 'RAZORPAY_KEY_SECRET',
};
