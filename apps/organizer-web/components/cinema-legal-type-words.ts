/**
 * A cinema's legal type in words: "Municipal corporation, Multiplex, Air-conditioned".
 *
 * The API sends enum names (MUNICIPAL_CORPORATION, AIR_COOLED). Lower-casing them with the
 * underscores swapped out gave "air_cooled" and "municipal corporation" - code words on a
 * screen an exhibitor reads to check their licence. These are the words the admin console uses.
 */
const WORDS: Record<string, string> = {
  MUNICIPAL_CORPORATION: 'Municipal corporation',
  MUNICIPALITY: 'Municipality',
  NAGAR_PANCHAYAT: 'Nagar panchayat',
  GRAM_PANCHAYAT: 'Gram panchayat',
  OTHER: 'Other local body',
  MULTIPLEX: 'Multiplex',
  SINGLE_SCREEN: 'Single screen',
  SPECIAL_THEATRE: 'Special theatre',
  AC: 'Air-conditioned',
  AIR_COOLED: 'Air-cooled',
  NON_AC: 'Not air-conditioned',
};

export function legalTypeWord(value: string | null | undefined): string | null {
  if (!value) return null;
  return WORDS[value] ?? value.replace(/_/g, ' ').toLowerCase();
}

/** All three, in order, with "local body not set" style gaps; null when none is on record. */
export function legalTypeText(t: {
  localBodyType: string | null;
  cinemaFormat: string | null;
  climateType: string | null;
}): string | null {
  if (!t.localBodyType && !t.cinemaFormat && !t.climateType) return null;
  return [
    legalTypeWord(t.localBodyType) ?? 'local body not set',
    legalTypeWord(t.cinemaFormat) ?? 'format not set',
    legalTypeWord(t.climateType) ?? 'cooling not set',
  ].join(', ');
}
