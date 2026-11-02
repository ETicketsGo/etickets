// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequireAuth, SessionHintProvider } from './hooks';

/*
  ── REFRESH FLICKER (2026-11) ─────────────────────────────────────────────────────────────
  Every refresh of an organizer or admin page painted an empty page with a spinner, then the
  whole console appeared round it: the token is in localStorage, which the server cannot read,
  so the wait was drawn without the frame. Now the root layout hands down the session-hint
  cookie, RequireAuth draws its `frame` round the wait for a signed-in browser, and the frame
  is the SAME element when the page replaces the spinner - so nothing in it (an open search,
  the drawer) is lost at that moment.
*/

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => '/organizer',
}));

let resolveMe: (user: unknown) => void = () => {};
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // "Who am I" answers only when a test says so.
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise((resolve) => {
          resolveMe = (user) => resolve(new Response(JSON.stringify(user), { status: 200 }));
        }),
    ),
  );
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  localStorage.clear();
  document.cookie = 'etg_session=; Max-Age=0; Path=/';
  replace.mockClear();
});

let frameMounts = 0;
function Frame({ children }: { children: ReactNode }) {
  useEffect(() => {
    frameMounts += 1;
  }, []);
  return <section data-testid="frame">{children}</section>;
}
const frame = (content: ReactNode) => <Frame>{content}</Frame>;

function tree(hint: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <SessionHintProvider signedIn={hint}>
        <RequireAuth roles={['ORGANIZER_OWNER']} frame={frame}>
          <p>console page</p>
        </RequireAuth>
      </SessionHintProvider>
    </QueryClientProvider>
  );
}

async function hydrate(html: string, hint: boolean) {
  host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  await act(async () => {
    root = hydrateRoot(host!, tree(hint));
  });
  return host;
}

describe('RequireAuth with a frame', () => {
  it('signed-in hint: the server draws the frame round the wait', () => {
    const html = renderToString(tree(true));
    expect(html).toMatch(/<section data-testid="frame"><div class="flex h-64/);
    expect(html).not.toContain('console page');
  });

  it('no hint: the server draws the plain spinner, never the frame', () => {
    const html = renderToString(tree(false));
    expect(html).not.toContain('data-testid="frame"');
    expect(html).toContain('flex h-64');
  });

  it('keeps the same frame, mounted once, from the server HTML to the page', async () => {
    localStorage.setItem('etg_access', 'token');
    document.cookie = 'etg_session=1; Path=/';
    frameMounts = 0;
    const el = await hydrate(renderToString(tree(true)), true);
    const painted = el.querySelector('[data-testid="frame"]');
    expect(painted).not.toBeNull();

    await act(async () => {
      resolveMe({ id: 'u1', email: 'o@x.test', roles: ['ORGANIZER_OWNER'] });
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
    expect(el.textContent).toContain('console page');
    // The node painted from the server HTML is the one still on screen, and it mounted once.
    expect(el.querySelector('[data-testid="frame"]')).toBe(painted);
    expect(frameMounts).toBe(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('a session older than the hint: frame after hydration, and the hint is written', async () => {
    localStorage.setItem('etg_access', 'token');
    const el = await hydrate(renderToString(tree(false)), false);
    expect(el.querySelector('[data-testid="frame"]')).not.toBeNull();
    expect(document.cookie).toContain('etg_session=1');
  });

  it('signed out: the plain spinner, and on to sign in', async () => {
    const el = await hydrate(renderToString(tree(false)), false);
    expect(el.querySelector('[data-testid="frame"]')).toBeNull();
    expect(replace).toHaveBeenCalledWith('/login?next=%2Forganizer');
  });

  it('a stale hint with no token: the frame goes, and on to sign in', async () => {
    const el = await hydrate(renderToString(tree(true)), true);
    expect(el.querySelector('[data-testid="frame"]')).toBeNull();
    expect(replace).toHaveBeenCalledWith('/login?next=%2Forganizer');
  });
});
