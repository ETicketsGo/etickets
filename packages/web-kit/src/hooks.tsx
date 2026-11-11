'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  api,
  backfillSessionHintCookie,
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

const SessionHintContext = createContext(false);

/**
 * What the SERVER believed about the session when it drew this page: the `etg_session` hint
 * cookie `tokenStore` writes beside the tokens (see `SESSION_HINT_COOKIE`), read by the root
 * layout and handed down here. A hint, never a credential: it only chooses which waiting screen
 * the server draws, so the first paint already matches the person looking at it.
 */
export function SessionHintProvider({
  signedIn,
  children,
}: {
  signedIn: boolean;
  children: ReactNode;
}) {
  return <SessionHintContext.Provider value={signedIn}>{children}</SessionHintContext.Provider>;
}

/** Fetches the current user; null when signed out. */
export function useAuthUser() {
  const query = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => api.auth.me(),
    enabled: typeof window !== 'undefined' && !!tokenStore.access,
    retry: false,
    /*
      A failed "who am I" is not asked again just because another component starts reading it.
      With the default, the guard's spinner unmounted the page, the page mounted again when the
      request failed, its own reader re-ran the request, and the spinner came back: an endless
      loop of /auth/me (rate limited, refused or offline alike). A retry is now the person's
      choice (`refetch`, the "Try again" button below).
    */
    retryOnMount: false,
    staleTime: 60_000,
  });
  return {
    user: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    isFetching: query.isFetching,
  };
}

/** The HTTP status of a failed request, when the API answered at all. */
function failureStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
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
  frame,
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
   * The console's frame (sidebar, top bar), drawn round the page AND round the wait while a
   * signed-in person's session is confirmed - the same element in both, so it is never
   * remounted. Without it the wait was a bare spinner on an empty page, and every refresh of
   * every console page showed that blank page for a moment before the console appeared round
   * it. Whether to draw it before the token can be read comes from `SessionHintProvider`.
   */
  frame?: (content: ReactNode) => ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading, error, refetch, isFetching } = useAuthUser();
  const hydrated = useHydrated();
  const hint = useContext(SessionHintContext);
  const hasToken = typeof window !== 'undefined' && !!tokenStore.access;
  /*
    Who the frame is drawn for. The server cannot read localStorage, so it - and the hydration
    pass, which must draw exactly what the server drew - go by the hint; every render after
    that goes by the token itself, which wins whenever the two disagree.
  */
  const framed = !!frame && (hydrated ? hasToken : hint);
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
    } else if (frame) {
      backfillSessionHintCookie();
    }
  }, [hasToken, router, pathname, loginPath, frame]);

  if (!hasToken || isLoading) {
    const spinner = (
      <div className="flex h-64 items-center justify-center text-text-muted">
        <Spinner />
      </div>
    );
    // A fragment in both places, like the return below, so the frame keeps its place in the
    // tree when the page replaces the spinner inside it.
    return <>{framed && frame ? frame(spinner) : spinner}</>;
  }

  /*
    "Who am I" failed and nobody is known. The page is never drawn without a user: it would only
    fail request by request. A refused session (401) has already been closed by `request`, and
    the effect above sends the person to sign in. What is left is a refusal (403) or a failure to
    answer at all (rate limited, server error, offline), which waits for the person to try again.
  */
  if (!user && error) {
    const status = failureStatus(error);
    const refused = status === 403;
    const notice = (
      <div className="mx-auto max-w-md p-10 text-center" role="alert">
        <h1 className="text-lg font-semibold text-text-primary">
          {refused ? 'Access denied' : 'We could not confirm your session'}
        </h1>
        <p className="mt-2 text-sm text-text-muted">
          {refused
            ? 'Your account cannot open this area.'
            : status === 429
              ? 'Too many requests just now. Wait a moment, then try again.'
              : 'Check your connection, then try again.'}
        </p>
        {refused ? null : (
          <button
            type="button"
            className="mt-4 text-sm font-medium text-action-primary hover:underline disabled:opacity-60"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            {isFetching ? 'Trying again...' : 'Try again'}
          </button>
        )}
      </div>
    );
    return <>{framed && frame ? frame(notice) : notice}</>;
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
  return <>{frame ? frame(children) : children}</>;
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
