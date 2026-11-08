import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

import { internalApiRoute } from './internal-api';

const KEY = 'k'.repeat(40);
const env = (extra: Record<string, string | undefined>) => extra as unknown as NodeJS.ProcessEnv;

describe('the private route for page renders', () => {
  it('is off (null = the public URL, as before) unless both variables are set', () => {
    expect(internalApiRoute(env({}), '1.2.3.4')).toBeNull();
    expect(
      internalApiRoute(
        env({ INTERNAL_API_URL: 'http://api.railway.internal:8080/api' }),
        '1.2.3.4',
      ),
    ).toBeNull();
    expect(internalApiRoute(env({ INTERNAL_API_KEY: KEY }), '1.2.3.4')).toBeNull();
  });

  it('refuses a key too short to be a secret, or a base that is not a URL', () => {
    expect(
      internalApiRoute(
        env({
          INTERNAL_API_URL: 'http://api.railway.internal:8080/api',
          INTERNAL_API_KEY: 'short',
        }),
        null,
      ),
    ).toBeNull();
    expect(
      internalApiRoute(
        env({ INTERNAL_API_URL: 'api.railway.internal', INTERNAL_API_KEY: KEY }),
        null,
      ),
    ).toBeNull();
  });

  it('carries the key and the visitor the edge reported', () => {
    const r = internalApiRoute(
      env({ INTERNAL_API_URL: 'http://api.railway.internal:8080/api/', INTERNAL_API_KEY: KEY }),
      '49.36.8.9',
    );
    expect(r).toEqual({
      base: 'http://api.railway.internal:8080/api',
      headers: { 'x-etg-internal-key': KEY, 'x-etg-client-ip': '49.36.8.9' },
    });
  });

  it('names no visitor when the edge gave none, a list, or junk', () => {
    for (const ip of [null, '', '1.1.1.1, 2.2.2.2', 'nope']) {
      const r = internalApiRoute(
        env({ INTERNAL_API_URL: 'http://api.railway.internal:8080/api', INTERNAL_API_KEY: KEY }),
        ip,
      );
      expect(r?.headers).toEqual({ 'x-etg-internal-key': KEY });
    }
  });
});
