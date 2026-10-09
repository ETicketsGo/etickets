import { describe, expect, it } from 'vitest';
import { apiAssetUrl } from './api';
import { eventImageSource } from './event-image';

const variants = {
  thumb: '/public/events/e/images/i/thumb?v=1',
  'card-sm': '/public/events/e/images/i/card-sm?v=1',
  card: '/public/events/e/images/i/card?v=1',
  'banner-sm': '/public/events/e/images/i/banner-sm?v=1',
  banner: '/public/events/e/images/i/banner?v=1',
  full: '/public/events/e/images/i/full?v=1',
};

describe('eventImageSource', () => {
  it('offers both sizes of a card, so the browser downloads only what the screen needs', () => {
    expect(eventImageSource({ variants, path: '/orig' }, 'card')).toEqual({
      src: apiAssetUrl(variants.card),
      srcSet: `${apiAssetUrl(variants['card-sm'])} 400w, ${apiAssetUrl(variants.card)} 800w`,
    });
    expect(eventImageSource({ variants }, 'banner')?.srcSet).toBe(
      `${apiAssetUrl(variants['banner-sm'])} 800w, ${apiAssetUrl(variants.banner)} 1600w`,
    );
  });

  it('names one copy where there is only one size', () => {
    expect(eventImageSource({ variants }, 'full')).toEqual({ src: apiAssetUrl(variants.full) });
  });

  it('falls back to the original for a saved card or an API from before the copies', () => {
    expect(eventImageSource({ path: '/orig' }, 'card')).toEqual({ src: apiAssetUrl('/orig') });
    expect(eventImageSource({ variants: null, path: '/orig' }, 'banner')).toEqual({
      src: apiAssetUrl('/orig'),
    });
  });

  it('is null when there is no image, so the caller draws its own artwork', () => {
    expect(eventImageSource(null, 'card')).toBeNull();
    expect(eventImageSource({ path: null, variants: null }, 'card')).toBeNull();
  });
});
