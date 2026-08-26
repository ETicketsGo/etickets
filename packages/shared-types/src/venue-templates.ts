/**
 * The venue shapes an organizer can start a seat layout from.
 *
 * ── WHY THE CATALOGUE IS SHARED AND THE GENERATOR IS NOT ───────────────────────────
 * Building a venue is server work: it writes thousands of rows and has to be authorized,
 * transactional and idempotent. Choosing one is client work, and the console needs the
 * names, the descriptions and — crucially — the sizes to render a picker.
 *
 * So the list lives here and the geometry lives in the API. The number below is the one an
 * organizer decides on, which makes a stale value worse than no value: a test in the API
 * regenerates every template and fails if its real seat count has drifted more than a few
 * per cent from what this file advertises. That test is what makes it safe to state these
 * as facts rather than as estimates.
 */
export type VenueTemplateKey =
  'CINEMA' | 'PROSCENIUM' | 'AMPHITHEATRE' | 'ARENA' | 'STADIUM' | 'IN_THE_ROUND';

export interface VenueTemplateOption {
  key: VenueTemplateKey;
  label: string;
  description: string;
  /** Seats the defaults actually produce. Measured by a test, not estimated. */
  approximateSeats: number;
}

export const VENUE_TEMPLATES: VenueTemplateOption[] = [
  {
    key: 'CINEMA',
    label: 'Cinema screen',
    description: 'One block of rows facing a screen. What every existing layout already is.',
    approximateSeats: 180,
  },
  {
    key: 'PROSCENIUM',
    label: 'Theatre',
    description: 'Stalls, dress circle and balcony facing a stage at one end.',
    approximateSeats: 640,
  },
  {
    key: 'AMPHITHEATRE',
    label: 'Amphitheatre',
    description: 'A fan of wedge-shaped blocks curving around an end stage.',
    approximateSeats: 3780,
  },
  {
    key: 'ARENA',
    label: 'Arena',
    description: 'Floor blocks inside a lower and upper bowl, for concerts and indoor sport.',
    approximateSeats: 11712,
  },
  {
    key: 'STADIUM',
    label: 'Stadium',
    description: 'Four stands and four corners around a pitch.',
    approximateSeats: 13776,
  },
  {
    key: 'IN_THE_ROUND',
    label: 'In the round',
    description: 'Four blocks surrounding a central stage.',
    approximateSeats: 1584,
  },
];
