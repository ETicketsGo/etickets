import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './components';
import { titleCase } from './format';

/**
 * StatusBadge's optional `label`.
 *
 * Found on QA: French storefront pages showed the enum spelled out in English — "PENDING
 * PAYMENT" on the confirmation, "REFUNDED" in the bookings list — because the badge could only
 * render `titleCase(status)`. The label is optional so the English-only organizer and admin
 * consoles keep rendering exactly what they did.
 */
describe('StatusBadge', () => {
  it('spells out the status when no label is given, as before', () => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { status: 'PENDING_PAYMENT' }));
    expect(html).toContain(titleCase('PENDING_PAYMENT'));
  });

  it('shows the label it is given, with the colour still taken from the status', () => {
    const plain = renderToStaticMarkup(createElement(StatusBadge, { status: 'REFUNDED' }));
    const translated = renderToStaticMarkup(
      createElement(StatusBadge, { status: 'REFUNDED', label: 'Remboursée' }),
    );
    expect(translated).toContain('Remboursée');
    expect(translated).not.toContain(titleCase('REFUNDED'));
    // Identical markup apart from the words: the tone follows the status, never the label.
    expect(translated.replace('Remboursée', '')).toBe(plain.replace(titleCase('REFUNDED'), ''));
  });
});
