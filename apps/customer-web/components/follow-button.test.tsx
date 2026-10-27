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
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const switchNamed = (name: string) =>
  dialog()!.querySelector<HTMLInputElement>(`input[role="switch"][aria-label="${name}"]`)!;
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/*
  Waits by the clock, not by a count of ticks: closing the dialog runs its exit animation,
  which takes real time and took longer than 60 zero-delay ticks on CI. Up to 3 seconds.
*/
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) {
    await act(async () => new Promise((r) => setTimeout(r, 10)));
  }
  expect(check()).toBe(true);
}
// The button is disabled until its first status read answers. Wait for it to be ready.
const ready = () => until(() => !button().disabled);

/** The server defaults: the in-account notice on, every email off. */
const DEFAULT_PREFS = {
  organizationId: 'org-1',
  newEvents: true,
  emailUpdates: false,
  earlyAccess: false,
  offers: false,
  cadence: 'INSTANT',
};

function notFollowingYet() {
  routes['GET /me/following/org-1'] = {
    status: 200,
    body: { organizationId: 'org-1', following: false },
  };
  routes['PUT /me/following/org-1'] = {
    status: 200,
    body: { organizationId: 'org-1', following: true, created: true },
  };
  routes['GET /me/following/org-1/preferences'] = { status: 200, body: DEFAULT_PREFS };
}

function alreadyFollowing() {
  routes['GET /me/following/org-1'] = {
    status: 200,
    body: { organizationId: 'org-1', following: true },
  };
  routes['GET /me/following/org-1/preferences'] = { status: 200, body: DEFAULT_PREFS };
  routes['DELETE /me/following/org-1'] = {
    status: 200,
    body: { organizationId: 'org-1', following: false },
  };
}

const prefPuts = () =>
  calls.filter((c) => c.method === 'PUT' && c.path === '/me/following/org-1/preferences');

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
    // A follow that failed opens nothing and claims nothing.
    expect(dialog()).toBeNull();
    expect(document.body.textContent).not.toContain('You are following');
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

  it('back from sign-in with ?follow=: the dialog opens once the follow saved', async () => {
    window.history.replaceState(null, '', '/organizers/org-1?follow=org-1');
    notFollowingYet();
    await mount(true);
    await until(() => dialog() !== null);
    expect(dialog()!.getAttribute('aria-label')).toBe('You are following Lotus Hall');
    await until(() => byTestId('follow-preferences') !== null);
    const puts = calls.filter((c) => c.method === 'PUT' && c.path === '/me/following/org-1');
    expect(puts).toHaveLength(1);
  });

  it('a new follow opens the dialog with the name and the choices, every email off', async () => {
    notFollowingYet();
    await mount(true);
    await ready();
    expect(dialog()).toBeNull();
    await act(async () => button().click());
    await until(() => dialog() !== null);
    const d = dialog()!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.getAttribute('aria-label')).toBe('You are following Lotus Hall');
    expect(d.getAttribute('aria-describedby')).toBeTruthy();
    expect(d.textContent).toContain('You are following Lotus Hall');
    // A bottom sheet on a phone.
    expect(d.getAttribute('data-sheet')).toBe('mobile');
    await until(() => byTestId('follow-preferences') !== null);
    const read = calls.filter(
      (c) => c.method === 'GET' && c.path === '/me/following/org-1/preferences',
    );
    expect(read.length).toBeGreaterThan(0);
    expect(switchNamed('New events in my account').checked).toBe(true);
    expect(switchNamed('Email me about new events').checked).toBe(false);
    expect(switchNamed('Early access by email').checked).toBe(false);
    expect(switchNamed('Offers by email').checked).toBe(false);
    expect(d.textContent).toContain('Following does not turn on email');
    // No unfollow in the "you just followed" view, and nothing was saved on opening.
    expect(byTestId('follow-dialog-unfollow')).toBeNull();
    expect(prefPuts()).toEqual([]);
  });

  it('a switch saves only its own key, and says Saved only after the API agrees', async () => {
    notFollowingYet();
    let release!: () => void;
    routes['PUT /me/following/org-1/preferences'] = {
      status: 200,
      body: { ...DEFAULT_PREFS, offers: true },
      wait: new Promise<void>((r) => (release = r)),
    };
    await mount(true);
    await ready();
    await act(async () => button().click());
    await until(() => byTestId('follow-preferences') !== null);

    await act(async () => switchNamed('Offers by email').click());
    await flush();
    expect(prefPuts().map((c) => c.body)).toEqual([{ offers: true }]);
    // Optimistic, disabled while saving, and not "Saved" yet.
    expect(switchNamed('Offers by email').checked).toBe(true);
    expect(switchNamed('Email me about new events').disabled).toBe(true);
    expect(byTestId('follow-preferences-status')!.textContent).toBe('');

    await act(async () => release());
    await until(() => byTestId('follow-preferences-status')!.textContent === 'Saved.');
    expect(switchNamed('Offers by email').checked).toBe(true);
    expect(switchNamed('Email me about new events').disabled).toBe(false);
  });

  it('a refused switch moves back and says so, with no Saved', async () => {
    notFollowingYet();
    routes['PUT /me/following/org-1/preferences'] = {
      status: 500,
      body: { code: 'INTERNAL', message: 'nope' },
    };
    await mount(true);
    await ready();
    await act(async () => button().click());
    await until(() => byTestId('follow-preferences') !== null);

    await act(async () => switchNamed('Email me about new events').click());
    await until(() => byTestId('follow-preferences-status')!.textContent !== '');
    expect(prefPuts().map((c) => c.body)).toEqual([{ emailUpdates: true }]);
    expect(switchNamed('Email me about new events').checked).toBe(false);
    expect(byTestId('follow-preferences-status')!.textContent).toBe(
      'We could not save that. Please try again.',
    );
    expect(document.body.textContent).not.toContain('Saved.');
  });

  it('says so in the dialog when the choices cannot load', async () => {
    notFollowingYet();
    routes['GET /me/following/org-1/preferences'] = {
      status: 500,
      body: { code: 'INTERNAL', message: 'nope' },
    };
    await mount(true);
    await ready();
    await act(async () => button().click());
    await until(() => (dialog()?.textContent ?? '').includes('We could not load your choices'));
    expect(byTestId('follow-preferences')).toBeNull();
  });

  it('pressing Following opens Manage and does NOT unfollow; Unfollow does, once', async () => {
    alreadyFollowing();
    await mount(true);
    await ready();
    expect(button().textContent).toContain('Following');
    expect(button().getAttribute('aria-haspopup')).toBe('dialog');

    await act(async () => button().click());
    await until(() => dialog() !== null);
    expect(dialog()!.getAttribute('aria-label')).toBe('Notifications from Lotus Hall');
    await until(() => byTestId('follow-preferences') !== null);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(button().textContent).toContain('Following');

    const unfollow = byTestId('follow-dialog-unfollow') as HTMLButtonElement;
    expect(unfollow.textContent).toContain('Unfollow Lotus Hall');
    await act(async () => unfollow.click());
    await until(() => dialog() === null);
    const deletes = calls.filter((c) => c.method === 'DELETE' && c.path === '/me/following/org-1');
    expect(deletes).toHaveLength(1);
    expect(button().textContent).toContain('Follow');
    expect(button().textContent).not.toContain('Following');
    expect(document.body.textContent).toContain('You no longer follow Lotus Hall.');
  });

  it('closing Manage with Done keeps the follow', async () => {
    alreadyFollowing();
    await mount(true);
    await ready();
    await act(async () => button().click());
    await until(() => dialog() !== null);
    await act(async () => (byTestId('follow-dialog-done') as HTMLButtonElement).click());
    await until(() => dialog() === null);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(button().textContent).toContain('Following');
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
