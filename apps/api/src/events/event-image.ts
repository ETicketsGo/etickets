/**
 * The pure half of event images: what a file IS, and where its public copy lives.
 *
 * Kept free of Nest so the card builders (browse, recommendations, organizer profile) can
 * name an image's URL without pulling the upload service into their module.
 */

/** After the browser has resized it. A poster at 1600px as JPEG is a few hundred KB. */
export const EVENT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

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

/**
 * The image's public path, relative to the API base.
 *
 * Versioned by a prefix of the bytes' hash, so the URL can be cached forever and a replaced
 * image is a new URL rather than a stale cache. A path rather than a URL because the API
 * cannot know which host each client reaches it on.
 */
export function eventImagePath(eventId: string, sha256: string): string {
  return `/public/events/${eventId}/image?v=${eventImageVersion(sha256)}`;
}

export function eventImageVersion(sha256: string): string {
  return sha256.slice(0, 16);
}
