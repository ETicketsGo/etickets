'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api, tokenStore, type AuthUser } from './api';
import { Spinner } from './components';
import {
  subscribeConnectivity,
  getConnectivitySnapshot,
  getServerConnectivitySnapshot,
  type ConnectivitySnapshot,
} from './connectivity';

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
}: {
  roles?: string[];
  children: ReactNode;
  loginPath?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading } = useAuthUser();
  const hasToken = typeof window !== 'undefined' && !!tokenStore.access;

  useEffect(() => {
    if (!hasToken) {
      router.replace(`${loginPath}?next=${encodeURIComponent(pathname)}`);
    }
  }, [hasToken, router, pathname, loginPath]);

  if (!hasToken || isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-text-muted">
        <Spinner />
      </div>
    );
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
