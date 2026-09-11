/**
 * The pure half of event images: what a file IS, where each public copy lives, and which one is
 * the cover.
 *
 * Kept free of Nest so the card builders (browse, recommendations, organizer profile) can
 * name an image's URL without pulling the upload service into their module.
 */

/** After the browser has resized it. A poster at 1600px as JPEG is a few hundred KB. */
export const EVENT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How many images one event may hold.
 *
 * Enough for a poster, the venue, the performers and a few from last year; few enough that an
 * event page stays a page and the database is not quietly turned into a photo library.
 */
export const EVENT_IMAGE_MAX_COUNT = 10;

export type EventImageType = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * The image type from the file's own first bytes, or null for anything else.
 *
 * ── WHY NOT THE UPLOAD'S CONTENT TYPE ──────────────────────────────────────────────
 * That header is whatever the client says. A file claiming `image/png` can be HTML or SVG,
 * and this endpoint serves what it stores to every buyer's browser. Only three raster formats
 * are recognised by signature; SVG is refused outright, because an SVG is a document that can
 * carry script.
 */
export function sniffImageType(bytes: Uint8Array): EventImageType | null {
  const at = (i: number) => bytes[i];
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...Array.from(bytes.subarray(from, to)));
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => at(i) === b)) return 'image/png';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function eventImageVersion(sha256: string): string {
  return sha256.slice(0, 16);
}

/**
 * One image's public path, relative to the API base.
 *
 * Versioned by a prefix of the bytes' hash, so the URL can be cached forever and a replaced
 * image is a new URL rather than a stale cache. A path rather than a URL because the API
 * cannot know which host each client reaches it on.
 */
export function eventImagePath(eventId: string, imageId: string, sha256: string): string {
  return `/public/events/${eventId}/images/${imageId}?v=${eventImageVersion(sha256)}`;
}

/**
 * The one order every reader uses: the organizer's arrangement, then upload order.
 *
 * The first image is the COVER — the card on browse, the top of the event page. Tie-breakers
 * keep it stable for images that share a position (every image uploaded before ordering
 * existed is position 0), so the cover never flips between two page loads.
 */
export function eventImageOrder() {
  return [{ position: 'asc' as const }, { createdAt: 'asc' as const }, { id: 'asc' as const }];
}

export interface EventImageRow {
  id: string;
  sha256: string;
}

export interface EventImageView {
  id: string;
  path: string;
}

/*
  Both helpers accept a missing list as "no images". A query that did not select the relation —
  a fixture, or a caller added later that forgets to — then shows the placeholder instead of
  crashing the listing it is part of.
*/

/** Rows already in `eventImageOrder`, as what a client needs to show them. */
export function eventImagesView(eventId: string, rows?: EventImageRow[] | null): EventImageView[] {
  return (rows ?? []).map((row) => ({
    id: row.id,
    path: eventImagePath(eventId, row.id, row.sha256),
  }));
}

/** The cover's path — the first row in `eventImageOrder` — or null when there are none. */
export function coverImagePath(eventId: string, rows?: EventImageRow[] | null): string | null {
  const cover = rows?.[0];
  return cover ? eventImagePath(eventId, cover.id, cover.sha256) : null;
}
