'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { api, tokenStore, type AuthUser } from './api';
import { Spinner } from './components';

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
