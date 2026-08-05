import { legalLinks, legalUrl } from '../legal';

/**
 * These URLs go in the app AND in both store listings, and the stores check that the
 * privacy policy matches. Deriving them from one host is what keeps those in step.
 */
jest.mock('@/services/env', () => ({
  env: { webHost: 'qa.eticketsgo.com', apiUrl: '', sentryDsn: null, env: 'staging' },
}));

describe('legal URLs', () => {
  it('builds every document from the configured host', () => {
    expect(legalUrl('terms')).toBe('https://qa.eticketsgo.com/legal/terms');
    expect(legalUrl('privacy')).toBe('https://qa.eticketsgo.com/legal/privacy');
    expect(legalUrl('refunds')).toBe('https://qa.eticketsgo.com/legal/refund-policy');
  });

  it('always uses https', () => {
    // These are opened in a system browser; an http link would be a downgrade the user
    // can see in the address bar.
    for (const link of legalLinks()) expect(link.url.startsWith('https://')).toBe(true);
  });

  it('exposes a labelled list for the settings screen', () => {
    const links = legalLinks();

    expect(links.map((l) => l.key)).toEqual(['terms', 'privacy', 'refunds']);
    for (const link of links) expect(link.label.length).toBeGreaterThan(0);
  });
});
