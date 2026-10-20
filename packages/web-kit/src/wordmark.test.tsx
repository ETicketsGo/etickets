import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Wordmark, WordmarkMonogram } from './wordmark';

/*
  Owner, 2026-10-19: one ETicketsGo wordmark with the gold dot on every surface - storefront,
  organizer and admin consoles, sign-in pages, emails and printed tickets. These pin the mark
  itself and that each surface draws THIS mark rather than a copy of it.
*/
const SRC = __dirname;
const APPS = join(SRC, '..', '..', '..', 'apps');
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('Wordmark', () => {
  it('reads "ETicketsGo" and hides the dot from assistive technology', () => {
    const html = renderToStaticMarkup(<Wordmark />);
    expect(html).toContain('>ETicketsGo<');
    expect(html).toMatch(/<svg aria-hidden="true"[^>]*><circle/);
    expect(html).toContain('font-brand-display');
    expect(html).toContain('font-extrabold');
  });

  it('draws the dot in etg-gold on paper and etg-gold-on-ink on ink', () => {
    expect(renderToStaticMarkup(<Wordmark tone="light" />)).toContain('fill-etg-gold"');
    expect(renderToStaticMarkup(<Wordmark tone="light" />)).toContain('text-etg-ink');
    const dark = renderToStaticMarkup(<Wordmark tone="dark" />);
    expect(dark).toContain('fill-etg-gold-on-ink');
    expect(dark).toContain('text-etg-on-ink');
    const auto = renderToStaticMarkup(<Wordmark tone="auto" />);
    expect(auto).toContain('dark:fill-etg-gold-on-ink');
  });

  it('has three sizes and sets a product label beside the name, in small capitals', () => {
    const sizes = (['sm', 'md', 'lg'] as const).map((size) =>
      renderToStaticMarkup(<Wordmark size={size} />),
    );
    expect(new Set(sizes).size).toBe(3);
    const html = renderToStaticMarkup(<Wordmark product="Organizer" />);
    expect(html).toContain('>Organizer<');
    expect(html).toContain('uppercase');
    // The name and the label are read as "ETicketsGo Organizer", not "ETicketsGoOrganizer".
    expect(html).toContain('<span class="sr-only"> </span>');
  });

  it('folds to the E and its gold full stop for a collapsed rail, like the favicons', () => {
    const named = renderToStaticMarkup(<WordmarkMonogram />);
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="ETicketsGo"');
    expect(named).toMatch(/>E<svg[^>]*fill-etg-gold/);
    const quiet = renderToStaticMarkup(<WordmarkMonogram label={null} />);
    expect(quiet).toContain('aria-hidden="true"');
    expect(quiet).not.toContain('role="img"');
  });
});

describe('every surface draws the one wordmark', () => {
  it('the console shell uses it in the top bar, the sidebar (both widths) and the drawer', () => {
    const shell = code(join(SRC, 'shell.tsx'));
    expect(shell.match(/<Wordmark /g)).toHaveLength(3);
    expect(shell).toContain('<WordmarkMonogram');
    expect(shell).not.toMatch(/LogoMark|renderMark|DeskWordmark/);
  });

  it('the old gradient logo and the storefront copy of the wordmark are gone', () => {
    expect(existsSync(join(SRC, 'logo.tsx'))).toBe(false);
    expect(existsSync(join(APPS, 'customer-web', 'components', 'wordmark.tsx'))).toBe(false);
    expect(existsSync(join(APPS, 'customer-web', 'public', 'logo-mark.svg'))).toBe(false);
    const admin = code(join(APPS, 'admin-web', 'components', 'admin-shell.tsx'));
    expect(admin).not.toMatch(/icon\.svg|renderMark/);
  });

  it('the sign-in form, the printed ticket and the storefront chrome use it', () => {
    expect(code(join(SRC, 'login.tsx'))).toContain('<Wordmark ');
    expect(code(join(SRC, 'printable-tickets.tsx'))).toContain('<Wordmark ');
    for (const file of [
      'components/header.tsx',
      'components/marketing/header.tsx',
      'components/site-footer.tsx',
      'components/marketing/footer.tsx',
    ]) {
      const src = code(join(APPS, 'customer-web', file));
      expect(src, file).toMatch(/import \{[^}]*\bWordmark\b[^}]*\} from '@eticketsgo\/web-kit'/);
      expect(src, file).toContain('<Wordmark ');
    }
    for (const app of ['organizer-web', 'admin-web']) {
      expect(code(join(APPS, app, 'app', 'not-found.tsx')), app).toContain('<Wordmark ');
    }
  });
});
