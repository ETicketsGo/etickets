import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VenueMap } from './venue-map';
import type { VenueSectionSummary } from './api';

/*
  The venue map must show WHERE each price is. Every block used to be one dark grey, so Premium,
  Standard and VIP areas looked the same and their names were dark on dark. What must hold: each
  block in its category's colour with readable text, availability as a second cue that does not
  replace the colour, a key naming the categories, and the chosen block standing out.
*/
const block = (over: Partial<VenueSectionSummary>): VenueSectionSummary => ({
  id: 'a',
  kind: 'SECTION',
  name: 'Front 1',
  shape: [
    [0, 0],
    [100, 0],
    [100, 100],
  ],
  labelX: 50,
  labelY: 50,
  tier: null,
  rotationDeg: 0,
  availableCount: 50,
  totalCount: 50,
  priceMinorFrom: 7500,
  priceMinorTo: 7500,
  colorHex: '#B45309',
  categoryName: 'Premium',
  ...over,
});

const render = (sections: VenueSectionSummary[], activeSectionId?: string | null) =>
  renderToStaticMarkup(
    <VenueMap
      focal={{ kind: 'STAGE_END', label: 'STAGE', shape: null }}
      sections={sections}
      onSelect={() => undefined}
      formatPrice={(m) => `$${(m / 100).toFixed(2)}`}
      activeSectionId={activeSectionId}
    />,
  );

describe('VenueMap block colours', () => {
  it('fills each block with its category colour and names the categories in the key', () => {
    const html = render([
      block({}),
      block({ id: 'b', name: 'Rear 1', colorHex: '#FDE68A', categoryName: 'Standard' }),
    ]);
    expect(html).toContain('fill="#B45309"');
    expect(html).toContain('fill="#FDE68A"');
    expect(html).toMatch(/Premium[\s\S]*Standard/);
  });

  it('writes white on a dark category colour and black on a light one', () => {
    const html = render([
      block({}),
      block({ id: 'b', name: 'Rear 1', colorHex: '#FDE68A', categoryName: 'Standard' }),
    ]);
    expect(html).toMatch(/fill="#FFFFFF"[^>]*>Front 1</);
    expect(html).toMatch(/fill="#000000"[^>]*>Rear 1</);
  });

  it('keeps the colour of an almost-full block, striped, and says so in words', () => {
    const html = render([block({ availableCount: 2 })]);
    expect(html).toContain('fill="#B45309"');
    expect(html).toMatch(/url\(#[^)]*-few-light\)/);
    expect(html).toContain('Almost full');
  });

  it('greys a sold-out block and says so', () => {
    const html = render([block({ availableCount: 0 })]);
    expect(html).not.toContain('fill="#B45309"');
    expect(html).toContain('Sold out');
  });

  it('makes the chosen block obvious: a thick outline, drawn last, the others stepped back', () => {
    const html = render(
      [block({}), block({ id: 'b', name: 'Rear 1', colorHex: '#0891B2', categoryName: 'Std' })],
      'a',
    );
    // Drawn last, so its outline is on top of its neighbours'.
    expect(html).toMatch(/data-block="Rear 1" data-dimmed="true"[\s\S]*data-block="Front 1"/);
    expect(html).toMatch(/stroke-width="8"[^>]*stroke-text-primary/);
    // Only the fill of the others steps back; their names stay at full strength.
    expect(html).toMatch(/fill-opacity="0.4"/);
    expect(html).not.toMatch(/<g[^>]*opacity=/);
  });
});
