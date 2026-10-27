// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { DEFAULT_LOCALE, messagesFor } from '@eticketsgo/i18n';

/*
  The Follow button is backed by the API now. The old one wrote an id to this browser's
  localStorage and nothing else, so these check the things that fake could never do: the
  follow reaches the server, the label changes at once and changes BACK when the server
  refuses, a signed-out press goes to sign-in carrying the intent, and coming back signed in
  completes it exactly once.
*/

const push = vi.fn();
let path = '/organizers/org-1';
vi.mock('next/navigation', () => ({
  usePathname: () => path,
  useRouter: () => ({ push, replace: push, prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  notFound: vi.fn(),
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
}));

const { FollowButton } = await import('./follow-button');
const { Providers } = await import('@/app/providers');

type Reply = { status: number; body: unknown; wait?: Promise<void> };
let routes: Record<string, Reply> = {};
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

beforeEach(() => {
  routes = {};
  calls.length = 0;
  push.mockReset();
  localStorage.clear();
  path = '/organizers/org-1';
  window.history.replaceState(null, '', '/organizers/org-1');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const p = new URL(url).pathname.replace(/^\/api/, '');
      const method = (init.method ?? 'GET').toUpperCase();
      calls.push({ method, path: p, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const reply = routes[`${method} ${p}`];
      if (!reply) return new Response(JSON.stringify({}), { status: 200 });
      if (reply.wait) await reply.wait;
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

async function mount(signedIn: boolean) {
  if (signedIn) localStorage.setItem('etg_access', 'test-access-token');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <NextIntlClientProvider locale={DEFAULT_LOCALE} messages={messagesFor(DEFAULT_LOCALE)}>
        <Providers>
          <FollowButton organizationId="org-1" organizationName="Lotus Hall" />
        </Providers>
      </NextIntlClientProvider>,
    );
  });
  await flush();
  await flush();
}

const button = () => host!.querySelector<HTMLButtonElement>('[data-testid="follow-button"]')!;

describe('FollowButton', () => {
  it('signed out: sends the person to sign in with the follow intent, and calls no API', async () => {
    await mount(false);
    await act(async () => button().click());
    expect(push).toHaveBeenCalledTimes(1);
    const href = String(push.mock.calls[0][0]);
    expect(href).toMatch(/\/login\?next=/);
    expect(decodeURIComponent(href)).toContain('/organizers/org-1?follow=org-1');
    expect(calls.filter((c) => c.path.startsWith('/me/following'))).toEqual([]);
  });

  it('signed in: follows through the API, and the label changes before the answer', async () => {
    routes['GET /me/following/org-1'] = {
      status: 200,
      body: { organizationId: 'org-1', following: false },
    };
    let release!: () => void;
    routes['PUT /me/following/org-1'] = {
      status: 200,
      body: { organizationId: 'org-1', following: true, created: true },
      wait: new Promise<void>((r) => (release = r)),
    };
    await mount(true);
    // The button is disabled until its first status read answers; clicking before that does
    // nothing (and made this test flaky). Wait for it to be ready.
    for (let i = 0; i < 50 && button().disabled; i += 1) await flush();
    expect(button().disabled).toBe(false);
    expect(button().textContent).toContain('Follow');
    expect(button().textContent).not.toContain('Following');

    await act(async () => button().click());
    await flush();
    // Optimistic: the server has not answered yet.
    expect(button().textContent).toContain('Following');
    const put = calls.find((c) => c.method === 'PUT' && c.path === '/me/following/org-1');
    expect(put?.body).toEqual({ source: 'ORGANIZER_PAGE' });

    await act(async () => release());
    await flush();
    expect(button().textContent).toContain('Following');
    // Nothing is kept in this browser any more.
    expect(localStorage.getItem('etg_following')).toBeNull();
  });

  it('changes back and says so when the server refuses', async () => {
    routes['GET /me/following/org-1'] = {
      status: 200,
      body: { organizationId: 'org-1', following: false },
    };
    routes['PUT /me/following/org-1'] = {
      status: 500,
      body: { code: 'INTERNAL', message: 'nope' },
    };
    await mount(true);
    await act(async () => button().click());
    await flush();
    await flush();
    expect(button().textContent).not.toContain('Following');
    expect(document.body.textContent).toContain('We could not save that');
  });

  it('back from sign-in with ?follow=: completes the follow once and removes the parameter', async () => {
    window.history.replaceState(null, '', '/organizers/org-1?follow=org-1&x=1');
    routes['GET /me/following/org-1'] = {
      status: 200,
      body: { organizationId: 'org-1', following: false },
    };
    routes['PUT /me/following/org-1'] = {
      status: 200,
      body: { organizationId: 'org-1', following: true, created: true },
    };
    await mount(true);
    await flush();
    const puts = calls.filter((c) => c.method === 'PUT' && c.path === '/me/following/org-1');
    expect(puts).toHaveLength(1);
    expect(window.location.search).toBe('?x=1');
  });

  it('does not act on an intent for a different organizer', async () => {
    window.history.replaceState(null, '', '/organizers/org-1?follow=org-2');
    routes['GET /me/following/org-1'] = {
      status: 200,
      body: { organizationId: 'org-1', following: false },
    };
    await mount(true);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
