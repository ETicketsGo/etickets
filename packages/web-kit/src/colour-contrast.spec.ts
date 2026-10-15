import { describe, expect, it } from 'vitest';
import { contrastRatio, readableTextOn } from './colour-contrast';

describe('readableTextOn', () => {
  it('meets WCAG AA (4.5:1) on every colour an organizer can pick', () => {
    let worst = Infinity;
    for (let r = 0; r < 256; r += 15)
      for (let g = 0; g < 256; g += 15)
        for (let b = 0; b < 256; b += 15) {
          const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
          worst = Math.min(worst, contrastRatio(hex, readableTextOn(hex)));
        }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it('puts white on the template colours that are dark, black on the light ones', () => {
    expect(readableTextOn('#DC2626')).toBe('#FFFFFF');
    expect(readableTextOn('#7C3AED')).toBe('#FFFFFF');
    expect(readableTextOn('#FDE68A')).toBe('#000000');
  });
});
