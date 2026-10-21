import {
  SecretResolutionError,
  type SecretManager,
  type SecretManagerHealth,
} from './secret-manager.interface';

/**
 * The approved secret names, and the ONE Railway variable each one is.
 *
 * ── WHY A FIXED LIST, AND NOT THE ENV BACKEND ─────────────────────────────────────
 * The payment credentials already live in Railway variables: checkout, webhooks, refunds and
 * reconciliation build the Razorpay adapter from RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET
 * (PaymentProviderResolver). A second copy in a cloud vault would be two sources of truth for
 * the same key, and the factory-built adapter REPLACES the resolver's in the provider registry,
 * so checkout would silently follow whichever copy the factory read. One copy, read twice, is
 * the only arrangement in which the two adapters cannot disagree.
 *
 * The generic `env` backend cannot be that reader in production. It turns ANY well-formed
 * reference into a variable name (`jwt/access-secret` -> JWT_ACCESS_SECRET), and references are
 * data: an admin can type one into merchant onboarding or a provider config. A fixed map reads
 * exactly the variables named here and refuses everything else, so no stored reference can make
 * the API read a secret that is not a payment credential.
 *
 * Adding a provider (Stripe for the US) means adding its two rows here, in code review.
 */
export const RAILWAY_SECRET_MAP: Readonly<Record<string, string>> = Object.freeze({
  'payments/razorpay/live/secret-key': 'RAZORPAY_KEY_SECRET',
  'payments/razorpay/live/webhook-secret': 'RAZORPAY_WEBHOOK_SECRET',
});

/**
 * Secret manager over Railway service variables, through RAILWAY_SECRET_MAP only.
 *
 * Allowed in PRODUCTION (unlike `env`). Reads the variable on every call, with no cache: the
 * value can only change by a redeploy, which is a new process anyway, and a cache here would be
 * one more place for a rotated key to linger.
 */
export class RailwaySecretManager implements SecretManager {
  readonly provider = 'railway';

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  validateReference(reference: string): boolean {
    return typeof reference === 'string' && Object.hasOwn(RAILWAY_SECRET_MAP, reference.trim());
  }

  async getSecret(reference: string): Promise<string> {
    if (!this.validateReference(reference)) {
      // The reference is not a secret (ADR-024), so naming it is safe; the value never is.
      throw new SecretResolutionError(reference, this.provider, 'not an approved secret name');
    }
    const variable = RAILWAY_SECRET_MAP[reference.trim()];
    const value = this.env[variable];
    if (value === undefined || value.trim() === '') {
      throw new SecretResolutionError(reference, this.provider, `${variable} is not set`);
    }
    return value;
  }

  async getSecrets(references: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const ref of references) out[ref] = await this.getSecret(ref);
    return out;
  }

  /** Healthy when every approved variable is set. Names the missing ones, never a value. */
  async healthCheck(): Promise<SecretManagerHealth> {
    const missing = Object.values(RAILWAY_SECRET_MAP).filter((v) => !this.env[v]?.trim());
    return missing.length === 0
      ? { healthy: true, provider: this.provider, message: 'railway variables' }
      : { healthy: false, provider: this.provider, message: `missing ${missing.join(', ')}` };
  }

  invalidateCache(): void {
    // Nothing is cached; see the class comment.
  }
}
