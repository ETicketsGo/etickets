import { describe, expect, it } from 'vitest';
import {
  EVENT_IMAGE_VARIANTS,
  focalCrop,
  focalObjectPosition,
  normaliseFocalPoint,
  variantOutputSize,
} from './event-images';

/**
 * The crop arithmetic the API cuts with and the organizer console previews with. If these
 * disagree, the console shows the organizer one picture and the storefront shows buyers another.
 */
describe('focalCrop', () => {
  it('takes the full height of a wide picture for a narrower shape, centred by default', () => {
    expect(focalCrop(3000, 1000, 4 / 3)).toEqual({
      left: 834,
      top: 0,
      width: 1333,
      height: 1000,
    });
  });

  it('takes the full width of a tall picture, and follows the focal point down', () => {
    const top = focalCrop(1080, 1920, 16 / 9, { x: 0.5, y: 0 });
    const bottom = focalCrop(1080, 1920, 16 / 9, { x: 0.5, y: 1 });
    expect(top).toEqual({ left: 0, top: 0, width: 1080, height: 608 });
    expect(bottom).toEqual({ left: 0, top: 1312, width: 1080, height: 608 });
  });

  it('centres on the point when it can, and stops at the edge when it cannot', () => {
    // A 3000x1000 picture, a 1333-wide crop: half of it is 666.5 either side of the point.
    expect(focalCrop(3000, 1000, 4 / 3, { x: 0.5, y: 0.5 }).left).toBe(834);
    expect(focalCrop(3000, 1000, 4 / 3, { x: 0.4, y: 0.5 }).left).toBe(534);
    expect(focalCrop(3000, 1000, 4 / 3, { x: 0.05, y: 0.5 }).left).toBe(0);
    expect(focalCrop(3000, 1000, 4 / 3, { x: 0.99, y: 0.5 }).left).toBe(3000 - 1333);
  });

  it('keeps the focal point inside the crop wherever it is', () => {
    for (const [w, h] of [
      [3000, 1000],
      [1080, 1920],
      [500, 500],
      [40, 40],
    ]) {
      for (const aspect of [1, 4 / 3, 16 / 9]) {
        for (const x of [0, 0.1, 0.33, 0.5, 0.77, 1]) {
          for (const y of [0, 0.2, 0.5, 0.9, 1]) {
            const crop = focalCrop(w, h, aspect, { x, y });
            expect(crop.left).toBeGreaterThanOrEqual(0);
            expect(crop.top).toBeGreaterThanOrEqual(0);
            expect(crop.left + crop.width).toBeLessThanOrEqual(w);
            expect(crop.top + crop.height).toBeLessThanOrEqual(h);
            expect(x * w).toBeGreaterThanOrEqual(crop.left - 1);
            expect(x * w).toBeLessThanOrEqual(crop.left + crop.width + 1);
            expect(y * h).toBeGreaterThanOrEqual(crop.top - 1);
            expect(y * h).toBeLessThanOrEqual(crop.top + crop.height + 1);
          }
        }
      }
    }
  });
});

describe('focalObjectPosition', () => {
  it('turns the crop into the CSS position that shows the same region', () => {
    // Left edge, middle, right edge of the 1667px of slack in a 3000x1000 picture.
    expect(focalObjectPosition(3000, 1000, 4 / 3, { x: 0, y: 0.5 })).toBe('0% 50%');
    expect(focalObjectPosition(3000, 1000, 4 / 3, { x: 1, y: 0.5 })).toBe('100% 50%');
    expect(focalObjectPosition(3000, 1000, 4 / 3, { x: 0.5, y: 0.5 })).toBe('50.03% 50%');
    // A picture already in the box's shape has nothing to position.
    expect(focalObjectPosition(800, 600, 4 / 3, { x: 0.1, y: 0.9 })).toBe('50% 50%');
  });
});

describe('normaliseFocalPoint', () => {
  it('means the middle when nothing is set, and holds anything else to the picture', () => {
    expect(normaliseFocalPoint(null, undefined)).toEqual({ x: 0.5, y: 0.5 });
    expect(normaliseFocalPoint(Number.NaN, 2)).toEqual({ x: 0.5, y: 1 });
    expect(normaliseFocalPoint(-1, 0.12345)).toEqual({ x: 0, y: 0.123 });
  });
});

describe('variantOutputSize', () => {
  const spec = (name: string) => EVENT_IMAGE_VARIANTS.find((v) => v.name === name)!;

  it('makes each copy its shape at its size, from a large original', () => {
    const big = { width: 3000, height: 2000 };
    expect(variantOutputSize(spec('card'), big)).toEqual({ width: 800, height: 600 });
    expect(variantOutputSize(spec('banner'), big)).toEqual({ width: 1600, height: 900 });
    expect(variantOutputSize(spec('thumb'), big)).toEqual({ width: 400, height: 400 });
    expect(variantOutputSize(spec('full'), big)).toEqual({ width: 2400, height: 1600 });
  });

  it('never makes a copy larger than the picture it is cut from', () => {
    const tiny = { width: 40, height: 40 };
    expect(variantOutputSize(spec('card'), tiny)).toEqual({ width: 40, height: 30 });
    expect(variantOutputSize(spec('banner'), tiny)).toEqual({ width: 40, height: 23 });
    expect(variantOutputSize(spec('full'), tiny)).toEqual({ width: 40, height: 40 });
  });

  it('bounds the whole picture by its longest edge, so a tall poster is not made huge', () => {
    expect(variantOutputSize(spec('full'), { width: 2000, height: 6000 })).toEqual({
      width: 800,
      height: 2400,
    });
  });
});
