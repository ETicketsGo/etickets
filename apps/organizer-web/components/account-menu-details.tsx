'use client';

import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useId } from 'react';
import { api, consoleAccountMenuItemClass, consoleAccountMenuMetaClass } from '@eticketsgo/web-kit';
import { switchTargets } from '@/lib/account-identity';
import { usableOrganizations } from '@/lib/suspension';
import { selectActiveOrganization, useActiveOrgId } from './org-context';

/**
 * The organizer's part of the top bar's account menu: which organization is active, and the
 * member's other organizations to switch to.
 *
 * The shell sits OUTSIDE `OrgProvider` (it must keep drawing while the list loads), so this reads
 * the same react-query cache and the same active-organization store as the masthead, and
 * switches through `selectActiveOrganization` - the switcher above the page does the same. With
 * one organization there is nothing to switch to, and "Switch organization" is left out.
 */
export function OrganizerAccountDetails({ onDone }: { onDone: () => void }) {
  const activeId = useActiveOrgId();
  const headingId = useId();
  const { data } = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: () => api.organizations.listMine(),
  });
  const orgs = usableOrganizations(data);
  if (orgs.length === 0) return null;
  const active = orgs.find((o) => o.id === activeId) ?? orgs[0];
  const others = switchTargets(orgs, active.id);
  const meta = consoleAccountMenuMetaClass('desk');
  const item = consoleAccountMenuItemClass('desk');

  return (
    <div className="py-1">
      <div className="px-4 py-2">
        <p className={meta}>Organization</p>
        <p
          data-testid="account-menu-organization"
          className="flex min-w-0 items-center gap-1.5 text-brand-ui font-semibold text-brand-ink"
          title={active.name}
        >
          <Check className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{active.name}</span>
        </p>
      </div>
      {others.length > 0 && (
        <div role="group" aria-labelledby={headingId}>
          <p id={headingId} className={`px-4 pb-1 pt-1 ${meta}`}>
            Switch organization
          </p>
          {/* Capped: somebody in many organizations still reaches Sign out without scrolling. */}
          <div className="max-h-56 overflow-y-auto">
            {others.map((o) => (
              <button
                key={o.id}
                type="button"
                className={item}
                onClick={() => {
                  selectActiveOrganization(o.id);
                  onDone();
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate">{o.name}</span>
                  {(o.qualifier || o.role) && (
                    <span className={`block truncate ${meta}`}>
                      {[o.qualifier, o.role].filter(Boolean).join(', ')}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
