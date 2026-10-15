/**
 * What kind of place a space is: asked ONCE, when the space is created.
 *
 * -- WHY THIS EXISTS -----------------------------------------------------------------------
 * Nothing recorded it. So every layout page asked "What kind of space is this?" again, and
 * still offered every template to every space: a cinema screen was offered a 7,628-seat
 * basketball arena and an 11,712-seat concert arena, and a standing floor was offered rows of
 * numbered seats. The kind is now stored on the space (`Screen.kind`) and the template list
 * follows from it.
 *
 * Mirrors the `SpaceKind` enum in the Prisma schema.
 */
import type { VenueTemplateKey } from './venue-templates';

export type SpaceKind = 'CINEMA_SCREEN' | 'SEATED_HALL' | 'ARENA' | 'STANDING';

export const SPACE_KIND_VALUES = [
  'CINEMA_SCREEN',
  'SEATED_HALL',
  'ARENA',
  'STANDING',
] as const satisfies readonly SpaceKind[];

export interface SpaceKindOption {
  kind: SpaceKind;
  /** What a person calls it. */
  label: string;
  /** One plain sentence: what it is, with examples. */
  sentence: string;
  /** Does it sell numbered seats? A standing space never has a seat map. */
  seated: boolean;
}

export const SPACE_KINDS: SpaceKindOption[] = [
  {
    kind: 'CINEMA_SCREEN',
    label: 'Cinema screen',
    sentence: 'A screen in a cinema or multiplex. Rows of seats facing the screen.',
    seated: true,
  },
  {
    kind: 'SEATED_HALL',
    label: 'Hall or theatre',
    sentence: 'Rows of seats facing a stage. An auditorium, theatre, hall or classroom.',
    seated: true,
  },
  {
    kind: 'ARENA',
    label: 'Arena or stadium',
    sentence: 'Blocks of seats around a court, pitch or stage.',
    seated: true,
  },
  {
    kind: 'STANDING',
    label: 'Standing or open floor',
    sentence: 'No seat numbers. People stand or sit anywhere. You sell a number of places.',
    seated: false,
  },
];

/**
 * The kind to act on for a space.
 *
 * A space written before the kind was stored has none. One that belongs to a cinema is a
 * cinema screen - nothing else can be - so that much is known. Anything else stays null,
 * meaning "not said yet", and is offered every template exactly as before.
 */
export function effectiveSpaceKind(space: {
  kind?: SpaceKind | null;
  cinemaId?: string | null;
}): SpaceKind | null {
  if (space.kind) return space.kind;
  return space.cinemaId ? 'CINEMA_SCREEN' : null;
}

export function spaceKindOption(kind: SpaceKind | null | undefined): SpaceKindOption | null {
  return SPACE_KINDS.find((k) => k.kind === kind) ?? null;
}

/**
 * The layout templates that fit a kind of space.
 *
 * A cinema screen gets the two cinema grids; a hall gets halls and theatres; an arena gets
 * the block venues. A standing space gets none, because it has no seat map. A space whose
 * kind was never said gets them all, which is what every space was offered before.
 */
const TEMPLATES_BY_KIND: Record<SpaceKind, VenueTemplateKey[]> = {
  CINEMA_SCREEN: ['CINEMA', 'PREMIUM_CINEMA'],
  SEATED_HALL: ['AUDITORIUM', 'FLAT_HALL', 'PROSCENIUM'],
  ARENA: ['BASKETBALL', 'ARENA', 'STADIUM', 'IN_THE_ROUND', 'AMPHITHEATRE'],
  STANDING: [],
};

export function templatesForSpaceKind(
  kind: SpaceKind | null | undefined,
): VenueTemplateKey[] | null {
  return kind ? TEMPLATES_BY_KIND[kind] : null;
}
