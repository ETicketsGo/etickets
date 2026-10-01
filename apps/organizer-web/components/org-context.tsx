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
  activeOrganizationSentenceName,
  organizationIdentities,
  type Organization,
} from '@eticketsgo/web-kit';
import { orgPermissions, type OrgPermissions } from '@/lib/org-permissions';

interface OrgCtx {
  orgs: Organization[];
  activeOrg: Organization;
  setActiveOrgId: (id: string) => void;
  /**
   * What the signed-in member may do in the active organization, from their role in it. Pages
   * read it to hide or explain actions the API would refuse; the API still decides.
   */
  can: OrgPermissions;
  /**
   * The active organization, named for a sentence that is about to do something.
   *
   * Always carries its qualifier where one exists, even though the switcher leaves it off for
   * an unambiguous name: a confirmation is a different risk from a dropdown. Reading a list
   * wrongly costs a moment; settling, publishing or deleting against the wrong entity is not
   * something the organizer can take back.
   */
  activeOrgSentenceName: string;
  /**
   * Any organization this member belongs to, named for a sentence.
   *
   * Event-scoped actions must name the event's OWN organization, not whichever one the switcher
   * happens to be on - they can differ, and naming the active one in a delete confirmation would
   * state something false about what is being deleted. Falls back to the id's absence rather
   * than guessing: an organization this member cannot see has no name to print.
   */
  orgSentenceName: (organizationId: string | null | undefined) => string | null;
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
  return (
    <Ctx.Provider
      value={{
        orgs,
        activeOrg,
        setActiveOrgId,
        can: orgPermissions(activeOrg.myRole),
        activeOrgSentenceName: activeOrganizationSentenceName(activeOrg, orgs),
        orgSentenceName: (organizationId) => {
          const found = orgs.find((o) => o.id === organizationId);
          return found ? activeOrganizationSentenceName(found, orgs) : null;
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
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

  /*
    Labels that cannot collide.

    This printed `o.name` alone, and a QA account holding two organizations both called
    "DeepTrics" was offered two identical lines. Picking the wrong one is silent: the organizer
    prices a show, publishes it, takes money and settles it against an entity they did not
    intend, and every screen afterwards agrees with the mistake.

    `organizationIdentities` qualifies a name only where it is ambiguous, and only with a value
    that actually differs from its namesakes - so the ordinary single-name case is unchanged and
    nobody reads a wall of repeated cities. A native `<option>` cannot hold two lines, which is
    why the qualifier is folded into `label` rather than rendered as its own element.
  */
  const identities = organizationIdentities(orgs);
  const labelOf = (id: string) => identities.find((i) => i.id === id)?.label ?? '';

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
            {labelOf(o.id)}
          </option>
        ))}
      </Select>
    </label>
  );
}
