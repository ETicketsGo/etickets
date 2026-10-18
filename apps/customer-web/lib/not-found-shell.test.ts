import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundInShell } from '@/components/not-found-shell';

/*
  ── THE 404 IS A STOREFRONT PAGE ───────────────────────────────────────────────────────
  A wrong address drew a bare page in the old system with no header and no footer, so the legal
  line naming the operator (under STPL/MSG91 review) was missing on exactly the page a stranger
  following a dead link lands on. This renders the tree the root 404 renders and checks the
  shell is really around it - not that a file mentions a footer.

  Next's router is not running here, so the hooks the shell reads are given a path.
*/
vi.mock('next/navigation', () => ({
  usePathname: () => '/walk-no-such-page',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  notFound: vi.fn(),
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
}));

const LEGAL_LINE = '© 2026 ETicketsGo, DeepTrics Software Solutions Pvt Ltd | All rights reserved.';

function render(): string {
  return renderToStaticMarkup(createElement(NotFoundInShell));
}

describe('the 404 inside the storefront shell', () => {
  it('has the footer with the exact legal line', () => {
    const html = render();
    expect(html).toContain('<footer');
    // The ampersand-free line, as the footer prints it (React escapes nothing in it).
    expect(html).toContain(LEGAL_LINE);
  });

  it('has the storefront header and the main landmark the skip link points at', () => {
    const html = render();
    expect(html).toContain('<header');
    expect(html).toMatch(/<main[^>]*id="main"/);
  });

  it('is on the brand layer, says what happened, and offers search and home', () => {
    const html = render();
    const page = html.slice(html.indexOf('data-not-found'));
    expect(page).toContain('We cannot find this page');
    expect(page).toMatch(/type="search"/);
    expect(page).toMatch(/href="\/"/);
    expect(page).toMatch(/href="\/events"/);
    expect(html).toMatch(/<div data-brand="customer"[^>]*bg-brand-canvas/);
    // None of the old system on the page itself.
    expect(page).not.toMatch(/action-primary|text-text-|bg-background-/);
  });
});
