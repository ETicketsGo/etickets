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
let search = '';
vi.mock('next/navigation', () => ({
  usePathname: () => path,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
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
  search = '';
  localStorage.clear();
  document.cookie = 'etg_session=; Max-Age=0; Path=/';
  document.cookie = 'etg_selected_market=; Max-Age=0; Path=/';
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
/*
  With no market selected the footer names no company in the copyright line and both companies
  in the operator line - true wherever it is read, and never a guess from an IP address.
*/
const LEGAL_LINE = '© 2026 ETicketsGo | All rights reserved.';
const NEUTRAL_OPERATOR =
  'ETicketsGo is operated in India by DeepTrics Software Solutions Private Limited and in the United States by DeepTrics LLC.';

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

describe('the home page header (owner, 2026-10-18: "Combined")', () => {
  it('signed out: the whole shop header AND the platform links, Sign in and Get started', async () => {
    const { host, header } = await mount('/', false);
    expect(header.dataset.nav).not.toBe('marketing');
    const seen = labels(header);
    for (const link of APP_LINKS) expect(seen).toContain(link);
    for (const link of MARKETING_LINKS) expect(seen).toContain(link);
    expect(seen).toContain('Sign in');
    expect(seen).toContain('Get started');
    const getStarted = [...header.querySelectorAll('a')].find(
      (a) => a.textContent === 'Get started',
    );
    expect(getStarted?.getAttribute('href')).toBe('/register?intent=organizer');
    // The buyer keeps search, the city and the bottom bar.
    expect(header.querySelector('input[type="search"]')).not.toBeNull();
    expect(header.querySelector('[aria-label^="Location:"]')).not.toBeNull();
    expect(host.querySelector('nav[aria-label="Primary"]')).not.toBeNull();
    // A phone reaches the platform pages through a menu button.
    expect(header.querySelector('button[aria-controls="shop-platform-menu"]')).not.toBeNull();
  });

  it('signed out, phone menu: the five platform links, Sign in and Get started', async () => {
    const { header } = await mount('/', false);
    const button = header.querySelector(
      'button[aria-controls="shop-platform-menu"]',
    ) as HTMLButtonElement;
    await act(async () => button.click());
    const menu = header.querySelector('#shop-platform-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    const seen = labels(menu);
    for (const link of MARKETING_LINKS) expect(seen).toContain(link);
    expect(seen).toContain('Sign in');
    expect(seen).toContain('Get started');
  });

  it('signed in: the pure shop header, no platform links, no Sign in, no Get started', async () => {
    const { host, header } = await mount('/', true);
    const seen = labels(header);
    for (const link of APP_LINKS) expect(seen).toContain(link);
    for (const link of MARKETING_LINKS) expect(seen).not.toContain(link);
    expect(seen).not.toContain('Sign in');
    expect(seen).not.toContain('Get started');
    expect(header.querySelector('button[aria-controls="shop-platform-menu"]')).toBeNull();
    expect(header.querySelector('input[type="search"]')).not.toBeNull();
    expect(host.querySelector('nav[aria-label="Primary"]')).not.toBeNull();
  });

  it('before the session is known: no platform links and no Sign in, not even on the server', () => {
    path = '/';
    const html = renderToStaticMarkup(tree(false));
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(header).toContain('data-auth="pending"');
    expect(header).not.toContain('>Sign in<');
    expect(header).not.toContain('>Get started<');
    expect(header).not.toContain('>Features<');
  });
});

/*
  ── EVERY SHOP PAGE, SIGNED OUT (owner, 2026-10-19) ───────────────────────────────────────
  "without sign in, when we click on Explore, we are unable to see other options". The combined
  bar is now on every shop page for a visitor, except the purchase steps (the seat page, the
  booking and payment pages, checkout), which keep the plain shop bar with "Sign in".
*/
describe('the shop header for a visitor', () => {
  it.each([
    '/explore',
    '/movies',
    '/events',
    '/events/some-event',
    '/movies/some-film',
    '/organizers/org-1',
  ])(
    '%s signed out: the shop header AND the platform links, Sign in and Get started',
    async (route) => {
      const { host, header } = await mount(route, false);
      expect(header.dataset.nav).not.toBe('marketing');
      const seen = labels(header);
      for (const link of APP_LINKS) expect(seen).toContain(link);
      for (const link of MARKETING_LINKS) expect(seen).toContain(link);
      expect(seen).toContain('Sign in');
      expect(seen).toContain('Get started');
      expect(header.querySelector('[aria-label^="Location:"]')).not.toBeNull();
      expect(host.querySelector('nav[aria-label="Primary"]')).not.toBeNull();
      expect(header.querySelector('button[aria-controls="shop-platform-menu"]')).not.toBeNull();
    },
  );

  it('an event page signed out: the phone menu carries the platform links too', async () => {
    const { header } = await mount('/events/some-event', false);
    const button = header.querySelector(
      'button[aria-controls="shop-platform-menu"]',
    ) as HTMLButtonElement;
    await act(async () => button.click());
    const seen = labels(header.querySelector('#shop-platform-menu') as HTMLElement);
    for (const link of MARKETING_LINKS) expect(seen).toContain(link);
    expect(seen).toContain('Sign in');
    expect(seen).toContain('Get started');
  });

  it.each([
    '/shows/session-1',
    '/booking/b-1',
    '/booking/b-1/payment',
    '/booking/b-1/confirmation',
    '/checkout',
  ])('%s signed out keeps the plain shop header: Sign in, no platform links', async (route) => {
    const { header } = await mount(route, false);
    const seen = labels(header);
    for (const link of APP_LINKS) expect(seen).toContain(link);
    for (const link of MARKETING_LINKS) expect(seen).not.toContain(link);
    expect(seen).toContain('Sign in');
    expect(seen).not.toContain('Get started');
    expect(header.querySelector('button[aria-controls="shop-platform-menu"]')).toBeNull();
  });

  it('signed in on Explore and an event page: the pure shop header', async () => {
    for (const route of ['/explore', '/events/some-event']) {
      const { header } = await mount(route, true);
      const seen = labels(header);
      for (const link of MARKETING_LINKS) expect(seen).not.toContain(link);
      expect(seen).not.toContain('Sign in');
      expect(seen).not.toContain('Get started');
      cleanup?.();
      cleanup = null;
      localStorage.clear();
    }
  });

  it('before the session is known on Explore: no platform links and no Sign in', () => {
    path = '/explore';
    const html = renderToStaticMarkup(tree(false));
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(header).toContain('data-auth="pending"');
    expect(header).not.toContain('>Sign in<');
    expect(header).not.toContain('>Features<');
  });
});

describe('the app header', () => {
  it.each([
    ['/', true],
    ['/explore', true],
    ['/movies', true],
    ['/account/tickets', true],
    ['/account/profile', true],
    ['/shows/session-1', false],
    ['/booking/b-1/payment', false],
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

describe('the storefront footer', () => {
  it('links the shop to the platform pages, since its header does not', async () => {
    const { footer } = await mount('/', false);
    expect(footer.querySelector('a[href="/features"]')).not.toBeNull();
    expect(footer.querySelector('a[href="/organizers"]')).not.toBeNull();
    expect(footer.textContent).toContain(LEGAL_LINE);
    expect(footer.textContent).toContain(NEUTRAL_OPERATOR);
  });
});

/*
  The company follows the market the reader SELECTED: the country of a city they picked, kept
  in storage by the city picker. A guess from the network is never enough to name one.
*/
describe('the footer names the company for the selected market', () => {
  function choose(city: string, region: string, country: string) {
    localStorage.setItem('etg.city', JSON.stringify({ city, region, country }));
  }

  it('India: the Indian company, short form in the copyright and in full in the line', async () => {
    choose('Hyderabad', 'Telangana', 'India');
    const { footer } = await mount('/', false);
    expect(footer.textContent).toContain(
      '© 2026 ETicketsGo, DeepTrics Software Solutions Pvt Ltd | All rights reserved.',
    );
    expect(footer.textContent).toContain(
      'ETicketsGo is operated in India by DeepTrics Software Solutions Private Limited.',
    );
    expect(footer.textContent).not.toContain('DeepTrics LLC');
  });

  it('United States: DeepTrics LLC', async () => {
    choose('Austin', 'Texas', 'United States');
    const { footer } = await mount('/features', false);
    expect(footer.textContent).toContain('© 2026 ETicketsGo, DeepTrics LLC | All rights reserved.');
    expect(footer.textContent).toContain(
      'ETicketsGo is operated in the United States by DeepTrics LLC.',
    );
    expect(footer.textContent).not.toContain('Private Limited');
  });

  it('a market with no company, or "All cities", falls back to both', async () => {
    choose('Toronto', 'Ontario', 'Canada');
    let { footer } = await mount('/', false);
    expect(footer.textContent).toContain(LEGAL_LINE);
    expect(footer.textContent).toContain(NEUTRAL_OPERATOR);
    cleanup?.();
    cleanup = null;
    localStorage.setItem('etg.city', '__all__');
    ({ footer } = await mount('/', false));
    expect(footer.textContent).toContain(NEUTRAL_OPERATOR);
  });

  it('the choice is mirrored for the server-rendered legal pages', async () => {
    choose('Hyderabad', 'Telangana', 'India');
    await mount('/', false);
    expect(document.cookie).toContain('etg_selected_market=IN');
  });
});

/*
  QA certification of main 60eee811: /terms?country=IN showed the Indian company in the page
  body and the neutral line in the footer, because the body resolves the market from
  ?country= and the etg_selected_market cookie while the footer read only the city choice.
  On a legal page the footer now resolves it the same way: ?country=, then the cookie, then
  the city choice, then neither company. Never the network guess (etg_market).
*/
describe('on a legal page the footer follows the market the page body follows', () => {
  const INDIA_OPERATOR_LINE =
    'ETicketsGo is operated in India by DeepTrics Software Solutions Private Limited.';
  const US_OPERATOR_LINE = 'ETicketsGo is operated in the United States by DeepTrics LLC.';

  it.each(['/terms', '/privacy', '/refunds', '/cookies', '/sms'])(
    '%s?country=IN names the Indian company in the footer',
    async (route) => {
      search = 'country=IN';
      const { footer } = await mount(route, false);
      expect(footer.querySelector('[data-testid="footer-operator"]')?.textContent).toBe(
        INDIA_OPERATOR_LINE,
      );
      expect(footer.textContent).toContain(
        '© 2026 ETicketsGo, DeepTrics Software Solutions Pvt Ltd | All rights reserved.',
      );
    },
  );

  it('an explicit ?country= wins over the city the reader chose', async () => {
    localStorage.setItem(
      'etg.city',
      JSON.stringify({ city: 'Austin', region: 'Texas', country: 'United States' }),
    );
    search = 'country=IN';
    const { footer } = await mount('/terms', false);
    expect(footer.textContent).toContain(INDIA_OPERATOR_LINE);
    expect(footer.textContent).not.toContain('DeepTrics LLC');
  });

  it('then the etg_selected_market cookie', async () => {
    document.cookie = 'etg_selected_market=US; Path=/';
    const { footer } = await mount('/privacy', false);
    expect(footer.textContent).toContain(US_OPERATOR_LINE);
  });

  it('never the network guess: etg_market alone leaves the neutral line', async () => {
    document.cookie = 'etg_market=IN; Path=/';
    try {
      const { footer } = await mount('/terms', false);
      expect(footer.textContent).toContain(NEUTRAL_OPERATOR);
    } finally {
      document.cookie = 'etg_market=; Max-Age=0; Path=/';
    }
  });

  it('off the legal pages ?country= changes nothing (the city choice still decides)', async () => {
    search = 'country=IN';
    const { footer } = await mount('/features', false);
    expect(footer.textContent).toContain(NEUTRAL_OPERATOR);
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
