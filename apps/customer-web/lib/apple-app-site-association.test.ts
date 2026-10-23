import { describe, expect, it } from 'vitest';
import { buildAppleAppSiteAssociation, parseAppIds } from './apple-app-site-association';

describe('apple-app-site-association', () => {
  it('serves nothing until approved app IDs are configured (no behaviour change by default)', () => {
    expect(buildAppleAppSiteAssociation(undefined)).toBeNull();
    expect(buildAppleAppSiteAssociation('')).toBeNull();
    expect(buildAppleAppSiteAssociation('not-an-app-id, com.eticketsgo.customer')).toBeNull();
  });

  it('lists only well-formed TEAMID.bundle IDs', () => {
    expect(
      parseAppIds(
        ' ABCDE12345.com.eticketsgo.customer.native.qa , bogus, ABCDE12345.com.eticketsgo.customer.native ',
      ),
    ).toEqual([
      'ABCDE12345.com.eticketsgo.customer.native.qa',
      'ABCDE12345.com.eticketsgo.customer.native',
    ]);
  });

  it('claims shared pages but leaves payment returns to the browser', () => {
    const aasa = buildAppleAppSiteAssociation('ABCDE12345.com.eticketsgo.customer.native.qa');
    const components = aasa!.applinks.details[0].components;
    const excluded = components.filter((c) => 'exclude' in c).map((c) => c['/']);
    const claimed = components.filter((c) => !('exclude' in c)).map((c) => c['/']);
    expect(excluded).toEqual(['/checkout/*', '/fr-CA/checkout/*']);
    expect(claimed).toContain('/events/*');
    expect(claimed).toContain('/fr-CA/booking/*');
    // Apple evaluates components in order: the exclusions must come first.
    expect(components.findIndex((c) => 'exclude' in c)).toBe(0);
  });
});
