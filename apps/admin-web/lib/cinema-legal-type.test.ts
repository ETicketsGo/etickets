import { describe, expect, it } from 'vitest';
import { legalTypeSummary, placeLine } from './cinema-legal-type';

describe('legalTypeSummary', () => {
  it('reads the legal type in words, never enum names', () => {
    expect(
      legalTypeSummary({
        localBodyType: 'MUNICIPAL_CORPORATION',
        cinemaFormat: 'MULTIPLEX',
        climateType: 'AIR_COOLED',
      }),
    ).toBe('Municipal corporation, Multiplex, Air-cooled');
  });

  it('names each gap, so a half-set legal type is not mistaken for a whole one', () => {
    expect(
      legalTypeSummary({ localBodyType: null, cinemaFormat: 'SINGLE_SCREEN', climateType: null }),
    ).toBe('Local body not set, Single screen, Cooling not set');
  });

  it('is null when nothing is on record', () => {
    expect(legalTypeSummary({ localBodyType: null, cinemaFormat: null, climateType: null })).toBe(
      null,
    );
  });
});

describe('placeLine', () => {
  it('names the country one way, however it was stored', () => {
    expect(placeLine({ city: 'Bengaluru', region: 'Karnataka', country: 'IN' })).toBe(
      'Bengaluru, Karnataka, India',
    );
    expect(placeLine({ city: 'Bengaluru', region: 'Karnataka', country: 'India' })).toBe(
      'Bengaluru, Karnataka, India',
    );
    expect(placeLine({ city: 'Toronto', region: 'Ontario', country: 'CA' })).toBe(
      'Toronto, Ontario, Canada',
    );
  });

  it('is empty when nothing is recorded', () => {
    expect(placeLine({ city: null, region: null, country: null })).toBe('');
  });
});
