import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setServerApiRoute } from './api';

/**
 * The server-side route for page renders (api.ts `setServerApiRoute`): only anonymous GETs made
 * on a server take it; a browser, a signed-in call or a write keeps the public URL.
 */
const ROUTE = {
  base: 'http://api.internal:8080/api',
  headers: { 'x-etg-internal-key': 'k'.repeat(40), 'x-etg-client-ip': '49.36.8.9' },
};

describe('server API route', () => {
  const calls: { url: string; headers: Headers; method: string }[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: new Headers(init.headers),
        method: (init.method ?? 'GET').toUpperCase(),
      });
      return new Response('[]', { status: 200 });
    });
  });
  afterEach(() => {
    setServerApiRoute(null);
    vi.unstubAllGlobals();
  });

  it('is the public URL when nothing is registered', async () => {
    await api.publicCategories();
    expect(calls[0].url).not.toContain('api.internal');
    expect(calls[0].headers.has('x-etg-internal-key')).toBe(false);
  });

  it('sends an anonymous server-side GET over the registered route, with its headers', async () => {
    setServerApiRoute(() => ROUTE);
    if (typeof window !== 'undefined') return; // the browser test environment never takes it
    await api.publicCategories();
    expect(calls[0].url.startsWith('http://api.internal:8080/api/')).toBe(true);
    expect(calls[0].headers.get('x-etg-internal-key')).toBe(ROUTE.headers['x-etg-internal-key']);
    expect(calls[0].headers.get('x-etg-client-ip')).toBe('49.36.8.9');
  });

  it('never routes a write (sign-in) internally', async () => {
    setServerApiRoute(() => ROUTE);
    await api.auth.login({ email: 'a@b.test', password: 'pw' }).catch(() => undefined);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).not.toContain('api.internal');
    expect(calls[0].headers.has('x-etg-internal-key')).toBe(false);
  });

  it('keeps the public URL when the route says null or throws', async () => {
    setServerApiRoute(() => null);
    await api.publicCategories();
    setServerApiRoute(() => {
      throw new Error('no request');
    });
    await api.publicCategories();
    for (const c of calls) expect(c.url).not.toContain('api.internal');
  });
});
