import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRobots, disallowedPaths } from './robots-rules';
import robots from '../app/robots';

afterEach(() => vi.unstubAllEnvs());

function firstRule(r: ReturnType<typeof buildRobots>) {
  return Array.isArray(r.rules) ? r.rules[0] : r.rules;
}

describe('buildRobots', () => {
  it('production: allows crawling, lists the sitemap, keeps private paths out', () => {
    const r = buildRobots({ indexable: true, siteUrl: 'https://www.eticketsgo.com' });
    expect(r.sitemap).toBe('https://www.eticketsgo.com/sitemap.xml');
    expect(r).not.toHaveProperty('host');
    const rule = firstRule(r);
    expect(rule.userAgent).toBe('*');
    expect(rule.allow).toBe('/');
    for (const p of ['/account', '/booking', '/login', '/register', '/api/', '/share']) {
      expect(rule.disallow).toContain(p);
    }
    for (const p of ['/checkout', '/shows', '/invite', '/reset-password', '/forgot-password']) {
      expect(rule.disallow).toContain(p);
      expect(rule.disallow).toContain(`/fr-CA${p}`);
    }
    // Public content stays crawlable.
    expect(rule.disallow).not.toContain('/events');
    expect(rule.disallow).not.toContain('/movies');
  });

  it('not production: disallows everything and advertises no sitemap', () => {
    const r = buildRobots({ indexable: false, siteUrl: 'https://qa.eticketsgo.com' });
    expect(r).toEqual({ rules: { userAgent: '*', disallow: '/' } });
  });

  it('lists every private path once', () => {
    const paths = disallowedPaths();
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('app/robots.ts reads the configuration', () => {
  it('production configuration => indexable robots.txt', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://www.eticketsgo.com');
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', '');
    const r = robots();
    expect(r.sitemap).toBe('https://www.eticketsgo.com/sitemap.xml');
    expect(firstRule(r).allow).toBe('/');
  });

  it('QA configuration => Disallow: /', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://qa.eticketsgo.com');
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'QA');
    const r = robots();
    expect(r.sitemap).toBeUndefined();
    expect(r.rules).toEqual({ userAgent: '*', disallow: '/' });
  });
});
