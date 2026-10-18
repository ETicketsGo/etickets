// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { DEFAULT_LOCALE, messagesFor } from '@eticketsgo/i18n';
import { Providers } from '@/app/providers';
import { SiteChrome } from '@/components/site-chrome';

/*
  ── ONE DESIGN, TWO NAVIGATIONS (N1) ───────────────────────────────────────────────────────
  PR #427 put the ticket shop's header on every marketing route, so a visitor reading Features
  lost the platform links, and a signed-in customer on Features was still offered "Sign in" in
  the footer. The owner: "Do not force the marketing navigation onto authenticated customer
  pages. Do not force customer navigation onto public marketing pages."

  This mounts the real shell for a route in a DOM, with or without a session token in storage
  (what the browser has after sign-in), lets it settle, and reads the header and footer it drew.
*/

let path = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => path,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  notFound: vi.fn(),
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // No network in a unit test: the account menu's "who am I" and the bell's count never answer.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  localStorage.clear();
  document.cookie = 'etg_session=; Max-Age=0; Path=/';
});

function tree(signedIn: boolean) {
  return (
    <NextIntlClientProvider locale={DEFAULT_LOCALE} messages={messagesFor(DEFAULT_LOCALE)}>
      <Providers>
        <SiteChrome initialSignedIn={signedIn}>
          <p>x</p>
        </SiteChrome>
      </Providers>
    </NextIntlClientProvider>
  );
}

/** Mount the shell as the browser would, signed in or not, and wait for it to settle. */
async function mount(route: string, signedIn: boolean) {
  path = route;
  if (signedIn) localStorage.setItem('etg_access', 'test-access-token');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(tree(signedIn));
  });
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  const header = host.querySelector('header') as HTMLElement;
  const footer = host.querySelector('footer') as HTMLElement;
  return { host, header, footer };
}

/** The visible text of every link and button in an element, in order. */
function labels(el: Element): string[] {
  return [...el.querySelectorAll('a, button')]
    .map((n) => (n.textContent ?? '').trim())
    .filter(Boolean);
}

const MARKETING_LINKS = ['Features', 'Solutions', 'Pricing', 'For organizers', 'For attendees'];
const APP_LINKS = ['Explore', 'Movies', 'Tickets'];
const LEGAL_LINE = '© 2026 ETicketsGo, DeepTrics Software Solutions Pvt Ltd | All rights reserved.';

describe('the marketing header', () => {
  it.each(['/features', '/pricing', '/organizers', '/legal', '/docs/api'])(
    '%s signed out: the platform links, Sign in and Get started',
    async (route) => {
      const { header } = await mount(route, false);
      expect(header.dataset.nav).toBe('marketing');
      const seen = labels(header);
      for (const link of MARKETING_LINKS) expect(seen).toContain(link);
      expect(seen).toContain('Sign in');
      expect(seen).toContain('Get started');
      const signIn = [...header.querySelectorAll('a')].find((a) => a.textContent === 'Sign in');
      expect(signIn?.getAttribute('href')).toMatch(/^\/login\?next=/);
      // None of the shop's navigation.
      for (const link of APP_LINKS) expect(seen).not.toContain(link);
      expect(header.querySelector('input[type="search"]')).toBeNull();
    },
  );

  it.each(['/features', '/pricing', '/organizers'])(
    '%s signed in: Go to app and the account menu, never Sign in',
    async (route) => {
      const { header } = await mount(route, true);
      const seen = labels(header);
      for (const link of MARKETING_LINKS) expect(seen).toContain(link);
      expect(seen).toContain('Go to app');
      expect(seen).not.toContain('Sign in');
      expect(seen).not.toContain('Get started');
      expect(header.querySelector('[aria-haspopup="menu"]')).not.toBeNull();
    },
  );

  it('signed in with no session hint: no Sign in is ever drawn, not even before mount', () => {
    // The server's render for a hint-less session is a placeholder, never "Sign in".
    path = '/features';
    const html = renderToStaticMarkup(tree(false));
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(header).toContain('data-auth="pending"');
    expect(header).not.toContain('>Sign in<');
  });

  it('has no bottom bar or city bar under it; the home page keeps its bottom bar', async () => {
    const bottomBar = 'nav[aria-label="Primary"]';
    const features = await mount('/features', false);
    expect(features.host.querySelector(bottomBar)).toBeNull();
    expect(features.host.querySelectorAll('header')).toHaveLength(1);
    cleanup?.();
    const home = await mount('/', false);
    expect(home.host.querySelector(bottomBar)).not.toBeNull();
  });
});

describe('the app header', () => {
  it.each([
    ['/', false],
    ['/', true],
    ['/explore', true],
    ['/movies', true],
    ['/account/tickets', true],
    ['/account/profile', true],
    ['/events', false],
  ] as const)('%s (signed in: %s) never carries the marketing links', async (route, signedIn) => {
    const { header } = await mount(route, signedIn);
    expect(header.dataset.nav).not.toBe('marketing');
    const seen = labels(header);
    for (const link of APP_LINKS) expect(seen).toContain(link);
    for (const link of MARKETING_LINKS) expect(seen).not.toContain(link);
    expect(seen).not.toContain('Get started');
    if (signedIn) expect(seen).not.toContain('Sign in');
    else expect(seen).toContain('Sign in');
  });
});

describe('the marketing footer', () => {
  it('offers Sign in to a visitor', async () => {
    const { footer } = await mount('/features', false);
    expect(labels(footer)).toContain('Sign in');
    expect(footer.textContent).toContain(LEGAL_LINE);
  });

  it('offers My tickets instead of Sign in to a signed-in customer', async () => {
    const { footer } = await mount('/features', true);
    const seen = labels(footer);
    expect(seen).not.toContain('Sign in');
    expect(seen).toContain('My tickets');
    expect(footer.querySelector('a[href="/account/tickets"]')).not.toBeNull();
    // The legal line is untouched.
    expect(footer.textContent).toContain(LEGAL_LINE);
  });
});
