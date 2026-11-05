// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/*
  The invitation page (owner decision, 2026-10-26): only the invited person accepts. Signed
  out, it asks them to sign in (or, for an account the invitation created, to claim it with a
  code sent to the address); signed in, it accepts with the session, and walks them through
  confirming their email or signing out of somebody else's account when the API says so.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: push, prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => '/invite/tok',
  useSearchParams: () => new URLSearchParams(),
}));

const { InviteAcceptance } = await import('./invite-acceptance');
const { tokenStore } = await import('@eticketsgo/web-kit');

type Reply = { status: number; body: unknown };
let routes: Record<string, Reply | Reply[]> = {};
const calls: { method: string; path: string; auth: string | null; body: unknown }[] = [];

function stubApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname.replace(/^\/api/, '');
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = new Headers(init.headers);
      calls.push({
        method,
        path,
        auth: headers.get('authorization'),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const key = `${method} ${path}`;
      const entry = routes[key];
      const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]) : entry;
      if (!reply) return new Response(JSON.stringify({}), { status: 200 });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }),
  );
}

const summary = (needsPassword: boolean) => ({
  status: 200,
  body: {
    email: 'asha@example.com',
    organizationName: 'Lotus Hall',
    role: 'ORGANIZER_MANAGER',
    needsPassword,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  },
});
const joined = {
  status: 201,
  body: {
    email: 'asha@example.com',
    organizationId: 'org-1',
    organizationName: 'Lotus Hall',
    role: 'ORGANIZER_MANAGER',
  },
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function mount() {
  const onJoined = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<InviteAcceptance token="tok" onJoined={onJoined} />);
  });
  await flush();
  return { onJoined };
}

const button = (text: string) =>
  [...host!.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
async function click(text: string) {
  const b = button(text);
  if (!b) throw new Error(`no button "${text}" in: ${host!.textContent}`);
  await act(async () => b.click());
  await flush();
}
async function type(selector: string, value: string) {
  const el = host!.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => host!.querySelector('form')!.requestSubmit());
  await flush();
  await flush();
}

beforeEach(() => {
  routes = {};
  calls.length = 0;
  push.mockReset();
  localStorage.clear();
  stubApi();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

describe('InviteAcceptance', () => {
  it('signed out with an existing account: asks them to sign in and accepts nothing', async () => {
    routes['GET /public/invitations/tok'] = summary(false);
    await mount();
    expect(host!.textContent).toContain('Sign in to join Lotus Hall');
    expect(button('Accept invitation')).toBeUndefined();
    expect(calls.some((c) => c.path.endsWith('/accept'))).toBe(false);
  });

  it('signed in: confirms the email when asked, then joins', async () => {
    tokenStore.set({ accessToken: 'access-1', refreshToken: 'refresh-1' } as never);
    routes['GET /public/invitations/tok'] = summary(false);
    routes['POST /public/invitations/tok/accept'] = [
      {
        status: 403,
        body: { code: 'EMAIL_NOT_VERIFIED', message: 'Confirm your email address first.' },
      },
      joined,
    ];
    routes['POST /auth/email/confirm/request-code'] = {
      status: 201,
      body: { sent: true, expiresInMinutes: 10, email: 'asha@example.com' },
    };
    routes['POST /auth/email/confirm/verify'] = {
      status: 201,
      body: { email: 'asha@example.com', emailVerifiedAt: new Date().toISOString() },
    };
    const { onJoined } = await mount();

    await click('Accept invitation');
    expect(host!.textContent).toContain('Confirm your email address first');
    await click('Send me a code');
    await type('#confirm-code', '123456');
    await submit();

    const accepts = calls.filter((c) => c.path === '/public/invitations/tok/accept');
    expect(accepts).toHaveLength(2);
    // The session goes with every accept: the token alone is never the credential.
    expect(accepts.every((c) => c.auth === 'Bearer access-1')).toBe(true);
    expect(calls.find((c) => c.path === '/auth/email/confirm/verify')?.body).toEqual({
      code: '123456',
    });
    expect(onJoined).toHaveBeenCalledWith('/organizer');
  });

  it('signed in as somebody else: says so and offers to sign out', async () => {
    tokenStore.set({ accessToken: 'owner-access', refreshToken: 'owner-refresh' } as never);
    routes['GET /public/invitations/tok'] = summary(false);
    routes['POST /public/invitations/tok/accept'] = {
      status: 403,
      body: { code: 'INVITATION_WRONG_ACCOUNT', message: 'Different address.' },
    };
    const { onJoined } = await mount();
    await click('Accept invitation');
    expect(host!.textContent).toContain('You are signed in with a different account');
    expect(onJoined).not.toHaveBeenCalled();

    await click('Sign out');
    expect(calls.some((c) => c.path === '/auth/logout')).toBe(true);
    expect(tokenStore.access).toBeNull();
    // Back to the sign-in for the invited address.
    expect(host!.textContent).toContain('Sign in to join Lotus Hall');
  });

  it('a new account is claimed with a code sent to the address, then signs in and joins', async () => {
    routes['GET /public/invitations/tok'] = summary(true);
    routes['POST /public/invitations/tok/account/request-code'] = {
      status: 201,
      body: { sent: true, expiresInMinutes: 10, email: 'asha@example.com' },
    };
    routes['POST /public/invitations/tok/account'] = {
      status: 201,
      body: { email: 'asha@example.com', accepted: false },
    };
    routes['POST /auth/login'] = {
      status: 201,
      body: { accessToken: 'new-access', refreshToken: 'new-refresh' },
    };
    routes['POST /public/invitations/tok/accept'] = joined;
    const { onJoined } = await mount();

    expect(button('Accept invitation')).toBeUndefined();
    await click('Send me a code');
    await type('#invite-code', '654321');
    await type('#fullName', 'Asha Rao');
    await type('#password', 'Copper-Harbour-Kestrel-93');
    await submit();

    const claim = calls.find((c) => c.path === '/public/invitations/tok/account');
    expect(claim?.body).toEqual({
      code: '654321',
      fullName: 'Asha Rao',
      password: 'Copper-Harbour-Kestrel-93',
    });
    // The claim carried no session; the accept carried the new one.
    expect(claim?.auth).toBeNull();
    const accept = calls.find((c) => c.path === '/public/invitations/tok/accept');
    expect(accept?.auth).toBe('Bearer new-access');
    expect(onJoined).toHaveBeenCalledWith('/organizer');
  });
});
