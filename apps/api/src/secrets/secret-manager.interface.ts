/**
 * Secret manager abstraction (production-binding layer, ADR-024). Resolves secret
 * REFERENCES (never raw values in config) into secret values at runtime. Multiple
 * backends plug in behind this interface (env for local/dev, Azure/AWS/GCP for
 * higher environments) selected by SECRET_MANAGER_PROVIDER.
 *
 * Contract:
 *  - Secret VALUES are never logged and never returned in errors.
 *  - Missing required secrets fail closed.
 *  - Resolved secrets are cached for a short, configurable TTL and can be
 *    invalidated (rotation / config change) without a restart.
 */
export interface SecretManagerHealth {
  healthy: boolean;
  provider: string;
  /** Safe, secret-free detail (e.g. "reachable", "missing AZURE_KEY_VAULT_URL"). */
  message?: string;
}

export interface SecretManager {
  /** Backend name: 'env' | 'azure' | 'aws' | 'gcp'. */
  readonly provider: string;

  /** Resolve one reference to its secret value. Fails closed if absent. */
  getSecret(reference: string): Promise<string>;

  /** Resolve many references at once. Fails closed if any required one is absent. */
  getSecrets(references: string[]): Promise<Record<string, string>>;

  /** Whether a reference is well-formed for this backend (no value lookup). */
  validateReference(reference: string): boolean;

  /** Backend reachability/readiness, without exposing any secret. */
  healthCheck(): Promise<SecretManagerHealth>;

  /** Drop cached value(s). No argument clears the whole cache. */
  invalidateCache(reference?: string): void;
}

/** DI token for the selected SecretManager. */
export const SECRET_MANAGER = Symbol('SECRET_MANAGER');

/** Raised when a secret cannot be resolved. Message is always secret-free. */
export class SecretResolutionError extends Error {
  constructor(
    readonly reference: string,
    readonly provider: string,
    message: string,
  ) {
    // Never interpolate the secret value — only the reference and a safe reason.
    super(`Secret '${reference}' could not be resolved via ${provider}: ${message}`);
    this.name = 'SecretResolutionError';
  }
}
