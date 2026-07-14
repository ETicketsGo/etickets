/**
 * Deployment-environment helpers for runtime payment configuration (ADR-020).
 *
 * The environment (APP_ENV) decides which env-scoped provider configs, routes and
 * merchant accounts apply, and which safety guards the validator enforces. These
 * are pure, DB-free helpers so both the config service and the validator share one
 * source of truth for "where is the dummy provider allowed", "where is LIVE mode
 * allowed", and "which envs must fail closed".
 */

/** The six deployment environments, mirroring the Prisma `PaymentEnv` enum. */
export const PAYMENT_ENVS = ['LOCAL', 'DEV', 'QA', 'UAT', 'STAGING', 'PRODUCTION'] as const;
export type PaymentEnvName = (typeof PAYMENT_ENVS)[number];

/**
 * Resolve the active payment environment from a raw APP_ENV value. Unknown/empty
 * values fall back to LOCAL — the safest environment (dummy provider, no live
 * charges), so a misconfigured APP_ENV can never silently promote to production.
 */
export function resolvePaymentEnv(raw: string | undefined): PaymentEnvName {
  const upper = (raw ?? '').toUpperCase();
  return (PAYMENT_ENVS as readonly string[]).includes(upper) ? (upper as PaymentEnvName) : 'LOCAL';
}

/** Environments where the simulated dummy provider may be enabled. */
const DUMMY_ALLOWED: ReadonlySet<PaymentEnvName> = new Set(['LOCAL', 'DEV', 'QA']);

/** Environments where a real provider may run in LIVE mode (real money moves). */
const LIVE_ALLOWED: ReadonlySet<PaymentEnvName> = new Set(['STAGING', 'PRODUCTION']);

/** Environments that must fail closed (refuse to boot) on invalid config. */
const FAIL_CLOSED: ReadonlySet<PaymentEnvName> = new Set(['STAGING', 'PRODUCTION']);

export function isDummyAllowed(env: PaymentEnvName): boolean {
  return DUMMY_ALLOWED.has(env);
}

export function isLiveAllowed(env: PaymentEnvName): boolean {
  return LIVE_ALLOWED.has(env);
}

export function isFailClosed(env: PaymentEnvName): boolean {
  return FAIL_CLOSED.has(env);
}
