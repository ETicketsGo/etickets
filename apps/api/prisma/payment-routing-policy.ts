import { PaymentEnv } from '@prisma/client';
import {
  type AvailablePaymentProviders,
  type PaymentRouteSpec,
  paymentRoutesFor,
  providersFromEnvironment as providersFromEnvironmentShared,
} from '@eticketsgo/shared-types';

/**
 * The payment routing policy, typed for the seeds.
 *
 * ── WHY THIS IS NOW A RE-EXPORT ────────────────────────────────────────────────────
 * The policy itself moved to `@eticketsgo/shared-types`. It had to: the API's `rootDir` is `src`,
 * so nothing in the running application could import a file under `prisma/`, and the only thing
 * that could write the rows a fail-closed environment refuses to boot without was a one-shot
 * Railway job. On production that job reports SUCCESS and never starts a container, so a fresh
 * production could not obtain those rows at all.
 *
 * This file keeps its name, its `PaymentEnv` types and its exports, so the seeds are unchanged.
 * The rules live in exactly one place, which is what the original version of this file asked for
 * when it was extracted "so the destructive seed and the idempotent bootstrap cannot drift".
 *
 * Routing is a DATABASE decision, not an environment variable - `PAYMENT_PROVIDER_NAME` selects
 * which adapter is constructed, while these rows decide which provider a given currency actually
 * resolves to at checkout. Both have to be right, and readiness reports them separately
 * (`PAYMENT_MOCK_ONLY` / `RAZORPAY_NOT_CONFIGURED` versus `NO_INR_ROUTE`).
 */
export type { AvailablePaymentProviders as AvailableProviders };

/** One routing row, before it becomes a `PaymentRoute`. `env` narrowed to the enum. */
export interface RouteSpec extends Omit<PaymentRouteSpec, 'env'> {
  env: PaymentEnv;
}

export {
  DUMMY_PAYMENT_ENVS,
  LAUNCH_CURRENCIES,
  type LaunchCurrency,
  PAYMENT_PUBLIC_KEY_ENV,
  PAYMENT_SECRET_KEY_ENV,
  paymentKeyMode,
} from '@eticketsgo/shared-types';

/** Environments where the simulated gateway is permitted. Mirrors `isDummyAllowed`. */
export const DUMMY_ENVS = [PaymentEnv.LOCAL, PaymentEnv.DEV, PaymentEnv.QA] as const;

/** Environments served by real gateways: UAT (sandbox keys) and above. */
export const REAL_ENVS = [PaymentEnv.UAT, PaymentEnv.STAGING, PaymentEnv.PRODUCTION] as const;

/**
 * Read what this environment is wired with from its own configuration.
 *
 * The `read` argument is kept for the tests that inject a fake environment; it defaults to the
 * real one exactly as before.
 */
export function providersFromEnvironment(
  env: PaymentEnv,
  read: (key: string) => string | undefined = (k) => process.env[k],
): AvailablePaymentProviders {
  return providersFromEnvironmentShared(env, read);
}

/** The routes one environment needs, given what it can actually charge with. */
export function routesFor(env: PaymentEnv, available?: AvailablePaymentProviders): RouteSpec[] {
  const have = available ?? providersFromEnvironment(env);
  // `env` round-trips as a string through the shared policy and comes back as the same value.
  return paymentRoutesFor(env, have).map((r) => ({ ...r, env: r.env as PaymentEnv }));
}
