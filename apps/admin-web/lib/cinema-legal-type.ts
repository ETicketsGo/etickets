/**
 * A cinema's legal type in plain words, for the admin legal-type screen.
 *
 * The values are the API's enum names; the labels are what an exhibitor's licence says. Kept in
 * one place so the dropdowns, the list and the history read the same.
 */
export const LOCAL_BODY_OPTIONS = [
  { value: 'MUNICIPAL_CORPORATION', label: 'Municipal corporation' },
  { value: 'MUNICIPALITY', label: 'Municipality' },
  { value: 'NAGAR_PANCHAYAT', label: 'Nagar panchayat' },
  { value: 'GRAM_PANCHAYAT', label: 'Gram panchayat' },
  { value: 'OTHER', label: 'Other local body' },
] as const;

export const FORMAT_OPTIONS = [
  { value: 'MULTIPLEX', label: 'Multiplex' },
  { value: 'SINGLE_SCREEN', label: 'Single screen' },
  { value: 'SPECIAL_THEATRE', label: 'Special theatre' },
] as const;

export const CLIMATE_OPTIONS = [
  { value: 'AC', label: 'Air-conditioned' },
  { value: 'AIR_COOLED', label: 'Air-cooled' },
  { value: 'NON_AC', label: 'Not air-conditioned' },
] as const;

const LABELS: Record<string, string> = Object.fromEntries(
  [...LOCAL_BODY_OPTIONS, ...FORMAT_OPTIONS, ...CLIMATE_OPTIONS].map((o) => [o.value, o.label]),
);

/** "Municipal corporation, Multiplex, Air-conditioned"; gaps named; null when nothing is set. */
export function legalTypeSummary(t: {
  localBodyType: string | null;
  cinemaFormat: string | null;
  climateType: string | null;
}): string | null {
  if (!t.localBodyType && !t.cinemaFormat && !t.climateType) return null;
  const word = (v: string | null, gap: string) => (v ? (LABELS[v] ?? v) : gap);
  return [
    word(t.localBodyType, 'local body not set'),
    word(t.cinemaFormat, 'format not set'),
    word(t.climateType, 'cooling not set'),
  ].join(', ');
}
