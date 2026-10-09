import sharp from 'sharp';
import { CENTRE_FOCAL_POINT } from '@eticketsgo/shared-types';
import { EVENT_IMAGE_MAX_BYTES } from './event-image';
import {
  EVENT_IMAGE_MAX_PIXELS,
  EventImageRejected,
  renderEventImage,
  type RenderedEventImage,
} from './event-image-processing';

/**
 * What an organizer's upload becomes. Every picture here is made in memory by the same library
 * the API uses, in the shapes organizers actually upload: a phone poster, a designer's wide
 * banner, a square logo, a tiny icon, a camera photo stored sideways - and files that are not
 * pictures at all.
 */

type Rgb = [number, number, number];
const RED: Rgb = [220, 30, 30];
const GREEN: Rgb = [30, 200, 30];
const BLUE: Rgb = [30, 30, 220];

function solid(width: number, height: number, [r, g, b]: Rgb = [90, 90, 90]) {
  return sharp({ create: { width, height, channels: 3, background: { r, g, b } } });
}

/** Coloured bands across the width, so a crop's position can be read off its pixels. */
async function bands(width: number, height: number, colours: Rgb[]): Promise<Buffer> {
  const band = Math.ceil(width / colours.length);
  const composite = await Promise.all(
    colours.map(async (colour, i) => ({
      input: await solid(Math.min(band, width - i * band), height, colour)
        .png()
        .toBuffer(),
      left: i * band,
      top: 0,
    })),
  );
  return solid(width, height).composite(composite).png().toBuffer();
}

async function pixelAt(bytes: Buffer, fx: number, fy: number): Promise<Rgb> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const x = Math.min(info.width - 1, Math.floor(fx * info.width));
  const y = Math.min(info.height - 1, Math.floor(fy * info.height));
  const at = (y * info.width + x) * info.channels;
  return [data[at], data[at + 1], data[at + 2]];
}

/** Lossy encoding moves colours a little; this says which of the three a pixel is. */
function nearest(pixel: Rgb): 'red' | 'green' | 'blue' {
  const named = { red: RED, green: GREEN, blue: BLUE } as const;
  const distance = (c: Rgb) => c.reduce((sum, v, i) => sum + (v - pixel[i]) ** 2, 0);
  return (Object.keys(named) as (keyof typeof named)[]).reduce((best, name) =>
    distance(named[name]) < distance(named[best]) ? name : best,
  );
}

function sizes(rendered: RenderedEventImage) {
  return Object.fromEntries(
    rendered.variants.map((v) => [v.name, `${v.width}x${v.height}`]),
  ) as Record<string, string>;
}

async function rejection(input: Buffer): Promise<string> {
  try {
    await renderEventImage(input, CENTRE_FOCAL_POINT);
  } catch (err) {
    if (err instanceof EventImageRejected) return err.reason;
    throw err;
  }
  throw new Error('expected the upload to be refused');
}

describe('renderEventImage: the copies, by shape', () => {
  it('cuts a phone poster (1080x1920) to every shape without stretching it', async () => {
    const poster = await solid(1080, 1920).jpeg().toBuffer();
    const rendered = await renderEventImage(poster, CENTRE_FOCAL_POINT);
    expect({ width: rendered.width, height: rendered.height }).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(sizes(rendered)).toEqual({
      thumb: '400x400',
      'card-sm': '400x300',
      card: '800x600',
      'banner-sm': '800x450',
      // 1080 is all the width there is: the banner is not blown up to 1600.
      banner: '1080x608',
      full: '1080x1920',
    });
  });

  it('cuts a wide banner (3000x1000), bounding the whole picture at 2400', async () => {
    const wide = await solid(3000, 1000).jpeg().toBuffer();
    expect(sizes(await renderEventImage(wide, CENTRE_FOCAL_POINT))).toEqual({
      thumb: '400x400',
      'card-sm': '400x300',
      card: '800x600',
      'banner-sm': '800x450',
      banner: '1600x900',
      full: '2400x800',
    });
  });

  it('cuts a square logo', async () => {
    const square = await solid(1000, 1000).png().toBuffer();
    expect(sizes(await renderEventImage(square, CENTRE_FOCAL_POINT))).toEqual({
      thumb: '400x400',
      'card-sm': '400x300',
      card: '800x600',
      'banner-sm': '800x450',
      banner: '1000x563',
      full: '1000x1000',
    });
  });

  it('never makes a tiny (40x40) picture any larger than it is', async () => {
    const tiny = await solid(40, 40).png().toBuffer();
    const rendered = await renderEventImage(tiny, CENTRE_FOCAL_POINT);
    expect(sizes(rendered)).toEqual({
      thumb: '40x40',
      'card-sm': '40x30',
      card: '40x30',
      'banner-sm': '40x23',
      banner: '40x23',
      full: '40x40',
    });
    for (const variant of rendered.variants) {
      expect(variant.width).toBeLessThanOrEqual(40);
      expect(variant.height).toBeLessThanOrEqual(40);
    }
  });

  it('makes every copy a WebP that says what it is, with its own hash', async () => {
    const rendered = await renderEventImage(
      await solid(1200, 800).jpeg().toBuffer(),
      CENTRE_FOCAL_POINT,
    );
    for (const variant of rendered.variants) {
      expect(variant.contentType).toBe('image/webp');
      expect((await sharp(variant.bytes).metadata()).format).toBe('webp');
      // The size recorded is the size of the bytes, not the size asked for.
      const meta = await sharp(variant.bytes).metadata();
      expect(`${meta.width}x${meta.height}`).toBe(`${variant.width}x${variant.height}`);
      expect(variant.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('renderEventImage: upright and private', () => {
  /*
    A phone holds a portrait photo as a landscape grid of pixels plus a note - EXIF orientation 6,
    "turn me 90 degrees clockwise". Stored here: 200 wide, 100 high, red on the left and blue on
    the right. Upright it is 100 wide, 200 high, red at the TOP.
  */
  async function sidewaysPhoto() {
    return sharp(await bands(200, 100, [RED, BLUE]))
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
  }

  it('turns a sideways phone photo upright in every copy', async () => {
    const input = await sidewaysPhoto();
    expect((await sharp(input).metadata()).orientation).toBe(6);
    const rendered = await renderEventImage(input, CENTRE_FOCAL_POINT);
    expect({ width: rendered.width, height: rendered.height }).toEqual({ width: 100, height: 200 });
    const full = rendered.variants.find((v) => v.name === 'full')!;
    expect(`${full.width}x${full.height}`).toBe('100x200');
    expect(nearest(await pixelAt(full.bytes, 0.5, 0.1))).toBe('red');
    expect(nearest(await pixelAt(full.bytes, 0.5, 0.9))).toBe('blue');
  });

  it('keeps none of the camera metadata, so no copy says where a photo was taken', async () => {
    const input = await sharp(await solid(300, 200).jpeg().toBuffer())
      .withExif({ IFD0: { Copyright: 'Somebody', Artist: 'A phone' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const rendered = await renderEventImage(input, CENTRE_FOCAL_POINT);
    for (const variant of rendered.variants) {
      const meta = await sharp(variant.bytes).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
    }
  });
});

describe('renderEventImage: the focal point', () => {
  // Red, green and blue thirds across a wide picture; a 4:3 card can show only one of them.
  let wide: Buffer;
  beforeAll(async () => {
    wide = await bands(3000, 1000, [RED, GREEN, BLUE]);
  });

  const cardCentre = async (x: number) => {
    const rendered = await renderEventImage(wide, { x, y: 0.5 });
    const card = rendered.variants.find((v) => v.name === 'card')!;
    return nearest(await pixelAt(card.bytes, 0.5, 0.5));
  };

  it('crops around the middle when no point is set', async () => {
    expect(await cardCentre(0.5)).toBe('green');
  });

  it('crops around the point the organizer chose, at either edge', async () => {
    expect(await cardCentre(0.1)).toBe('red');
    expect(await cardCentre(0.9)).toBe('blue');
  });

  it('leaves the whole picture alone: the focal point only moves crops', async () => {
    const left = await renderEventImage(wide, { x: 0, y: 0.5 });
    const right = await renderEventImage(wide, { x: 1, y: 0.5 });
    const full = (r: RenderedEventImage) => r.variants.find((v) => v.name === 'full')!.sha256;
    expect(full(left)).toBe(full(right));
    const card = (r: RenderedEventImage) => r.variants.find((v) => v.name === 'card')!.sha256;
    expect(card(left)).not.toBe(card(right));
  });
});

describe('renderEventImage: what it refuses', () => {
  it('refuses a picture with too many pixels before decoding it, however small the file', async () => {
    // 6000x4500 is 27 megapixels: one flat colour, so the FILE is tiny.
    const huge = await solid(6000, 4500).jpeg({ quality: 40 }).toBuffer();
    expect(6000 * 4500).toBeGreaterThan(EVENT_IMAGE_MAX_PIXELS);
    expect(huge.length).toBeLessThan(EVENT_IMAGE_MAX_BYTES);
    expect(await rejection(huge)).toBe('too-many-pixels');
  });

  it('refuses a text file renamed .jpg', async () => {
    expect(await rejection(Buffer.from('this is a shopping list, not a photo\n'))).toBe(
      'unreadable',
    );
  });

  it('refuses a file that starts like a JPEG and is not one', async () => {
    const forged = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.from('JFIF'),
      Buffer.alloc(4000, 0x41),
    ]);
    expect(await rejection(forged)).toBe('unreadable');
  });

  it('refuses a JPEG cut off half way, rather than storing a picture with a grey half', async () => {
    const photo = await sharp(await bands(600, 400, [RED, GREEN, BLUE]))
      .jpeg()
      .toBuffer();
    expect(await rejection(photo.subarray(0, Math.floor(photo.length / 2)))).toBe('unreadable');
  });

  it('refuses an SVG, which a decoder could read but which can carry script', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    expect(await rejection(svg)).toBe('unreadable');
  });
});
