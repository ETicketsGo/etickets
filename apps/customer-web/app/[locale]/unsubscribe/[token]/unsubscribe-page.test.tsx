// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { DEFAULT_LOCALE, messagesFor } from '@eticketsgo/i18n';

/*
  The page behind an email's unsubscribe link. What must hold: opening it changes nothing
  (mail scanners open every link), it says exactly what will stop, one button stops it, and a
  link that does not verify says so instead of pretending.
*/

vi.mock('next/navigation', () => ({
  usePathname: () => '/unsubscribe/tok',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ token: 'tok' }),
  notFound: vi.fn(),
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
}));

const { default: UnsubscribePage } = await import('./page');
const { Providers } = await import('@/app/providers');

let routes: Record<string, { status: number; body: unknown }> = {};
const calls: { method: string; path: string }[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

beforeEach(() => {
  routes = {};
  calls.length = 0;
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const p = new URL(url).pathname.replace(/^\/api/, '');
      const method = (init.method ?? 'GET').toUpperCase();
      calls.push({ method, path: p });
      const reply = routes[`${method} ${p}`] ?? { status: 404, body: {} };
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }),
  );
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <NextIntlClientProvider locale={DEFAULT_LOCALE} messages={messagesFor(DEFAULT_LOCALE)}>
        <Providers>
          <UnsubscribePage />
        </Providers>
      </NextIntlClientProvider>,
    );
  });
  await flush();
  await flush();
}

const preview = {
  scope: 'organizer',
  purposes: ['ORGANIZER_UPDATES', 'EARLY_ACCESS', 'OFFERS'],
  organization: { id: 'org-1', name: 'Lotus Hall' },
  emailMask: 'as***@example.test',
};

describe('the unsubscribe page', () => {
  it('says what will stop, and opening it unsubscribes nobody', async () => {
    routes['GET /public/unsubscribe/tok'] = { status: 200, body: preview };
    await mount();
    const what = host!.querySelector('[data-testid="unsubscribe-what"]')!.textContent!;
    expect(what).toContain('Lotus Hall');
    expect(what).toContain('as***@example.test');
    expect(host!.textContent).toContain('You still get your tickets');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('unsubscribes with one click and confirms it, with the way back', async () => {
    routes['GET /public/unsubscribe/tok'] = { status: 200, body: preview };
    routes['POST /public/unsubscribe/tok'] = {
      status: 200,
      body: { ...preview, unsubscribed: true },
    };
    await mount();
    const confirm = [...host!.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Unsubscribe',
    )!;
    await act(async () => confirm.click());
    await flush();
    expect(
      calls.filter((c) => c.method === 'POST' && c.path === '/public/unsubscribe/tok'),
    ).toHaveLength(1);
    expect(host!.querySelector('[data-testid="unsubscribe-done"]')).not.toBeNull();
    expect(host!.textContent).toContain('Changed your mind?');
    expect(host!.querySelector('a[href*="/account/notification-settings"]')).not.toBeNull();
  });

  it('says plainly when the link does not verify', async () => {
    routes['GET /public/unsubscribe/tok'] = {
      status: 400,
      body: { code: 'VALIDATION_FAILED', message: 'This unsubscribe link is not valid.' },
    };
    await mount();
    expect(host!.querySelector('[data-testid="unsubscribe-invalid"]')).not.toBeNull();
    expect(host!.querySelector('button')).toBeNull();
  });
});
