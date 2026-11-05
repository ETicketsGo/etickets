import { describe, expect, it } from 'vitest';
import {
  CANONICAL_HOST,
  NOINDEX_ALIAS,
  NOINDEX_ALL,
  isIndexableDeployment,
  normaliseSiteUrl,
  robotsTagFor,
} from './indexability.mjs';

/*
  The production pin. If any of these fail, the live storefront would drop out of Google -
  or QA would go into it. Change them only with the owner's decision.
*/
describe('isIndexableDeployment', () => {
  it('production configuration is indexable', () => {
    expect(
      isIndexableDeployment({ siteUrl: 'https://www.eticketsgo.com', appEnv: undefined }),
    ).toBe(true);
    expect(isIndexableDeployment({ siteUrl: 'https://www.eticketsgo.com/', appEnv: '' })).toBe(
      true,
    );
    expect(
      isIndexableDeployment({ siteUrl: 'https://www.eticketsgo.com', appEnv: 'PRODUCTION' }),
    ).toBe(true);
    expect(
      isIndexableDeployment({ siteUrl: ' https://WWW.eticketsgo.com ', appEnv: 'production' }),
    ).toBe(true);
  });

  it('QA and UAT are never indexable', () => {
    expect(isIndexableDeployment({ siteUrl: 'https://qa.eticketsgo.com', appEnv: 'QA' })).toBe(
      false,
    );
    expect(isIndexableDeployment({ siteUrl: 'https://uat.eticketsgo.com', appEnv: 'UAT' })).toBe(
      false,
    );
    expect(
      isIndexableDeployment({ siteUrl: 'https://customer-web-qa.up.railway.app', appEnv: '' }),
    ).toBe(false);
  });

  it('a test environment name wins even with the production URL', () => {
    expect(isIndexableDeployment({ siteUrl: 'https://www.eticketsgo.com', appEnv: 'QA' })).toBe(
      false,
    );
  });

  it('fails closed when the site URL is missing, the apex, or not a URL', () => {
    expect(isIndexableDeployment({ siteUrl: undefined, appEnv: undefined })).toBe(false);
    expect(isIndexableDeployment({ siteUrl: '', appEnv: '' })).toBe(false);
    expect(isIndexableDeployment({ siteUrl: 'https://eticketsgo.com', appEnv: '' })).toBe(false);
    expect(isIndexableDeployment({ siteUrl: 'www.eticketsgo.com', appEnv: '' })).toBe(false);
    expect(isIndexableDeployment({ siteUrl: 'https://www.eticketsgo.com.evil.test' })).toBe(false);
  });
});

describe('normaliseSiteUrl', () => {
  it('defaults to www, never the apex', () => {
    expect(normaliseSiteUrl(undefined)).toBe('https://www.eticketsgo.com');
    expect(normaliseSiteUrl('  ')).toBe('https://www.eticketsgo.com');
    expect(normaliseSiteUrl('https://qa.eticketsgo.com/')).toBe('https://qa.eticketsgo.com');
  });
});

describe('robotsTagFor', () => {
  it('non-production: noindex, nofollow on every host', () => {
    expect(robotsTagFor({ indexable: false, host: 'qa.eticketsgo.com' })).toBe(NOINDEX_ALL);
    expect(robotsTagFor({ indexable: false, host: null })).toBe(NOINDEX_ALL);
  });

  it('production on the canonical host: no header', () => {
    expect(robotsTagFor({ indexable: true, host: CANONICAL_HOST })).toBeNull();
    expect(robotsTagFor({ indexable: true, host: 'WWW.eticketsgo.com:443' })).toBeNull();
  });

  it('production on another public host: noindex', () => {
    expect(robotsTagFor({ indexable: true, host: 'customer-web-production.up.railway.app' })).toBe(
      NOINDEX_ALIAS,
    );
    expect(robotsTagFor({ indexable: true, host: 'eticketsgo.com' })).toBe(NOINDEX_ALIAS);
    // The first of a forwarded list is the one the client used.
    expect(robotsTagFor({ indexable: true, host: 'x.up.railway.app, www.eticketsgo.com' })).toBe(
      NOINDEX_ALIAS,
    );
  });

  it('production with an unknown or internal host: no header, never a guess', () => {
    expect(robotsTagFor({ indexable: true, host: null })).toBeNull();
    expect(robotsTagFor({ indexable: true, host: 'localhost:3000' })).toBeNull();
    expect(robotsTagFor({ indexable: true, host: 'customer-web.railway.internal' })).toBeNull();
    expect(robotsTagFor({ indexable: true, host: '10.0.0.5:8080' })).toBeNull();
  });
});
