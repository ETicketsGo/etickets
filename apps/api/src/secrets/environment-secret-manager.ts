import { SecretCache } from './secret-cache';
import {
  SecretResolutionError,
  type SecretManager,
  type SecretManagerHealth,
} from './secret-manager.interface';
import { deriveEnvVarName, isValidReference } from './secret-reference';

/**
 * Environment-backed secret manager (ADR-024) — LOCAL/DEV ONLY. Resolves a
 * reference to the process env var derived from it, e.g.
 *   payments/stripe/test/secret-key → process.env.PAYMENTS_STRIPE_TEST_SECRET_KEY
 *
 * The factory refuses to select this backend in PRODUCTION (and it is not intended
 * for STAGING). It exists so local/dev/test boot with no cloud dependency.
 */
export class EnvironmentSecretManager implements SecretManager {
  readonly provider = 'env';
  private readonly cache: SecretCache;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    ttlMs = 300_000,
    now: () => number = Date.now,
  ) {
    this.cache = new SecretCache(ttlMs, now);
  }

  validateReference(reference: string): boolean {
    return isValidReference(reference);
  }

  async getSecret(reference: string): Promise<string> {
    if (!this.validateReference(reference)) {
      throw new SecretResolutionError(reference, this.provider, 'malformed reference');
    }
    const cached = this.cache.get(reference);
    if (cached !== undefined) return cached;

    const value = this.env[deriveEnvVarName(reference)];
    if (value === undefined || value === '') {
      // Fail closed — never fall back to a default or placeholder.
      throw new SecretResolutionError(reference, this.provider, 'not set in environment');
    }
    this.cache.set(reference, value);
    return value;
  }

  async getSecrets(references: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const ref of references) out[ref] = await this.getSecret(ref);
    return out;
  }

  async healthCheck(): Promise<SecretManagerHealth> {
    return { healthy: true, provider: this.provider, message: 'process environment' };
  }

  invalidateCache(reference?: string): void {
    this.cache.invalidate(reference);
  }
}
