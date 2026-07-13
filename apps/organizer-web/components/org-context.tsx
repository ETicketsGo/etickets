'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  api,
  EmptyState,
  ErrorState,
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
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!orgs || orgs.length === 0) return;
    const stored = typeof window !== 'undefined' ? localStorage.getItem(KEY) : null;
    const valid = stored && orgs.some((o) => o.id === stored) ? stored : orgs[0].id;
    setActiveId(valid);
  }, [orgs]);

  const setActiveOrgId = (id: string) => {
    localStorage.setItem(KEY, id);
    setActiveId(id);
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
        hint="Your account is not a member of any organization. Ask an owner to invite you, or create one via the API."
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
  if (orgs.length <= 1) {
    return <p className="text-sm text-text-muted">{activeOrg.name}</p>;
  }
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
