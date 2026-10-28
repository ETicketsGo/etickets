import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OrganizerLegalFooter } from './organizer-legal-footer';

/*
  The console footer names the DeepTrics company an organizer deals with, from the
  organization's registered country: business data, the same signal the campaign footer and
  the invoice series use. Loading, or a country with no company: both are named.
*/
const year = new Date().getFullYear();
const text = (country: string | null) =>
  renderToStaticMarkup(<OrganizerLegalFooter country={country} />).replace(/<[^>]+>/g, '');

describe('OrganizerLegalFooter', () => {
  it('an organizer registered in India: the Indian company', () => {
    const t = text('IN');
    expect(t).toContain(`© ${year} ETicketsGo, DeepTrics Software Solutions Pvt Ltd.`);
    expect(t).toContain(
      'ETicketsGo is operated in India by DeepTrics Software Solutions Private Limited.',
    );
    expect(t).not.toContain('DeepTrics LLC');
  });

  it('an organizer registered in the United States (stored as a name): DeepTrics LLC', () => {
    const t = text('United States');
    expect(t).toContain(`© ${year} ETicketsGo, DeepTrics LLC.`);
    expect(t).toContain('ETicketsGo is operated in the United States by DeepTrics LLC.');
    expect(t).not.toContain('Private Limited');
  });

  it('while loading, or for a country with no company, names both', () => {
    for (const c of [null, 'CA']) {
      const t = text(c);
      expect(t).toContain(`© ${year} ETicketsGo.`);
      expect(t).toContain(
        'ETicketsGo is operated in India by DeepTrics Software Solutions Private Limited and in the United States by DeepTrics LLC.',
      );
    }
  });

  it('is drawn on every console page, from the active organization', () => {
    const layout = readFileSync(join(__dirname, '..', 'app', 'organizer', 'layout.tsx'), 'utf8');
    expect(layout).toContain('<OrganizerLegalFooter country={workspace.registeredCountry} />');
  });
});
