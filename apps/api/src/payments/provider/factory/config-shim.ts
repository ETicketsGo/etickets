import type { ConfigService } from '@nestjs/config';

/**
 * A ConfigService-shaped view over a fixed value map (ADR-024). The provider
 * factory resolves secrets + config into the exact env keys each adapter reads,
 * then hands the adapter this shim — so the existing adapter constructors are
 * reused UNCHANGED (no provider rewrites) while their credentials come from the
 * secret manager rather than process.env.
 */
export function makeConfigShim(values: Record<string, string | undefined>): ConfigService {
  const get = <T = string>(key: string): T | undefined => values[key] as unknown as T;
  const getOrThrow = <T = string>(key: string): T => {
    const value = values[key];
    if (value === undefined || value === '') {
      throw new Error(`Missing required configuration '${key}'.`);
    }
    return value as unknown as T;
  };
  return { get, getOrThrow } as unknown as ConfigService;
}
