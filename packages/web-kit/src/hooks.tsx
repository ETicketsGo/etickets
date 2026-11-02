'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  ACCESS_TOKEN_STORAGE_KEY,
  api,
  tokenStore,
  getAuthSnapshot,
  getServerAuthSnapshot,
  type AuthUser,
} from './api';
import { Spinner } from './components';
import {
  subscribeConnectivity,
  getConnectivitySnapshot,
  getServerConnectivitySnapshot,
  type ConnectivitySnapshot,
} from './connectivity';

const subscribeNothing = () => () => {};

/**
 * False during the server render and hydration, true in every render after it.
 *
 * For a component whose first render must match the server HTML but which may know better
 * straight after - and for one mounted later, which can trust the browser from its first render.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
}

/**
 * Marks <html> with `data-session="in"` when this browser holds a session token, before the
 * first paint. Rendered by each console's root layout beside `workspaceThemeScript`.
 *
 * It does not authorise anything: it only chooses which of the two waiting screens that
 * `RequireAuth` puts in the server HTML is visible (the CSS is `[data-session-only]` in the
 * console's globals.css), so a signed-in refresh shows the console frame and a signed-out one
 * the plain spinner on its way to sign in. Wrapped, because a private window can throw on
 * localStorage, and then nothing is marked and the spinner shows, as before.
 */
export const sessionPresenceScript = `(function(){try{
if(localStorage.getItem('${ACCESS_TOKEN_STORAGE_KEY}')){document.documentElement.setAttribute('data-session','in');}
}catch(e){}})();`;

/** Fetches the current user; null when signed out. */
export function useAuthUser() {
  const query = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => api.auth.me(),
    enabled: typeof window !== 'undefined' && !!tokenStore.access,
    retry: false,
    staleTime: 60_000,
  });
  return { user: query.data ?? null, isLoading: query.isLoading, error: query.error };
}

export function useLogout() {
  const router = useRouter();
  const qc = useQueryClient();
  return async () => {
    const refresh = tokenStore.refresh;
    if (refresh) await api.auth.logout(refresh).catch(() => undefined);
    tokenStore.clear();
    qc.clear();
    router.push('/login');
  };
}

/** Client guard: redirects to /login when unauthenticated or lacking a role. */
export function RequireAuth({
  roles,
  children,
  loginPath = '/login',
  roleMismatchRedirect,
  pendingFrame,
}: {
  roles?: string[];
  children: ReactNode;
  loginPath?: string;
  /**
   * Where to send a signed-in user who lacks `roles`, instead of a dead-end "Access denied".
   *
   * "Access denied" is the right answer when the gap cannot be closed — a customer trying to
   * reach the admin console. It is the wrong answer when it CAN be: a new organizer holds
   * only the CUSTOMER role until they create an organization, and that page sits behind this
   * guard. They were told their account could not access the area that was going to grant
   * them access to it.
   */
  roleMismatchRedirect?: string;
  /**
   * The console's own frame, drawn around the spinner while a SIGNED-IN person's session is
   * being confirmed. See `sessionPresenceScript` for why both answers are in the server HTML.
   * Without it the wait is a bare spinner on an empty page - which, on every refresh of every
   * console page, was a blank screen for a moment and then the whole console appearing round it.
   */
  pendingFrame?: (content: ReactNode) => ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading } = useAuthUser();
  const hydrated = useHydrated();
  const hasToken = typeof window !== 'undefined' && !!tokenStore.access;
  /*
    Re-read the session when it changes. A session can end under an open page - a team removal
    answers the next request, whichever request it is, by clearing the tokens - and without this
    the guard noticed only if that request happened to be its own `auth/me`, leaving the page on
    an error state instead of the sign-in page.
  */
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => tokenStore.subscribe(rerender), []);

  useEffect(() => {
    if (!hasToken) {
      router.replace(`${loginPath}?next=${encodeURIComponent(pathname)}`);
    }
  }, [hasToken, router, pathname, loginPath]);

  if (!hasToken || isLoading) {
    const spinner = (
      <div className="flex h-64 items-center justify-center text-text-muted">
        <Spinner />
      </div>
    );
    if (!pendingFrame) return spinner;
    /*
      ── THE WAIT LOOKS LIKE THE CONSOLE, FROM THE FIRST FRAME ──────────────────────────────
      The token is in localStorage, which the server cannot read, so the server HTML carries
      both answers: the console frame (signed in) and the bare spinner (signed out, on the way
      to sign in). `sessionPresenceScript` marks <html> before the first paint and CSS shows
      the one that is true. Once hydrated the token is readable and only the true one is
      rendered; the wrappers stay in place so the frame is not remounted, and lose the marker
      so a later sign-out is not hidden by a stale <html> attribute.
    */
    return (
      <>
        {(!hydrated || hasToken) && (
          <div data-session-only={hydrated ? undefined : 'in'}>{pendingFrame(spinner)}</div>
        )}
        {(!hydrated || !hasToken) && (
          <div data-session-only={hydrated ? undefined : 'out'}>{spinner}</div>
        )}
      </>
    );
  }

  if (roles && user && !user.roles.some((r) => roles.includes(r)) && roleMismatchRedirect) {
    return <RoleMismatchRedirect to={roleMismatchRedirect} />;
  }

  if (roles && user && !user.roles.some((r) => roles.includes(r))) {
    return (
      <div className="mx-auto max-w-md p-10 text-center">
        <h1 className="text-lg font-semibold text-text-primary">Access denied</h1>
        <p className="mt-2 text-sm text-text-muted">Your account role cannot access this area.</p>
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * Redirect on mount. A separate component because the decision to redirect happens after the
 * early returns above, and hooks cannot be called conditionally.
 */
function RoleMismatchRedirect({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(to);
  }, [router, to]);
  return (
    <div className="flex h-64 items-center justify-center text-text-muted">
      <Spinner />
    </div>
  );
}

export function hasAnyRole(user: AuthUser | null, roles: string[]): boolean {
  return !!user && user.roles.some((r) => roles.includes(r));
}

/** Live countdown to a target time; ticks every second on the client. */
export function useCountdown(target: string | Date | undefined) {
  const [now, setNow] = useState<number>(() => (target ? Date.now() : 0));
  useEffect(() => {
    if (!target) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [target]);
  const total = target ? Math.max(0, new Date(target).getTime() - now) : 0;
  const s = Math.floor(total / 1000);
  return {
    total,
    isPast: !!target && total <= 0,
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
  };
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}
interface WakeLockNavigator {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

/**
 * Keeps the screen awake while `active` (Event Day Mode) using the Wake Lock API,
 * re-acquiring after tab visibility changes and releasing on cleanup. Degrades
 * gracefully: `supported` is false where the API is unavailable so the UI can
 * explain it. Never throws.
 */
export function useWakeLock(active: boolean): { supported: boolean; engaged: boolean } {
  const [supported] = useState(() => typeof navigator !== 'undefined' && 'wakeLock' in navigator);
  const [engaged, setEngaged] = useState(false);
  const sentinel = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    if (!active || !supported) return;
    let cancelled = false;

    const request = async () => {
      try {
        const nav = navigator as unknown as WakeLockNavigator;
        const lock = await nav.wakeLock!.request('screen');
        if (cancelled) {
          await lock.release().catch(() => undefined);
          return;
        }
        sentinel.current = lock;
        setEngaged(true);
        lock.addEventListener?.('release', () => setEngaged(false));
      } catch {
        setEngaged(false);
      }
    };

    void request();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void request();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      sentinel.current?.release().catch(() => undefined);
      sentinel.current = null;
      setEngaged(false);
    };
  }, [active, supported]);

  return { supported, engaged };
}

/** Tracks browser online/offline state (for the live check-in screen). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/**
 * Hydration-safe connectivity snapshot backed by the `./connectivity` external store. SSR renders a
 * constant UNKNOWN; the client reflects live evidence (browser hint + API-origin reachability). The
 * store itself is React-free (so `api.ts` can signal reachability from any environment); this hook
 * is the client-only binding.
 */
export function useConnectivity(): ConnectivitySnapshot {
  return useSyncExternalStore(
    subscribeConnectivity,
    getConnectivitySnapshot,
    getServerConnectivitySnapshot,
  );
}

/**
 * Whether a session token is present, kept live as it changes.
 *
 * Use this rather than reading `tokenStore.access` in a mount-only effect. Next.js keeps the
 * layout mounted across client-side navigation, so a component that reads the token once
 * never sees a later sign-in — the customer header showed "Sign in / Sign up" to signed-in
 * users for exactly that reason. Subscribing also picks up sign-out from another tab.
 *
 * Returns false during server render and the first paint, then corrects on hydration; that
 * is deliberate, because the token only exists in the browser.
 */
export function useIsAuthenticated(): boolean {
  return useSyncExternalStore(tokenStore.subscribe, getAuthSnapshot, getServerAuthSnapshot);
}
