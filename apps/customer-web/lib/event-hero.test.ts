import { describe, expect, it } from 'vitest';
import { heroState } from './event-hero';

const a = { full: 'a' };
const b = { full: 'b' };
const c = { full: 'c' };

describe('heroState', () => {
  it('shows the chosen image while everything loads', () => {
    expect(heroState([a, b, c], [], 1)).toEqual({
      usable: [a, b, c],
      index: 1,
      image: b,
      mode: 'image',
    });
  });

  it('drops a failed image from the hero, the thumbnails and the viewer', () => {
    const state = heroState([a, b, c], ['b'], 0);
    expect(state.usable).toEqual([a, c]);
    expect(state.image).toBe(a);
  });

  it('moves to an image that loaded when the one showing fails', () => {
    // The buyer was on the last image; it failed, so the hero settles on the last one left.
    const state = heroState([a, b, c], ['c'], 2);
    expect(state.index).toBe(1);
    expect(state.image).toBe(b);
    expect(state.mode).toBe('image');
  });

  it('keeps the image-shaped box, as a placeholder, when every image failed', () => {
    expect(heroState([a, b], ['a', 'b'], 0)).toEqual({
      usable: [],
      index: 0,
      image: null,
      mode: 'placeholder',
    });
  });

  it('uses the plain no-image banner only for an event that never had an image', () => {
    expect(heroState([], [], 0).mode).toBe('none');
  });
});
