import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OrganizerLegalFooter } from './organizer-legal-footer';

/*
  The console footer names the DeepTrics company an organizer deals with, from the
  organization's registered country: business data, the same signal the campaign footer and
  the invoice series use. One line, the brand once and the company once (owner, 2026-11-05).
  Loading, or a country with no company: the neutral copyright line.
*/
const year = new Date().getFullYear();
const text = (country: string | null) =>
  renderToStaticMarkup(<OrganizerLegalFooter country={country} />).replace(/<[^>]+>/g, '');

describe('OrganizerLegalFooter', () => {
  it('an organizer registered in India: the Indian company, named once', () => {
    expect(text('IN')).toBe(
      `© ${year} ETicketsGo. Operated by DeepTrics Software Solutions Pvt Ltd.`,
    );
  });

  it('an organizer registered in the United States (stored as a name): DeepTrics LLC, named once', () => {
    const t = text('United States');
    expect(t).toBe(`© ${year} ETicketsGo. Operated by DeepTrics LLC.`);
    // The old line said the platform and the company twice each.
    expect(t.match(/ETicketsGo/g)).toHaveLength(1);
    expect(t.match(/DeepTrics/g)).toHaveLength(1);
  });

  it('while loading, or for a country with no company, names neither', () => {
    for (const c of [null, 'CA']) {
      expect(text(c)).toBe(`© ${year} ETicketsGo. All rights reserved.`);
    }
  });

  it('is drawn on every console page, from the active organization', () => {
    const layout = readFileSync(join(__dirname, '..', 'app', 'organizer', 'layout.tsx'), 'utf8');
    expect(layout).toContain('<OrganizerLegalFooter country={workspace.registeredCountry} />');
  });
});
