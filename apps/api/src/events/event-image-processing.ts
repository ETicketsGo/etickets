import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  EVENT_IMAGE_VARIANTS,
  focalCrop,
  variantOutputSize,
  type EventImageVariantName,
  type FocalPoint,
} from '@eticketsgo/shared-types';

/**
 * Turning an organizer's upload into the copies buyers are shown.
 *
 * ── WHAT IS CHECKED, AND WHY HERE ──────────────────────────────────────────────────
 * `sniffImageType` reads the first few bytes, which says what a file CLAIMS to be. A file can
 * start like a JPEG and be anything after that. This decodes it, which is the only way to
 * know it is a picture at all, and refuses anything the decoder cannot read cleanly.
 *
 * The pixel count is checked from the header BEFORE anything is decoded. A 2 MB PNG of a single
 * colour can describe a 30,000 x 30,000 picture that needs 3.6 GB to hold in memory: the file
 * size limit says nothing about that, and one such upload would take the API down.
 *
 * ── WHAT EVERY COPY IS ─────────────────────────────────────────────────────────────
 * Upright (a phone stores a portrait photo sideways with a note saying so, and not every
 * client reads the note), in sRGB, as WebP, and without the camera's metadata, which can say
 * where and when the photo was taken. Never larger than the original.
 */

/**
 * The most pixels an upload may describe.
 *
 * 25 million is a 6000 x 4000 photo from a good camera, well past anything a card or a banner
 * shows. Decoded it is about 100 MB, which a single API instance can afford for one upload; a
 * limit far above that is an invitation rather than a convenience.
 */
export const EVENT_IMAGE_MAX_PIXELS = 25_000_000;

/** Once the picture is upright: an upload is refused with this, never served half-made. */
export type EventImageRejection = 'unreadable' | 'too-many-pixels';

export class EventImageRejected extends Error {
  constructor(readonly reason: EventImageRejection) {
    super(
      reason === 'too-many-pixels'
        ? 'That image has too many pixels.'
        : 'That file could not be read as an image.',
    );
  }
}

export interface RenderedEventImageVariant {
  name: EventImageVariantName;
  contentType: 'image/webp';
  width: number;
  height: number;
  bytes: Buffer;
  sha256: string;
}

export interface RenderedEventImage {
  /** The upright original's size. */
  width: number;
  height: number;
  variants: RenderedEventImageVariant[];
}

/*
  The decoder's in-memory cache keeps recent operations around for reuse. Every upload here is a
  different picture, so it would only ever hold memory and never save work.
*/
sharp.cache(false);

const READABLE = new Set(['jpeg', 'png', 'webp']);

/**
 * Reads the upload, refuses what is not a usable picture, and cuts every copy.
 *
 * Throws `EventImageRejected` for anything the caller should refuse; any other error is a fault
 * in this code and is left to surface as one.
 */
export async function renderEventImage(
  input: Buffer,
  focal: FocalPoint,
): Promise<RenderedEventImage> {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    throw new EventImageRejected('unreadable');
  }
  if (!metadata.format || !READABLE.has(metadata.format)) {
    throw new EventImageRejected('unreadable');
  }
  if (!metadata.width || !metadata.height) throw new EventImageRejected('unreadable');
  if (metadata.width * metadata.height > EVENT_IMAGE_MAX_PIXELS) {
    throw new EventImageRejected('too-many-pixels');
  }

  /*
    Decoded once, upright and in sRGB, into plain pixels that every copy is then cut from.
    Decoding a JPEG six times over to make six copies would cost six times the work for the
    same pixels.

    `failOn: 'warning'` refuses a file the decoder had to guess at - a truncated download, a
    JPEG cut off half way - rather than storing a picture whose bottom half is grey.
  */
  let pixels: { data: Buffer; info: sharp.OutputInfo };
  try {
    pixels = await sharp(input, { failOn: 'warning', limitInputPixels: EVENT_IMAGE_MAX_PIXELS })
      .rotate()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new EventImageRejected('unreadable');
  }
  const { data, info } = pixels;
  const source = { width: info.width, height: info.height };
  const raw = () =>
    sharp(data, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    });

  const variants: RenderedEventImageVariant[] = [];
  for (const spec of EVENT_IMAGE_VARIANTS) {
    const size = variantOutputSize(spec, source);
    let pipeline = raw();
    if (spec.aspect !== null) {
      pipeline = pipeline
        .extract(focalCrop(source.width, source.height, spec.aspect, focal))
        .resize(size.width, size.height, { fit: 'fill' });
    } else {
      pipeline = pipeline.resize(size.width, size.height, { fit: 'fill' });
    }
    // The whole picture is the one a buyer looks at closely, so it keeps a little more detail.
    const out = await pipeline
      .webp({ quality: spec.aspect === null ? 85 : 80 })
      .toBuffer({ resolveWithObject: true });
    variants.push({
      name: spec.name,
      contentType: 'image/webp',
      width: out.info.width,
      height: out.info.height,
      bytes: out.data,
      sha256: createHash('sha256').update(out.data).digest('hex'),
    });
  }
  return { ...source, variants };
}
