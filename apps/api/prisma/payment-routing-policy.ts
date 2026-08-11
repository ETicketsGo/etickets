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
 * The routes one environment needs.
 *
 * India settles through Razorpay with Stripe as failover; everything else through Stripe.
 * Keyed on CURRENCY rather than country, so it routes correctly without depending on how a
 * venue's country happens to be spelled.
 */
export function routesFor(env: PaymentEnv): RouteSpec[] {
  if ((DUMMY_ENVS as readonly PaymentEnv[]).includes(env)) {
    return [{ env, country: '*', currency: '*', method: '*', provider: 'dummy', priority: 100 }];
  }
  return [
    {
      env,
      country: '*',
      currency: 'INR',
      method: '*',
      provider: 'razorpay',
      failoverProvider: 'stripe',
      priority: 10,
    },
    { env, country: '*', currency: '*', method: '*', provider: 'stripe', priority: 100 },
  ];
}
