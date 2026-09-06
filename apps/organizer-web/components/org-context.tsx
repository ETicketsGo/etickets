'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import {
  api,
  EmptyState,
  ErrorState,
  ButtonLink,
  Select,
  Spinner,
  type Organization,
} from '@eticketsgo/web-kit';

interface OrgCtx {
  orgs: Organization[];
  activeOrg: Organization;
  setActiveOrgId: (id: string) => void;
}
const Ctx = createContext<OrgCtx | null>(null);
const KEY = 'etg_active_org';

/**
 * Which organization is active, as a store rather than only as context.
 *
 * The app shell needs it too, and the shell is OUTSIDE this provider — it has to keep
 * rendering while the organization list is still loading, or every navigation would blank the
 * sidebar. Two readers, one of them above the provider, is exactly what a small external
 * store is for; the alternative was reading localStorage in the header, which does not
 * re-render when somebody switches organization and so would leave a stale name in the
 * masthead until the next reload.
 */
let activeOrgId: string | null = null;
const listeners = new Set<() => void>();

export const activeOrgStore = {
  get: (): string | null => activeOrgId,
  set: (id: string | null): void => {
    if (activeOrgId === id) return;
    activeOrgId = id;
    listeners.forEach((l) => l());
  },
  subscribe: (l: () => void): (() => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useActiveOrgId(): string | null {
  return useSyncExternalStore(
    activeOrgStore.subscribe,
    activeOrgStore.get,
    // The server has no localStorage and no store; rendering "no organization yet" and then
    // correcting it on hydration is the honest sequence.
    () => null,
  );
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const {
    data: orgs,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: () => api.organizations.listMine(),
  });
  const activeId = useActiveOrgId();

  useEffect(() => {
    if (!orgs || orgs.length === 0) return;
    const stored = typeof window !== 'undefined' ? localStorage.getItem(KEY) : null;
    const valid = stored && orgs.some((o) => o.id === stored) ? stored : orgs[0].id;
    activeOrgStore.set(valid);
  }, [orgs]);

  const setActiveOrgId = (id: string) => {
    localStorage.setItem(KEY, id);
    activeOrgStore.set(id);
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-text-muted">
        <Spinner />
      </div>
    );
  }
  if (isError) {
    return (
      <ErrorState message="We couldn't load this. Please try again." onRetry={() => refetch()} />
    );
  }
  if (!orgs || orgs.length === 0) {
    return (
      <EmptyState
        title="No organization yet"
        hint="Set one up to start selling, or ask an owner to invite you to theirs."
        action={
          <ButtonLink href="/start" data-testid="create-organization">
            Set up your organization
          </ButtonLink>
        }
      />
    );
  }

  const activeOrg = orgs.find((o) => o.id === activeId) ?? orgs[0];
  return <Ctx.Provider value={{ orgs, activeOrg, setActiveOrgId }}>{children}</Ctx.Provider>;
}

export function useOrg(): OrgCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useOrg must be used within OrgProvider');
  return ctx;
}

export function OrgSwitcher() {
  const { orgs, activeOrg, setActiveOrgId } = useOrg();
  /*
    Nothing to switch between, and the masthead already says whose workspace this is. This
    used to print the organization's name here, which was the only place it appeared; now it
    would be the same name twice on one screen.
  */
  if (orgs.length <= 1) return null;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-text-muted">Organization</span>
      <Select
        aria-label="Organization"
        value={activeOrg.id}
        onChange={(e) => setActiveOrgId(e.target.value)}
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
    </label>
  );
}
