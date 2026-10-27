// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { DEFAULT_LOCALE, messagesFor } from '@eticketsgo/i18n';

/*
  The Following page draws each organizer's choices with the same component the Follow
  button's dialog uses. What must hold here: the choices still open from "What you hear",
  show what the server sent, save one key at a time, and report through a toast as before.
*/

vi.mock('next/navigation', () => ({
  usePathname: () => '/account/following',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  notFound: vi.fn(),
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
}));

const { default: FollowingPage } = await import('./page');
const { Providers } = await import('@/app/providers');

let routes: Record<string, { status: number; body: unknown }> = {};
const calls: { method: string; path: string; body: unknown }[] = [];

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

const PREFS = {
  organizationId: 'org-1',
  newEvents: true,
  emailUpdates: false,
  earlyAccess: true,
  offers: false,
  cadence: 'WEEKLY_DIGEST',
};

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  localStorage.setItem('etg_access', 'test-access-token');
  routes = {
    'GET /me/following': {
      status: 200,
      body: {
        items: [
          {
            followedAt: '2026-10-01T00:00:00.000Z',
            organization: {
              id: 'org-1',
              name: 'Lotus Hall',
              logoUrl: null,
              verified: false,
              memberSince: '2025-01-01T00:00:00.000Z',
              eventCount: 2,
            },
            preferences: PREFS,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 50,
      },
    },
    'PUT /me/following/org-1/preferences': { status: 200, body: { ...PREFS, offers: true } },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const p = new URL(url).pathname.replace(/^\/api/, '');
      const method = (init.method ?? 'GET').toUpperCase();
      calls.push({ method, path: p, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const reply = routes[`${method} ${p}`] ?? { status: 200, body: {} };
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
async function until(check: () => boolean, tries = 60) {
  for (let i = 0; i < tries && !check(); i += 1) await flush();
  expect(check()).toBe(true);
}

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <NextIntlClientProvider locale={DEFAULT_LOCALE} messages={messagesFor(DEFAULT_LOCALE)}>
        <Providers>
          <FollowingPage />
        </Providers>
      </NextIntlClientProvider>,
    );
  });
  await flush();
}

const switchNamed = (name: string) =>
  host!.querySelector<HTMLInputElement>(`input[role="switch"][aria-label="${name}"]`)!;

describe('Following page', () => {
  it('opens the shared choices from "What you hear" and saves one key, with a toast', async () => {
    await mount();
    const toggle = () =>
      [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        (b.textContent ?? '').includes('What you hear'),
      );
    await until(() => toggle() !== undefined);
    expect(host!.querySelector('[data-testid="follow-preferences"]')).toBeNull();

    await act(async () => toggle()!.click());
    await until(() => host!.querySelector('[data-testid="follow-preferences"]') !== null);
    expect(switchNamed('New events in my account').checked).toBe(true);
    expect(switchNamed('Early access by email').checked).toBe(true);
    expect(switchNamed('Offers by email').checked).toBe(false);
    const weekly = host!.querySelector<HTMLInputElement>('input[value="WEEKLY_DIGEST"]')!;
    expect(weekly.checked).toBe(true);
    expect(host!.textContent).toContain('Following does not turn on email');
    // The page reports through toasts, not the dialog's inline line.
    expect(host!.querySelector('[data-testid="follow-preferences-status"]')).toBeNull();

    await act(async () => switchNamed('Offers by email').click());
    await until(() => (document.body.textContent ?? '').includes('Saved.'));
    const puts = calls.filter(
      (c) => c.method === 'PUT' && c.path === '/me/following/org-1/preferences',
    );
    expect(puts.map((c) => c.body)).toEqual([{ offers: true }]);
    expect(switchNamed('Offers by email').checked).toBe(true);
  });
});
