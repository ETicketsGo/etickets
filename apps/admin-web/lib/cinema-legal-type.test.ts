import { describe, expect, it } from 'vitest';
import { legalTypeSummary } from './cinema-legal-type';

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
    ).toBe('local body not set, Single screen, cooling not set');
  });

  it('is null when nothing is on record', () => {
    expect(legalTypeSummary({ localBodyType: null, cinemaFormat: null, climateType: null })).toBe(
      null,
    );
  });
});
