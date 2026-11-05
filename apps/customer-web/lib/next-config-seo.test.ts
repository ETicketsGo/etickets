import { afterEach, describe, expect, it, vi } from 'vitest';

/*
  next.config.mjs reads the configuration when it loads, so each case loads it fresh.
*/
async function loadConfig(siteUrl: string, appEnv: string) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', siteUrl);
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', appEnv);
  const mod = await import('../next.config.mjs');
  return mod.default as {
    htmlLimitedBots?: RegExp;
    headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>;
  };
}

async function robotsHeader(siteUrl: string, appEnv: string) {
  const config = await loadConfig(siteUrl, appEnv);
  const rules = await config.headers();
  const all = rules.find((r) => r.source === '/:path*');
  return all?.headers.find((h) => h.key === 'X-Robots-Tag')?.value ?? null;
}

afterEach(() => vi.unstubAllEnvs());

describe('next.config.mjs X-Robots-Tag', () => {
  it('production configuration sends no noindex header', async () => {
    expect(await robotsHeader('https://www.eticketsgo.com', '')).toBeNull();
  });

  it('QA and UAT send noindex, nofollow on every response', async () => {
    expect(await robotsHeader('https://qa.eticketsgo.com', 'QA')).toBe('noindex, nofollow');
    expect(await robotsHeader('https://uat.eticketsgo.com', 'UAT')).toBe('noindex, nofollow');
  });

  it('puts metadata in <head> for every user agent', async () => {
    const config = await loadConfig('https://www.eticketsgo.com', '');
    expect(config.htmlLimitedBots?.test('Googlebot')).toBe(true);
    expect(config.htmlLimitedBots?.test('SomeNewCrawler/1.0')).toBe(true);
  });
});
