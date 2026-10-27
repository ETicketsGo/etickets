import type { ConfigService } from '@nestjs/config';
import type { SecretManager } from '../../secrets/secret-manager.interface';
import type { BillingKeyMode } from './billing-provider';

/**
 * Where billing provider credentials come from. NEVER logged; errors name variables, not values.
 *
 * ── ONE RULE PER CREDENTIAL ────────────────────────────────────────────────────────
 * Each credential has a NAME (e.g. `STRIPE_BILLING_WEBHOOK_SECRET`). It is read, in order:
 *   1. `<NAME>_REF` - a secret REFERENCE (e.g. `billing/stripe/test/webhook-secret`), resolved
 *      through SECRET_MANAGER, the same pattern the payment provider factory uses;
 *   2. `<NAME>` - the value itself, as an environment variable;
 *   3. for API keys only, the ticket payments' key on the same provider account
 *      (`STRIPE_SECRET_KEY`, `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`). Billing is the PLATFORM's
 *      own account, so the key may be shared. The WEBHOOK secrets never fall back: billing
 *      events have their own endpoint and their own signing secret, so a ticket event can never
 *      verify as a billing one, or the reverse.
 *
 * ── TEST KEYS ONLY ─────────────────────────────────────────────────────────────────
 * A key's mode is read from its prefix (`sk_test_`/`rk_test_`, `rzp_test_`). A live key is
 * refused unless the environment is STAGING or PRODUCTION, and the boot check refuses billing
 * there until the owner approves it - so in this change billing can only ever hold test keys.
 */
export interface CredentialSpec {
  name: string;
  fallback?: string;
}

export const STRIPE_BILLING_CREDENTIALS = {
  secretKey: { name: 'STRIPE_BILLING_SECRET_KEY', fallback: 'STRIPE_SECRET_KEY' },
  webhookSecret: { name: 'STRIPE_BILLING_WEBHOOK_SECRET' },
} as const satisfies Record<string, CredentialSpec>;

export const RAZORPAY_BILLING_CREDENTIALS = {
  keyId: { name: 'RAZORPAY_BILLING_KEY_ID', fallback: 'RAZORPAY_KEY_ID' },
  keySecret: { name: 'RAZORPAY_BILLING_KEY_SECRET', fallback: 'RAZORPAY_KEY_SECRET' },
  webhookSecret: { name: 'RAZORPAY_BILLING_WEBHOOK_SECRET' },
} as const satisfies Record<string, CredentialSpec>;

type Reader = Pick<ConfigService, 'get'>;

function read(config: Reader, name: string): string | undefined {
  const v = config.get<string>(name);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Whether a credential is configured at all (by reference, value or fallback). No lookup. */
export function credentialConfigured(config: Reader, spec: CredentialSpec): boolean {
  return Boolean(
    read(config, `${spec.name}_REF`) ||
    read(config, spec.name) ||
    (spec.fallback && read(config, spec.fallback)),
  );
}

/** The configured credential's value, or null when none is configured. */
export async function resolveCredential(
  config: Reader,
  secrets: Pick<SecretManager, 'getSecret'> | null,
  spec: CredentialSpec,
): Promise<string | null> {
  const ref = read(config, `${spec.name}_REF`);
  if (ref) {
    if (!secrets) throw new Error(`${spec.name}_REF is set but no secret manager is available.`);
    return (await secrets.getSecret(ref)).trim();
  }
  return read(config, spec.name) ?? (spec.fallback ? (read(config, spec.fallback) ?? null) : null);
}

/** The mode a key's prefix says it is, or `unknown`. */
export function keyModeOf(
  value: string,
  provider: 'stripe' | 'razorpay',
): BillingKeyMode | 'unknown' {
  if (provider === 'stripe') {
    if (/^(sk|rk)_test_/.test(value)) return 'test';
    if (/^(sk|rk)_live_/.test(value)) return 'live';
    return 'unknown';
  }
  if (value.startsWith('rzp_test_')) return 'test';
  if (value.startsWith('rzp_live_')) return 'live';
  return 'unknown';
}

/**
 * Refuses a key billing must not use here. Returns the mode. Messages never include the value.
 * Live keys belong to STAGING and PRODUCTION only (payment-environment.ts), and billing is
 * refused there at boot until the owner approves it.
 */
export function assertUsableKey(
  name: string,
  value: string,
  provider: 'stripe' | 'razorpay',
  appEnv: string,
): BillingKeyMode {
  const mode = keyModeOf(value, provider);
  if (mode === 'unknown') {
    throw new Error(`${name} is not a ${provider} API key (unexpected prefix).`);
  }
  if (mode === 'live' && !['STAGING', 'PRODUCTION'].includes(appEnv)) {
    throw new Error(
      `${name} is a LIVE key and APP_ENV=${appEnv}. Billing uses test keys outside STAGING and PRODUCTION.`,
    );
  }
  return mode;
}
