/**
 * The web-ready copies of an event image, and where each one is cut from the original.
 *
 * ── WHY THIS LIVES HERE AND NOT IN THE API ─────────────────────────────────────────
 * The API cuts the copies; the organizer console draws a preview of the same cut BEFORE the
 * organizer has saved anything, from the picture already in the browser. If the two did the
 * arithmetic separately, the preview would be a promise the storefront does not keep. One
 * function, used by both, means the preview is the crop.
 *
 * ── WHY FIXED SHAPES ───────────────────────────────────────────────────────────────
 * Organizers upload whatever they have: a portrait poster from a phone, a wide banner from a
 * designer, a square logo. A card that takes the picture's own shape makes every row of the
 * browse grid a different height, and one that letterboxes it shows grey bars. Each place a
 * buyer sees an image has one shape, the API cuts a copy in that shape, and the organizer
 * chooses which part of the picture the cut keeps.
 */

export type EventImageVariantName = 'thumb' | 'card-sm' | 'card' | 'banner-sm' | 'banner' | 'full';

export interface EventImageVariantSpec {
  name: EventImageVariantName;
  /** The widest this copy is ever made. A smaller original gives a smaller copy, never a stretched one. */
  maxWidth: number;
  /**
   * Width over height of the cut, or null for the whole picture.
   *
   * The whole picture (`full`) is bounded by `maxWidth` on its LONGEST edge, so a tall poster
   * is not made enormous by a width limit that only makes sense for a wide one.
   */
  aspect: number | null;
}

/*
  Two sizes of the card and the banner so a browser can pick by the space and the screen
  (`srcset`): a card is about 360px wide on a phone and on a desktop grid alike, which is 400
  pixels on an ordinary screen and 800 on a sharp one. The banner spans the page, so it goes to
  1600. The original is never served to a buyer; `full` is the whole picture, upright and
  without the camera's metadata, for the places where every part of it matters.
*/
export const EVENT_IMAGE_VARIANTS: readonly EventImageVariantSpec[] = [
  { name: 'thumb', maxWidth: 400, aspect: 1 },
  { name: 'card-sm', maxWidth: 400, aspect: 4 / 3 },
  { name: 'card', maxWidth: 800, aspect: 4 / 3 },
  { name: 'banner-sm', maxWidth: 800, aspect: 16 / 9 },
  { name: 'banner', maxWidth: 1600, aspect: 16 / 9 },
  { name: 'full', maxWidth: 2400, aspect: null },
];

export const EVENT_IMAGE_VARIANT_NAMES = EVENT_IMAGE_VARIANTS.map((v) => v.name);

export function isEventImageVariantName(value: string): value is EventImageVariantName {
  return (EVENT_IMAGE_VARIANT_NAMES as string[]).includes(value);
}

/** The shapes a buyer sees, as a client asks for them: each is one or two sizes of one cut. */
export const EVENT_IMAGE_USES = {
  card: ['card-sm', 'card'],
  banner: ['banner-sm', 'banner'],
  thumb: ['thumb'],
  full: ['full'],
} as const satisfies Record<string, readonly EventImageVariantName[]>;

export type EventImageUse = keyof typeof EVENT_IMAGE_USES;

/** Card 4:3, banner 16:9, thumbnail square - for a box that must match the copy it shows. */
export const EVENT_IMAGE_ASPECT = { card: 4 / 3, banner: 16 / 9, thumb: 1 } as const;

/**
 * The part of the picture a crop keeps in view, as fractions of its width and height.
 *
 * (0.5, 0.5) is the middle, which is also what an image with no point set uses. Fractions
 * rather than pixels so the point survives a resize and means the same on every copy.
 */
export interface FocalPoint {
  x: number;
  y: number;
}

export const CENTRE_FOCAL_POINT: FocalPoint = Object.freeze({ x: 0.5, y: 0.5 });

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * A focal point from what a row or a request holds, made safe to crop with.
 *
 * Missing or not a number means the middle. Anything else is held to 0..1 and rounded to three
 * places: a thousandth of the picture is finer than any click, and a stored value that is
 * always rounded the same way makes the URL version derived from it stable.
 */
export function normaliseFocalPoint(
  x: number | null | undefined,
  y: number | null | undefined,
): FocalPoint {
  const one = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.round(clamp01(value) * 1000) / 1000
      : 0.5;
  return { x: one(x), y: one(y) };
}

export interface CropRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The largest region of the given shape that fits the picture, centred on the focal point as
 * far as the edges allow.
 *
 * "As far as the edges allow": a point near the left edge cannot be in the middle of a crop
 * without the crop running off the picture, so the crop stops at the edge instead and the
 * point sits left of centre. It is never cut off, which is the promise that matters.
 */
export function focalCrop(
  width: number,
  height: number,
  aspect: number,
  focal: FocalPoint = CENTRE_FOCAL_POINT,
): CropRegion {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  let cropWidth: number;
  let cropHeight: number;
  if (w / h > aspect) {
    cropHeight = h;
    cropWidth = Math.min(w, Math.max(1, Math.round(h * aspect)));
  } else {
    cropWidth = w;
    cropHeight = Math.min(h, Math.max(1, Math.round(w / aspect)));
  }
  const place = (size: number, crop: number, at: number) =>
    Math.min(size - crop, Math.max(0, Math.round(clamp01(at) * size - crop / 2)));
  return {
    left: place(w, cropWidth, focal.x),
    top: place(h, cropHeight, focal.y),
    width: cropWidth,
    height: cropHeight,
  };
}

/**
 * The CSS `object-position` that shows exactly `focalCrop`'s region in a box of that shape.
 *
 * `object-position: p%` lines up the point p% across the picture with the point p% across the
 * box, which is not "centred on" anything. So the crop is worked out first and then turned into
 * that percentage: the preview a browser draws with `object-fit: cover` is then the copy the
 * API cuts, pixel for pixel.
 */
export function focalObjectPosition(
  width: number,
  height: number,
  aspect: number,
  focal: FocalPoint = CENTRE_FOCAL_POINT,
): string {
  const crop = focalCrop(width, height, aspect, focal);
  const percent = (offset: number, size: number, cropSize: number) =>
    size > cropSize ? Math.round((offset / (size - cropSize)) * 10000) / 100 : 50;
  return `${percent(crop.left, width, crop.width)}% ${percent(crop.top, height, crop.height)}%`;
}

/**
 * The size a copy comes out at: the spec's limit, or the source's own size if that is smaller.
 *
 * Never larger than what it is cut from. A 40px logo blown up to 800px is not a sharper image,
 * only a heavier one, and the browser stretches it just as well for free.
 */
export function variantOutputSize(
  spec: EventImageVariantSpec,
  source: { width: number; height: number },
): { width: number; height: number } {
  if (spec.aspect === null) {
    const scale = Math.min(1, spec.maxWidth / Math.max(source.width, source.height));
    return {
      width: Math.max(1, Math.round(source.width * scale)),
      height: Math.max(1, Math.round(source.height * scale)),
    };
  }
  const crop = focalCrop(source.width, source.height, spec.aspect);
  const width = Math.min(spec.maxWidth, crop.width);
  return {
    width,
    height: Math.max(1, Math.min(crop.height, Math.round(width / spec.aspect))),
  };
}
