import { z } from 'zod';

/**
 * An event's picture, as the public event endpoints describe it.
 *
 * ── WHY THE APP SHOWED NONE ────────────────────────────────────────────────────────
 * The API has sent `imagePath` and `imageVariants` on every event card and event page since
 * organizers could upload a picture. The app's schemas did not name them, and Zod drops keys a
 * schema does not name, so the fields were thrown away on arrival and every card drew the
 * category glyph.
 *
 * ── WHY OPTIONAL, AND WHY A BAD VALUE IS NULL ──────────────────────────────────────
 * A phone can be talking to an older API that sends neither field, and an event with no
 * upload sends null for both. Neither is an error. A value of the wrong shape is not worth an
 * error either: a picture is decoration, and failing the parse would blank the whole shelf the
 * event is on. So anything unreadable becomes "no picture" and the glyph is shown instead.
 */

/**
 * The copies the API cuts, by name. Only the ones the app shows are named; a copy added to the
 * API later is ignored here rather than refused.
 */
const variantsSchema = z.object({
  thumb: z.string().optional(),
  'card-sm': z.string().optional(),
  card: z.string().optional(),
  'banner-sm': z.string().optional(),
  banner: z.string().optional(),
});

/** Spread into an event schema to keep its picture. */
export const eventImageFields = {
  /** The original upload's path. The API serves it as a web-ready copy. */
  imagePath: z.string().min(1).nullable().optional().catch(null),
  /** Paths of the copies cut to fixed shapes, or null when there is no picture. */
  imageVariants: variantsSchema.nullable().optional().catch(null),
};

export type EventImageVariants = z.infer<typeof variantsSchema>;

export interface EventImageSource {
  imagePath?: string | null;
  imageVariants?: EventImageVariants | null;
}

/** Where a picture is shown, and so which copy it needs. */
export type EventImageUse = 'card' | 'banner' | 'thumb';

/**
 * Width over height of the box each use draws into: the shape the API cuts that copy to.
 * Matching it means `cover` crops nothing more than the organizer chose to keep.
 */
export const EVENT_IMAGE_ASPECT: Record<EventImageUse, number> = {
  card: 4 / 3,
  banner: 16 / 9,
  thumb: 1,
};

/*
  The larger copy of each pair. A card is about 260 points wide and a banner the whole screen,
  which on a phone at 3x is 780 and 1170 pixels: the small copies (400 and 800) would be soft.
*/
const PREFERENCE: Record<EventImageUse, readonly (keyof EventImageVariants)[]> = {
  card: ['card', 'card-sm'],
  banner: ['banner', 'banner-sm'],
  thumb: ['thumb', 'card-sm'],
};

/**
 * The URL to load for one use of an event's picture, or null to show the fallback.
 *
 * The copy cut for that use when there is one. Otherwise the original upload: an event with a
 * picture uploaded before the copies existed still has one to show, and `cover` crops it into
 * the same box.
 *
 * The API sends PATHS, because it cannot know which host a client reaches it on, so this joins
 * them to the API base the app was built with.
 */
export function eventImageUrl(
  event: EventImageSource,
  use: EventImageUse,
  apiUrl: string,
): string | null {
  const variants = event.imageVariants ?? null;
  const path =
    PREFERENCE[use].map((name) => variants?.[name]).find((p): p is string => Boolean(p)) ??
    event.imagePath ??
    null;
  if (!path) return null;
  // Already absolute: nothing to join. Not what the API sends today, but harmless to allow.
  if (/^https?:\/\//i.test(path)) return path;
  return `${apiUrl.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
}
