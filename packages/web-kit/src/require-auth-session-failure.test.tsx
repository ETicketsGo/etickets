// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequireAuth, useAuthUser } from './hooks';

/*
  ── THE /auth/me STORM (QA, 2026-11-10) ───────────────────────────────────────────────────
  The admin console opened with a token the API rejected (and no refresh token) asked
  "who am I" 335 times in 20 seconds and never left its spinner. The guard drew the page when
  the request failed, the page's own reader (the MFA gate does this) re-ran the failed request
  on mount, the guard went back to its spinner, and round again. The same loop ran on a rate
  limit (429). These tests render the guard round a page that reads the user too, with the
  production retry default, and count the requests.
*/

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => '/admin/payouts',
}));

type Answer = { status: number; body?: unknown } | 'network';
let answer: Answer = { status: 200 };
const meCalls = () =>
  (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) =>
    String(c[0]).endsWith('/auth/me'),
  ).length;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  localStorage.clear();
  replace.mockClear();
  vi.unstubAllGlobals();
});

/** A page that reads the user itself, as the admin MFA gate does. */
function Page() {
  const { user } = useAuthUser();
  return <p>console page {user?.email}</p>;
}

async function open(
  a: Answer,
  tokens: { access?: string; refresh?: string } = { access: 'token' },
) {
  answer = a;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (answer === 'network') throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(answer.body ?? { code: 'X', message: 'refused' }), {
        status: answer.status,
      });
    }),
  );
  if (tokens.access) localStorage.setItem('etg_access', tokens.access);
  if (tokens.refresh) localStorage.setItem('etg_refresh', tokens.refresh);
  // retry: 1 is the production default (WebProviders); the guard must not depend on it being off.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 1 } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <QueryClientProvider client={qc}>
        <RequireAuth roles={['ADMIN']}>
          <Page />
        </RequireAuth>
      </QueryClientProvider>,
    );
  });
  await settle();
  return host;
}

/** Let the request, the re-render and any (wrong) re-request run their course. */
async function settle(ms = 300) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe('RequireAuth when "who am I" fails', () => {
  it('401 with no refresh token: asks once, closes the session, on to sign in', async () => {
    const el = await open({ status: 401, body: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    expect(meCalls()).toBe(1);
    expect(localStorage.getItem('etg_access')).toBeNull();
    expect(replace).toHaveBeenCalledWith('/login?next=%2Fadmin%2Fpayouts');
    expect(el.textContent).not.toContain('console page');
    await settle();
    expect(meCalls()).toBe(1);
  });

  it('401 with a refresh token that is refused: one refresh, session closed, no loop', async () => {
    const el = await open(
      { status: 401, body: { code: 'UNAUTHORIZED', message: 'Unauthorized' } },
      { access: 'token', refresh: 'refresh' },
    );
    expect(meCalls()).toBe(1);
    expect(localStorage.getItem('etg_access')).toBeNull();
    expect(replace).toHaveBeenCalledWith('/login?next=%2Fadmin%2Fpayouts');
    expect(el.textContent).not.toContain('console page');
  });

  it('403: asks once, says access denied, never draws the page, offers no retry loop', async () => {
    const el = await open({ status: 403, body: { code: 'FORBIDDEN', message: 'Forbidden' } });
    await settle();
    expect(meCalls()).toBe(1);
    expect(el.textContent).toContain('Access denied');
    expect(el.textContent).not.toContain('console page');
    expect(el.querySelector('button')).toBeNull();
    // The session is not closed for a refusal: signing in again would not change the answer.
    expect(localStorage.getItem('etg_access')).toBe('token');
  });

  it('429: asks once, explains, and asks again only when the person presses Try again', async () => {
    const el = await open({
      status: 429,
      body: { code: 'TOO_MANY_REQUESTS', message: 'Slow down' },
    });
    await settle(600);
    expect(meCalls()).toBe(1);
    expect(el.textContent).toContain('We could not confirm your session');
    expect(el.textContent).toContain('Too many requests');
    expect(el.textContent).not.toContain('console page');
    expect(localStorage.getItem('etg_access')).toBe('token');

    answer = { status: 200, body: { id: 'u1', email: 'staff@x.test', roles: ['ADMIN'] } };
    await act(async () => {
      el.querySelector('button')!.click();
    });
    await settle();
    expect(meCalls()).toBe(2);
    expect(el.textContent).toContain('console page staff@x.test');
  });

  it('network failure: asks once, explains, no spinner forever, no loop', async () => {
    const el = await open('network');
    await settle(600);
    expect(meCalls()).toBe(1);
    expect(el.textContent).toContain('Check your connection');
    expect(el.querySelector('.animate-spin')).toBeNull();
    expect(el.textContent).not.toContain('console page');
  });

  it('a 500 is treated like any other failure to answer: one request, then Try again', async () => {
    const el = await open({ status: 500 });
    await settle(600);
    expect(meCalls()).toBe(1);
    expect(el.textContent).toContain('Try again');
  });

  it('a good session still draws the page, with one request', async () => {
    const el = await open({
      status: 200,
      body: { id: 'u1', email: 'staff@x.test', roles: ['ADMIN'] },
    });
    expect(meCalls()).toBe(1);
    expect(el.textContent).toContain('console page staff@x.test');
  });

  it('a role the area does not admit is still refused (no bypass)', async () => {
    const el = await open({
      status: 200,
      body: { id: 'u2', email: 'buyer@x.test', roles: ['CUSTOMER'] },
    });
    expect(el.textContent).toContain('Access denied');
    expect(el.textContent).not.toContain('console page');
  });
});
