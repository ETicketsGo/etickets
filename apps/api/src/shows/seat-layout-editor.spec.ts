import { countLayoutDocument, reconcileSeats } from '@eticketsgo/shared-types';
import { saveLayoutDocumentSchema } from '@eticketsgo/validation';
import { toLayoutDocument, type StoredLayout } from './seat-layout-document';
import {
  VENUE_TEMPLATES,
  generateVenue,
  generateVenueForTarget,
  seatCount,
  templateSizeOptions,
  trimVenue,
  type VenueTemplateKey,
} from './venue-templates';

/**
 * E1: an organizer shapes a draft layout.
 *
 * Two promises are pinned here without a database. A template asked for exactly N seats builds
 * exactly N - the owner asked for 100 and got "about 110". And a stored layout read into the
 * editor's document and saved back is the same room: nothing about its seats, numbers or
 * categories is lost by opening it.
 */

const kindsOf = (venue: ReturnType<typeof generateVenue>) => {
  const counts = new Map<string, number>();
  for (const s of venue.sections)
    for (const r of s.rows)
      for (const seat of r.seats) counts.set(seat.kind, (counts.get(seat.kind) ?? 0) + 1);
  return counts;
};

describe('a template built at exactly the planned size', () => {
  it('builds the 100-seat amphitheatre the owner asked for, not 110', () => {
    const options = templateSizeOptions('AMPHITHEATRE', 100);
    expect(options.exact?.seats).toBe(100);
    expect(options.above?.seats).toBeGreaterThanOrEqual(100);
    expect(options.below?.seats ?? 0).toBeLessThanOrEqual(100);

    const venue = generateVenueForTarget('AMPHITHEATRE', 100, 'EXACT');
    expect(seatCount(venue)).toBe(100);
    // The wheelchair bay and its companion seat survive the trim.
    expect(kindsOf(venue).get('WHEELCHAIR')).toBe(1);
    expect(kindsOf(venue).get('COMPANION')).toBe(1);
  });

  it.each(VENUE_TEMPLATES.map((t) => t.key))(
    '%s: every target it can come close to is reachable exactly, and at-most never exceeds it',
    (key) => {
      for (const target of [60, 100, 150, 237, 500, 1200]) {
        const options = templateSizeOptions(key as VenueTemplateKey, target);
        if (options.exact) {
          expect(seatCount(generateVenueForTarget(key as VenueTemplateKey, target, 'EXACT'))).toBe(
            target,
          );
        }
        if (options.below) {
          const built = generateVenueForTarget(key as VenueTemplateKey, target, 'AT_MOST');
          expect(seatCount(built)).toBe(options.below.seats);
          expect(seatCount(built)).toBeLessThanOrEqual(target);
        }
        if (options.above) {
          expect(
            seatCount(generateVenueForTarget(key as VenueTemplateKey, target, 'AT_LEAST')),
          ).toBe(options.above.seats);
        }
      }
    },
  );

  it('refuses, in words, a size the shape cannot be', () => {
    // A stadium's smallest even room is well over 100: there is nothing honest to trim to.
    expect(templateSizeOptions('STADIUM', 100).exact).toBeNull();
    expect(() => generateVenueForTarget('STADIUM', 100, 'EXACT')).toThrow(
      'Stadium cannot be built with exactly 100 seats.',
    );
  });

  it('trims the longest rows first and never leaves a row ending in an aisle', () => {
    const venue = generateVenue('FLAT_HALL', { rows: 4, seatsPerRow: 10 });
    const before = seatCount(venue);
    trimVenue(venue, 6);
    expect(seatCount(venue)).toBe(before - 6);
    for (const row of venue.sections[0].rows) {
      expect(row.seats[row.seats.length - 1].kind).not.toBe('GAP');
    }
    const widths = venue.sections[0].rows.map(
      (r) => r.seats.filter((s) => s.kind !== 'GAP').length,
    );
    // Spread over the rows, not six seats off one row.
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(2);
  });
});

describe('a stored layout read into the editor and saved back', () => {
  const stored: StoredLayout = {
    name: 'Main',
    categories: [
      {
        id: 'c-std',
        name: 'Standard',
        colorHex: '#64748B',
        basePriceMinor: 4999,
        priceSuggested: false,
        regulatoryClass: null,
      },
      {
        id: 'c-prem',
        name: 'Premium',
        colorHex: '#7C3AED',
        basePriceMinor: 8498,
        priceSuggested: true,
        regulatoryClass: 'PREMIUM',
      },
    ],
    sections: [
      {
        name: 'Stalls',
        shape: null,
        labelX: null,
        labelY: null,
        tier: 'FLOOR',
        rotationDeg: 0,
        rows: [
          {
            label: 'A',
            seats: [0, 1, 2, 3].map((c) => ({
              label: String(c + 1),
              colIndex: c,
              kind: c === 2 ? 'GAP' : 'SEAT',
              seatCategoryId: 'c-std',
            })),
          },
          {
            label: 'B',
            // Numbered from 1 at colIndex 1, with a hole at colIndex 3, all Premium.
            seats: [1, 2, 4].map((c) => ({
              label: String(c),
              colIndex: c,
              kind: c === 1 ? 'WHEELCHAIR' : 'SEAT',
              seatCategoryId: 'c-prem',
            })),
          },
        ],
      },
    ],
    zones: [],
  };

  it('keeps kinds, numbers, row categories and the suggested-price mark', () => {
    const doc = toLayoutDocument(stored);
    expect(doc.categories.map((c) => [c.name, c.priceMinor, c.priceSuggested])).toEqual([
      ['Standard', 4999, false],
      ['Premium', 8498, true],
    ]);
    const [a, b] = doc.sections[0].rows;
    expect(a).toEqual({ label: 'A', kinds: 'SSGS', firstCol: 0 });
    // The hole reads as a gap, and the row keeps its own category.
    expect(b.kinds).toBe('WSGS');
    expect(b.firstCol).toBe(1);
    expect(b.labels).toEqual(['1', '2', '~3', '4']);
    expect(b.categoryKey).toBe('c-prem');
    // The document passes the save schema as read, so opening and saving is always possible.
    expect(saveLayoutDocumentSchema.safeParse(doc).success).toBe(true);
    // Counts agree with the shared reconciliation of the same seats.
    const counts = countLayoutDocument(doc);
    expect(counts.bookable).toBe(
      reconcileSeats([
        { kind: 'SEAT', count: 5 },
        { kind: 'WHEELCHAIR', count: 1 },
        { kind: 'GAP', count: 2 },
      ]).bookable,
    );
  });
});

describe('the save schema says what is wrong in plain words', () => {
  const base = {
    name: 'L',
    categories: [{ key: 'a', name: 'Front', priceMinor: 100 }],
    sections: [{ name: 'S', categoryKey: 'a', rows: [{ label: 'A', kinds: 'SSS' }] }],
  };
  const message = (doc: unknown) => {
    const r = saveLayoutDocumentSchema.safeParse(doc);
    return r.success ? null : r.error.issues.map((i) => i.message).join(' | ');
  };

  it('accepts a minimal room', () => {
    expect(message(base)).toBeNull();
  });
  it('refuses two categories with one name', () => {
    expect(
      message({
        ...base,
        categories: [...base.categories, { key: 'b', name: 'front', priceMinor: 1 }],
      }),
    ).toContain('Two ticket categories are called "front"');
  });
  it('refuses a section whose category was removed', () => {
    expect(
      message({ ...base, sections: [{ ...base.sections[0], categoryKey: 'gone' }] }),
    ).toContain('Section S has no ticket category.');
  });
  it('refuses an unknown seat letter', () => {
    expect(
      message({
        ...base,
        sections: [{ ...base.sections[0], rows: [{ label: 'A', kinds: 'SXS' }] }],
      }),
    ).toContain('A row holds only known seat kinds.');
  });
});
