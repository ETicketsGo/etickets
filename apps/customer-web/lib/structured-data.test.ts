import { describe, expect, it } from 'vitest';
import {
  buildEventJsonLd,
  buildOrganizationJsonLd,
  buildWebSiteJsonLd,
  isoWithOffset,
  majorUnits,
  serializeJsonLd,
  type EventForStructuredData,
} from './structured-data';

const SITE = 'https://www.eticketsgo.com';
const ctx = { pageUrl: `${SITE}/events/jazz-night`, apiUrl: 'https://api.test/api' };

function event(overrides: Partial<EventForStructuredData> = {}): EventForStructuredData {
  return {
    title: 'Jazz Night',
    slug: 'jazz-night',
    description: 'Live jazz.',
    imagePath: '/public/events/e1/images/i1?v=abc',
    venue: {
      name: 'Blue Room',
      city: 'Hyderabad',
      country: 'India',
      region: 'Telangana',
      address: '12 Road No. 1',
    },
    timeZone: 'Asia/Kolkata',
    organizer: { name: 'Good Gigs', website: 'https://goodgigs.test' },
    sessions: [
      {
        id: 's1',
        startsAt: '2026-11-02T14:00:00.000Z',
        endsAt: '2026-11-02T17:00:00.000Z',
        status: 'SCHEDULED',
        timeZone: 'Asia/Kolkata',
        seatBased: false,
        ticketTypes: [
          { priceMinor: 45000, currency: 'INR', available: 10, saleState: 'ON_SALE' },
          { priceMinor: 90000, currency: 'INR', available: 2, saleState: 'ON_SALE' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('serializeJsonLd', () => {
  it('escapes < so text cannot close the script tag', () => {
    const out = serializeJsonLd({ description: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('<');
    expect(out).toContain('\\u003c/script>');
    expect(JSON.parse(out).description).toBe('</script><script>alert(1)</script>');
  });
});

describe('buildOrganizationJsonLd', () => {
  it('names the brand with its logo, and only the facts it is given', () => {
    const org = buildOrganizationJsonLd({ siteUrl: SITE });
    expect(org).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': `${SITE}/#organization`,
      name: 'ETicketsGo',
      url: `${SITE}/`,
      logo: `${SITE}/icon-512.png`,
    });
    const full = buildOrganizationJsonLd({
      siteUrl: SITE,
      legalName: 'DeepTrics LLC',
      email: 'support@eticketsgo.com',
    });
    expect(full.legalName).toBe('DeepTrics LLC');
    expect(full.email).toBe('support@eticketsgo.com');
    // Nothing we do not hold.
    for (const key of ['address', 'telephone', 'aggregateRating', 'review', 'sameAs']) {
      expect(full).not.toHaveProperty(key);
    }
  });
});

describe('buildOrganizationJsonLd with operators', () => {
  it('lists each company under the brand, with no top-level legalName', () => {
    const org = buildOrganizationJsonLd({
      siteUrl: SITE,
      operators: [
        { legalName: 'DeepTrics Software Solutions Private Limited', country: 'IN' },
        { legalName: 'DeepTrics LLC', country: 'US' },
      ],
    });
    expect(org).not.toHaveProperty('legalName');
    expect(org.subOrganization).toEqual([
      {
        '@type': 'Organization',
        legalName: 'DeepTrics Software Solutions Private Limited',
        address: { '@type': 'PostalAddress', addressCountry: 'IN' },
        parentOrganization: { '@id': `${SITE}/#organization` },
      },
      {
        '@type': 'Organization',
        legalName: 'DeepTrics LLC',
        address: { '@type': 'PostalAddress', addressCountry: 'US' },
        parentOrganization: { '@id': `${SITE}/#organization` },
      },
    ]);
  });
});

describe('buildWebSiteJsonLd', () => {
  it('points the search box at the real events search', () => {
    const site = buildWebSiteJsonLd({ siteUrl: SITE }) as {
      potentialAction: { target: { urlTemplate: string } };
    };
    expect(site.potentialAction.target.urlTemplate).toBe(`${SITE}/events?q={search_term_string}`);
  });
});

describe('isoWithOffset', () => {
  it('writes the time in the venue clock with its offset', () => {
    expect(isoWithOffset('2026-11-02T14:00:00.000Z', 'Asia/Kolkata')).toBe(
      '2026-11-02T19:30:00+05:30',
    );
    expect(isoWithOffset('2026-07-01T23:00:00.000Z', 'America/Chicago')).toBe(
      '2026-07-01T18:00:00-05:00',
    );
  });

  it('falls back to UTC for a missing or unknown zone, and null for a bad date', () => {
    expect(isoWithOffset('2026-11-02T14:00:00.000Z', null)).toBe('2026-11-02T14:00:00Z');
    expect(isoWithOffset('2026-11-02T14:00:00.000Z', 'Not/AZone')).toBe('2026-11-02T14:00:00Z');
    expect(isoWithOffset('nonsense', 'Asia/Kolkata')).toBeNull();
  });
});

describe('majorUnits', () => {
  it('uses the currency precision', () => {
    expect(majorUnits(45000, 'INR')).toBe('450.00');
    expect(majorUnits(1999, 'USD')).toBe('19.99');
    expect(majorUnits(500, 'JPY')).toBe('500');
    expect(majorUnits(-1, 'INR')).toBeNull();
  });
});

describe('buildEventJsonLd', () => {
  it('builds an Event from the API fields only', () => {
    const [ld] = buildEventJsonLd(event(), ctx);
    expect(ld).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: 'Jazz Night',
      url: ctx.pageUrl,
      startDate: '2026-11-02T19:30:00+05:30',
      endDate: '2026-11-02T22:30:00+05:30',
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      location: {
        '@type': 'Place',
        name: 'Blue Room',
        address: {
          '@type': 'PostalAddress',
          streetAddress: '12 Road No. 1',
          addressLocality: 'Hyderabad',
          addressRegion: 'Telangana',
          addressCountry: 'India',
        },
      },
      image: ['https://api.test/api/public/events/e1/images/i1?v=abc'],
      description: 'Live jazz.',
      organizer: { '@type': 'Organization', name: 'Good Gigs', url: 'https://goodgigs.test' },
      offers: {
        '@type': 'AggregateOffer',
        lowPrice: '450.00',
        highPrice: '900.00',
        offerCount: 2,
        priceCurrency: 'INR',
        url: ctx.pageUrl,
        availability: 'https://schema.org/InStock',
      },
    });
    // Never invented.
    for (const key of ['aggregateRating', 'review', 'performer']) {
      expect(ld).not.toHaveProperty(key);
    }
  });

  it('omits offers when there are no ticket prices, and fields that are absent', () => {
    const [ld] = buildEventJsonLd(
      event({
        description: '  ',
        imagePath: null,
        organizer: null,
        venue: { name: 'Blue Room', city: null, country: null, address: null },
        sessions: [{ id: 's1', startsAt: '2026-11-02T14:00:00.000Z', status: 'SCHEDULED' }],
      }),
      ctx,
    );
    expect(ld).not.toHaveProperty('offers');
    expect(ld).not.toHaveProperty('image');
    expect(ld).not.toHaveProperty('description');
    expect(ld).not.toHaveProperty('organizer');
    expect(ld).not.toHaveProperty('endDate');
    expect(ld.location).toEqual({ '@type': 'Place', name: 'Blue Room' });
  });

  it('omits availability unless the API states it plainly', () => {
    const seated = event();
    seated.sessions![0].seatBased = true;
    expect(buildEventJsonLd(seated, ctx)[0].offers).not.toHaveProperty('availability');

    const noCounts = event();
    noCounts.sessions![0].ticketTypes = [{ priceMinor: 45000, currency: 'INR' }];
    expect(buildEventJsonLd(noCounts, ctx)[0].offers).toEqual({
      '@type': 'Offer',
      price: '450.00',
      priceCurrency: 'INR',
      url: ctx.pageUrl,
    });

    const paused = event();
    paused.sessions![0].status = 'PAUSED';
    expect(buildEventJsonLd(paused, ctx)[0].offers).not.toHaveProperty('availability');
  });

  it('says SoldOut only when every on-sale ticket type reports none left', () => {
    const sold = event();
    sold.sessions![0].ticketTypes = sold.sessions![0].ticketTypes!.map((t) => ({
      ...t,
      available: 0,
    }));
    expect((buildEventJsonLd(sold, ctx)[0].offers as { availability: string }).availability).toBe(
      'https://schema.org/SoldOut',
    );
  });

  it('does not mix currencies into one offer', () => {
    const mixed = event();
    mixed.sessions![0].ticketTypes![1].currency = 'USD';
    expect(buildEventJsonLd(mixed, ctx)[0]).not.toHaveProperty('offers');
  });

  it('returns nothing for an event with no upcoming date', () => {
    expect(buildEventJsonLd(event({ sessions: [] }), ctx)).toEqual([]);
  });

  it('one Event per date, capped', () => {
    const many = event({
      sessions: Array.from({ length: 15 }, (_, i) => ({
        id: `s${i}`,
        startsAt: new Date(Date.UTC(2026, 10, 1 + i, 14)).toISOString(),
        status: 'SCHEDULED',
      })),
    });
    expect(buildEventJsonLd(many, ctx)).toHaveLength(10);
  });

  it('serialized output is valid JSON', () => {
    const out = serializeJsonLd(buildEventJsonLd(event({ description: 'a < b' }), ctx));
    expect(() => JSON.parse(out)).not.toThrow();
  });
});
