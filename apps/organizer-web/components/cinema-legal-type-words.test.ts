import { describe, expect, it } from 'vitest';
import { legalTypeText, legalTypeWord } from './cinema-legal-type-words';

describe('a cinema legal type in words', () => {
  it('uses the words on a licence, not enum names', () => {
    expect(
      legalTypeText({
        localBodyType: 'MUNICIPAL_CORPORATION',
        cinemaFormat: 'MULTIPLEX',
        climateType: 'NON_AC',
      }),
    ).toBe('Municipal corporation, Multiplex, Not air-conditioned');
    expect(legalTypeWord('AIR_COOLED')).toBe('Air-cooled');
  });

  it('names the parts that are missing', () => {
    expect(
      legalTypeText({ localBodyType: null, cinemaFormat: 'MULTIPLEX', climateType: null }),
    ).toBe('local body not set, Multiplex, cooling not set');
  });

  it('says nothing is on record as null, for the caller to word', () => {
    expect(
      legalTypeText({ localBodyType: null, cinemaFormat: null, climateType: null }),
    ).toBeNull();
  });
});
