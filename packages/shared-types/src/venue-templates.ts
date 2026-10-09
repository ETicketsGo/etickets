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
  | 'CINEMA'
  | 'PREMIUM_CINEMA'
  | 'AUDITORIUM'
  | 'FLAT_HALL'
  | 'PROSCENIUM'
  | 'AMPHITHEATRE'
  | 'ARENA'
  | 'BASKETBALL'
  | 'STADIUM'
  | 'IN_THE_ROUND';

/** Every template key, in catalogue order. The validation schema is built from this list. */
export const VENUE_TEMPLATE_KEYS = [
  'CINEMA',
  'PREMIUM_CINEMA',
  'AUDITORIUM',
  'FLAT_HALL',
  'PROSCENIUM',
  'AMPHITHEATRE',
  'ARENA',
  'BASKETBALL',
  'STADIUM',
  'IN_THE_ROUND',
] as const satisfies readonly VenueTemplateKey[];

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
    key: 'PREMIUM_CINEMA',
    label: 'Premium cinema',
    description: 'A few wide rows of recliners facing a screen, with a centre aisle.',
    approximateSeats: 72,
  },
  {
    key: 'AUDITORIUM',
    label: 'Auditorium',
    description: 'Stalls in front and a balcony behind, facing a stage.',
    approximateSeats: 504,
  },
  {
    key: 'FLAT_HALL',
    label: 'Flat hall',
    description: 'Rows on a flat floor with a centre aisle, facing a stage.',
    approximateSeats: 120,
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
    key: 'BASKETBALL',
    label: 'Basketball arena',
    description: 'Courtside rows and a two-tier bowl of numbered blocks around a court.',
    approximateSeats: 7628,
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

/**
 * The layout gallery: the seven starting points an organizer is offered first.
 *
 * ── WHY A SECOND LIST ──────────────────────────────────────────────────────────────
 * `VENUE_TEMPLATES` is what the generator can build. This is what a person picking a room
 * recognises: "Concert arena" rather than "Arena", and general admission, which builds no
 * seats at all and so has no generator entry. Every seated card points at a real template,
 * so its capacity and its picture come from the same geometry that will be written.
 *
 * `style` says which builder the card fills: GRID cards can pre-fill the row-by-row
 * generator, SECTIONED cards need the block builder, and GA needs no seat map.
 */
export type LayoutGalleryStyle = 'GRID' | 'SECTIONED' | 'GA';

export interface LayoutGalleryOption {
  id: string;
  label: string;
  /** One plain sentence: what it is and when to use it. */
  sentence: string;
  style: LayoutGalleryStyle;
  /** The template it builds. Null only for general admission, which builds no seats. */
  template: VenueTemplateKey | null;
}

export const LAYOUT_GALLERY: LayoutGalleryOption[] = [
  {
    id: 'cinema',
    label: 'Cinema',
    sentence: 'Rows of seats facing a screen. Use it for a standard cinema screen.',
    style: 'GRID',
    template: 'CINEMA',
  },
  {
    id: 'premium-cinema',
    label: 'Premium cinema',
    sentence: 'Fewer, wider rows of recliners. Use it for a luxury or recliner screen.',
    style: 'GRID',
    template: 'PREMIUM_CINEMA',
  },
  {
    id: 'auditorium',
    label: 'Auditorium',
    sentence: 'Stalls in front and a balcony behind. Use it for talks, plays and recitals.',
    style: 'GRID',
    template: 'AUDITORIUM',
  },
  {
    id: 'flat-hall',
    label: 'Flat hall',
    sentence: 'Rows on a flat floor with a centre aisle. Use it for halls and classrooms.',
    style: 'GRID',
    template: 'FLAT_HALL',
  },
  {
    id: 'basketball-arena',
    label: 'Basketball arena',
    sentence: 'Courtside rows and numbered blocks around a court. Use it for indoor sport.',
    style: 'SECTIONED',
    template: 'BASKETBALL',
  },
  {
    id: 'concert-arena',
    label: 'Concert arena',
    sentence: 'An end stage, floor blocks in front and two tiers around. Use it for big concerts.',
    style: 'SECTIONED',
    template: 'ARENA',
  },
  {
    id: 'general-admission',
    label: 'General admission',
    sentence: 'No seat map. Sell a number of tickets. Use it when people stand or sit anywhere.',
    style: 'GA',
    template: null,
  },
];
