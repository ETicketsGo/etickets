import {
  EVENT_IMAGE_USES,
  EVENT_IMAGE_VARIANTS,
  type EventImageUse,
  type EventImageVariantName,
} from '@eticketsgo/shared-types';
import { apiAssetUrl } from './api';

export {
  CENTRE_FOCAL_POINT,
  EVENT_IMAGE_ASPECT,
  focalObjectPosition,
  normaliseFocalPoint,
  type EventImageUse,
  type EventImageVariantName,
  type FocalPoint,
} from '@eticketsgo/shared-types';

/** The copies of one image the API names, as paths for `apiAssetUrl`. */
export type EventImageVariants = Partial<Record<EventImageVariantName, string>>;

export interface EventImageSource {
  src: string;
  /** Present when there is more than one size to choose from. */
  srcSet?: string;
}

/**
 * What an `<img>` should load to show an event image in one place: a card, a banner, a
 * thumbnail or the whole picture.
 *
 * The API cuts each copy to the shape of the place it is shown, so a box of that shape with
 * `object-fit: cover` shows the copy whole - no stretching, no grey bars, and the crop is the
 * one the organizer chose. Two sizes where there are two, so the browser downloads 400 pixels
 * for a card on an ordinary screen and 800 on a sharp one.
 *
 * Falls back to the original (`path`) for a response or a saved card from before the copies
 * existed, and returns null when there is no image at all, which is the caller's cue to draw
 * its own artwork.
 */
export function eventImageSource(
  image: { variants?: EventImageVariants | null; path?: string | null } | null | undefined,
  use: EventImageUse,
): EventImageSource | null {
  if (!image) return null;
  const names = EVENT_IMAGE_USES[use] as readonly EventImageVariantName[];
  const sized = names
    .map((name) => ({
      url: apiAssetUrl(image.variants?.[name]),
      width: EVENT_IMAGE_VARIANTS.find((spec) => spec.name === name)!.maxWidth,
    }))
    .filter((entry): entry is { url: string; width: number } => Boolean(entry.url));
  if (sized.length === 0) {
    const original = apiAssetUrl(image.path);
    return original ? { src: original } : null;
  }
  const largest = sized[sized.length - 1];
  return sized.length > 1
    ? { src: largest.url, srcSet: sized.map((s) => `${s.url} ${s.width}w`).join(', ') }
    : { src: largest.url };
}

/**
 * A stored poster or picture URL, made to work against the API this app is talking to.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────
 * A film's `posterUrl` must be an absolute URL (the movie schema validates it as one), so a
 * poster uploaded as one of the platform's own event images is saved with whatever API host
 * was current at the time: `http://localhost:4131/api/public/events/...` on a designer's
 * machine, a since-renamed Railway hostname on QA. Every page then asked a host that no longer
 * answers, and every poster fell back to the no-image artwork.
 *
 * The platform's own image route is the same on every host, so a URL that points at it is
 * re-based onto this app's API. Any other URL (a distributor's CDN, a provider's poster) is
 * returned untouched.
 */
export function portableImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return url;
  const at = url.indexOf('/api/public/events/');
  return at >= 0 ? apiAssetUrl(url.slice(at + '/api'.length)) : url;
}
