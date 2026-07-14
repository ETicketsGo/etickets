import { SecretCache } from '../secret-cache';
import {
  SecretResolutionError,
  type SecretManager,
  type SecretManagerHealth,
} from '../secret-manager.interface';
import { isValidReference, redactSecrets } from '../secret-reference';

/**
 * Shared base for cloud secret managers (Azure/AWS/GCP). Owns caching, reference
 * validation, fail-closed semantics, and secret-safe error handling. Subclasses
 * implement fetchRemote() (a single lookup) and healthCheck().
 *
 * The concrete SDK is loaded LAZILY via dynamic import (see loadModule) so it is
 * only required at runtime when that backend is selected — it is never a build or
 * CI dependency. If the SDK is not installed, construction/health fails with a
 * clear, secret-free message.
 */
export abstract class CloudSecretManager implements SecretManager {
  abstract readonly provider: string;
  protected readonly cache: SecretCache;

  constructor(ttlMs: number, now: () => number = Date.now) {
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

    let value: string;
    try {
      value = await this.fetchRemote(reference);
    } catch (err) {
      // Never leak the underlying error verbatim — it could echo a value.
      throw new SecretResolutionError(reference, this.provider, this.safeReason(err));
    }
    if (!value) {
      throw new SecretResolutionError(reference, this.provider, 'empty or missing secret');
    }
    this.cache.set(reference, value);
    return value;
  }

  async getSecrets(references: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const ref of references) out[ref] = await this.getSecret(ref);
    return out;
  }

  invalidateCache(reference?: string): void {
    this.cache.invalidate(reference);
  }

  abstract healthCheck(): Promise<SecretManagerHealth>;

  /** Fetch a single secret value from the backend. */
  protected abstract fetchRemote(reference: string): Promise<string>;

  /** A short, secret-free reason string derived from a caught error. */
  protected safeReason(err: unknown): string {
    const raw = err instanceof Error ? err.message : 'lookup failed';
    return redactSecrets(raw).slice(0, 200);
  }

  /**
   * Lazily import an optional SDK. Uses a runtime module id so the bundler/tsc do
   * not require the package to exist. Returns null when the SDK is not installed.
   */
  protected async loadModule<T = unknown>(moduleId: string): Promise<T | null> {
    try {
      // Indirect specifier → not statically resolved by tsc; safe when absent.
      const dynamicImport = new Function('id', 'return import(id);') as (id: string) => Promise<T>;
      return await dynamicImport(moduleId);
    } catch {
      return null;
    }
  }
}
