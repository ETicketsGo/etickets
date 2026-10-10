import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SellingPill, StatusPill, sellingLabel, sellingWord } from './primitives';

/**
 * A selling restriction must never be hidden.
 *
 * Found on QA: "Partly selling: Telangana prici..." - the pill truncated with an ellipsis, so
 * the reason, the half an organizer needs, was the half that was cut. These pin the fix: every
 * word is in the markup, nothing in the pill carries `truncate` (an ellipsis) or `whitespace-
 * nowrap` (which is what made one line overflow), and the dense layout still prints the reason
 * as visible text rather than moving it into a hover title.
 */
const REASON =
  'Telangana pricing rules are not set for 3 of 5 shows, and 2 ticket categories are closed';

function render(el: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(el);
}

describe('StatusPill', () => {
  it('wraps its words instead of truncating them', () => {
    const html = render(
      createElement(StatusPill, { tone: 'warning', children: `Partly selling: ${REASON}` }),
    );
    expect(html).toContain(`Partly selling: ${REASON}`);
    expect(html).not.toContain('truncate');
    expect(html).not.toContain('whitespace-nowrap');
    expect(html).not.toContain('text-overflow');
    expect(html).toContain('whitespace-normal');
    expect(html).toContain('max-w-full');
  });
});

describe('SellingPill', () => {
  it('prints a long reason in full in the pill', () => {
    const html = render(createElement(SellingPill, { state: 'partly', reason: REASON }));
    expect(html).toContain(sellingLabel({ state: 'partly', reason: REASON }));
    expect(html).not.toContain('truncate');
    // Not hidden behind a hover: no title carries the words the pill does not show.
    expect(html).not.toContain('title=');
  });

  it('stacked: the state word is the pill and the reason is visible text under it', () => {
    const html = render(
      createElement(SellingPill, { state: 'not', reason: REASON, size: 'sm', layout: 'stacked' }),
    );
    expect(html).toContain(`>${sellingWord('not')}<`);
    expect(html).toContain(REASON);
    // Read as one sentence: "Not selling: <reason>".
    expect(html).toContain('<span class="sr-only">: </span>');
    expect(html).not.toContain('truncate');
    expect(html).not.toContain('title=');
  });

  it('stacked "Selling" is just the pill - there is no reason to print', () => {
    const html = render(createElement(SellingPill, { state: 'selling', layout: 'stacked' }));
    expect(html).toContain('>Selling<');
    expect(html).not.toContain('sr-only');
  });

  it('never says bare "Selling" for a partial state', () => {
    expect(sellingLabel({ state: 'partly', reason: 'x' })).toBe('Partly selling: x');
    expect(sellingWord('partly')).toBe('Partly selling');
  });
});
