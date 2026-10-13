import { describe, expect, it } from 'vitest';
import { figureSize } from './desk-model';

/**
 * A figure steps its type down to fit its cell, so it is never wider than the cell and never cut
 * (the walkthrough found "6,989.18" clipped at 1024 and colliding with the next tile at 320).
 * The browser does the measuring (`cqi` is the cell's width); what is held here is the rule it is
 * given: more characters, a smaller ceiling on the size, and a floor that stops it vanishing.
 */
function divisor(size: string): number {
  const m = /calc\(100cqi \/ ([\d.]+)\)/.exec(size);
  if (!m) throw new Error(`no cqi term in ${size}`);
  return Number(m[1]);
}

describe('figureSize', () => {
  it('asks for more room per extra character', () => {
    expect(divisor(figureSize('148'))).toBeLessThan(divisor(figureSize('6,989.18')));
    expect(divisor(figureSize('6,989.18'))).toBeLessThan(divisor(figureSize('12,34,567.89')));
  });

  it('keeps a floor and the design system ceiling', () => {
    const size = figureSize('6,989.18');
    expect(size).toContain('max(1rem,');
    expect(size).toContain('clamp(1.75rem, 1.53rem + 0.9vw, 2.25rem)');
  });

  it('never divides by nothing for an empty value', () => {
    expect(divisor(figureSize(''))).toBeGreaterThan(0);
  });
});
