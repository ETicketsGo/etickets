// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequireAuth, sessionPresenceScript } from './hooks';

/*
  ── REFRESH FLICKER (2026-11) ─────────────────────────────────────────────────────────────
  Every refresh of an organizer or admin page painted an empty page with a spinner, then the
  whole console appeared round it: the server cannot read the token in localStorage, so the
  wait was drawn without the frame. Now the server HTML carries both waiting screens, a
  pre-paint script marks <html>, and CSS shows the true one. These pin each half.
*/

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => '/organizer',
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // "Who am I" never answers: the guard stays in its waiting state for the whole test.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
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
  document.documentElement.removeAttribute('data-session');
  replace.mockClear();
});

const frame = (content: ReactNode) => <section data-testid="frame">{content}</section>;

function tree() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <RequireAuth pendingFrame={frame}>
        <p>console page</p>
      </RequireAuth>
    </QueryClientProvider>
  );
}

describe('RequireAuth while the session is being confirmed', () => {
  it('puts both waiting screens in the server HTML, each marked for the pre-paint CSS', () => {
    const html = renderToString(tree());
    expect(html).toMatch(/<div data-session-only="in"><section data-testid="frame">/);
    expect(html).toMatch(/<div data-session-only="out"><div class="flex h-64/);
    expect(html).not.toContain('console page');
  });

  it('signed in: hydrates to the frame alone, in the same DOM node, without the marker', async () => {
    const html = renderToString(tree());
    localStorage.setItem('etg_access', 'token');
    host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    const serverFrame = host.querySelector('[data-testid="frame"]');
    await act(async () => {
      root = hydrateRoot(host!, tree());
    });
    const frames = host.querySelectorAll('[data-testid="frame"]');
    expect(frames).toHaveLength(1);
    // Not remounted: the node painted from the server HTML is the one kept.
    expect(frames[0]).toBe(serverFrame);
    expect(host.querySelector('[data-session-only]')).toBeNull();
    expect(host.textContent).not.toContain('console page');
    expect(replace).not.toHaveBeenCalled();
  });

  it('signed out: hydrates to the spinner alone and goes to sign in', async () => {
    const html = renderToString(tree());
    host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    await act(async () => {
      root = hydrateRoot(host!, tree());
    });
    expect(host.querySelector('[data-testid="frame"]')).toBeNull();
    expect(host.querySelector('.h-64')).not.toBeNull();
    expect(replace).toHaveBeenCalledWith('/login?next=%2Forganizer');
  });
});

describe('sessionPresenceScript', () => {
  it('marks <html> when the browser holds a session token', () => {
    localStorage.setItem('etg_access', 'token');
    new Function(sessionPresenceScript)();
    expect(document.documentElement.getAttribute('data-session')).toBe('in');
  });

  it('marks nothing without one', () => {
    new Function(sessionPresenceScript)();
    expect(document.documentElement.hasAttribute('data-session')).toBe(false);
  });
});
