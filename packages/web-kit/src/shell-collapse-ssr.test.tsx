// @vitest-environment jsdom
import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppShell, SidebarPreferenceProvider } from './shell';

/*
  ── COLLAPSED SIDEBAR ON REFRESH (2026-11) ────────────────────────────────────────────────
  Measured on QA: with the sidebar collapsed, a hard reload drew it open (232px) and folded it
  to the 72px rail over the next ~160ms, because the choice lived only in localStorage. The
  root layout now hands the server the cookie the shell keeps beside it.
*/

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => '/organizer',
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  localStorage.clear();
  document.cookie = 'etg_sidebar_collapsed=; Max-Age=0; Path=/';
});

const NAV = [{ href: '/organizer', label: 'Overview' }];
function tree(collapsed: boolean) {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <SidebarPreferenceProvider collapsed={collapsed}>
        <AppShell brand="Organizer" nav={NAV}>
          <p>page</p>
        </AppShell>
      </SidebarPreferenceProvider>
    </QueryClientProvider>
  );
}
const asideClass = (html: string) => (html.match(/<aside[^>]*class="([^"]*)"/) ?? [])[1] ?? '';

describe('the collapsed sidebar in the server HTML', () => {
  it('is the rail when the cookie says collapsed, and the full sidebar when not', () => {
    expect(asideClass(renderToString(tree(true)))).toContain('w-shell-rail');
    expect(asideClass(renderToString(tree(false)))).not.toContain('w-shell-rail');
  });

  it('stays the rail through hydration when the device chose it', async () => {
    localStorage.setItem('etg_sidebar_collapsed', '1');
    document.cookie = 'etg_sidebar_collapsed=1; Path=/';
    host = document.createElement('div');
    host.innerHTML = renderToString(tree(true));
    document.body.appendChild(host);
    const aside = host.querySelector('aside')!;
    await act(async () => {
      root = hydrateRoot(host!, tree(true));
    });
    expect(host.querySelector('aside')).toBe(aside);
    expect(aside.className).toContain('w-shell-rail');
  });

  it('writes the cookie for a choice that predates it, so the next load is drawn right', async () => {
    localStorage.setItem('etg_sidebar_collapsed', '1');
    host = document.createElement('div');
    host.innerHTML = renderToString(tree(false));
    document.body.appendChild(host);
    await act(async () => {
      root = hydrateRoot(host!, tree(false));
    });
    expect(host.querySelector('aside')!.className).toContain('w-shell-rail');
    expect(document.cookie).toContain('etg_sidebar_collapsed=1');
  });
});
