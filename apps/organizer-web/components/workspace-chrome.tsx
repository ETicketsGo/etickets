'use client';

import { useQuery } from '@tanstack/react-query';
import { orgPermissions, type OrgPermissions } from '@/lib/org-permissions';
import { Monitor, Moon, Sun } from 'lucide-react';
import { api, useColorScheme, WorkspaceAccent, type ColorScheme } from '@eticketsgo/web-kit';
import { useActiveOrgId } from './org-context';

/**
 * Who this workspace belongs to, read from above the organization provider.
 *
 * Uses the same react-query key the provider does, so this is the cache, not a second
 * request. It has to live outside `OrgProvider` because the provider replaces its children
 * with a spinner while the list loads — useful inside the page, fatal for the header, which
 * would blank on every navigation.
 */
export function useWorkspace(): {
  name: string;
  logoUrl?: string | null;
  accent?: string | null;
  /**
   * Whether this organization actually does film business.
   *
   * Drives whether the sidebar shows Films at all. False while the list is loading, which is the
   * right way round: a section that appears a moment after the page is less jarring than one that
   * appears and then vanishes.
   */
  doesFilmBusiness: boolean;
  /**
   * What this member may be OFFERED, from their role in this organization.
   *
   * The organization list already carries `myRole`; the sidebar simply never asked. So a
   * check-in worker - whose whole job is a scanner - was shown Finance, Payouts, Receipts,
   * Refunds, Team and Settings, every one of which the API refuses them.
   *
   * Navigation visibility is UX and is NOT the authorization. The API decides, and goes on
   * deciding; this only stops the console offering what will be refused.
   */
  can: OrgPermissions;
} {
  const activeId = useActiveOrgId();
  const { data } = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: () => api.organizations.listMine(),
  });
  const org = data?.find((o) => o.id === activeId) ?? data?.[0];
  /*
    A neutral placeholder rather than "ETicketsGo" while the name is in flight. Painting the
    platform's name into the organizer's masthead and then swapping it a moment later is worse
    than a brief blank — it is the exact impression this header exists to remove.
  */
  return {
    name: org?.name ?? ' ',
    logoUrl: org?.logoUrl,
    accent: org?.consoleTheme,
    doesFilmBusiness: (org?._count?.movies ?? 0) > 0,
    /*
      `undefined` while the list is in flight, which `orgPermissions` reads as unrestricted.
      That is the right way round: briefly offering an action the API refuses explains itself,
      while briefly hiding one a person is entitled to looks like the feature is missing.
    */
    can: orgPermissions(org?.myRole),
  };
}

/** Applies the organization's palette. Renders nothing. */
export function WorkspaceTheme() {
  const { accent } = useWorkspace();
  return <WorkspaceAccent accent={accent} />;
}

const OPTIONS: { value: ColorScheme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'Match system', Icon: Monitor },
];

/**
 * Light, dark, or whatever the machine is doing.
 *
 * Three states rather than a two-way toggle. A toggle has to decide what "off" means before
 * the person has expressed a preference, and whichever it picks is wrong for half of them;
 * "match system" is a real answer and it is the default.
 *
 * A segmented control rather than a dropdown because it is three short options that people
 * flip between, and because the current one should be readable without opening anything.
 */
export function ColorSchemeSwitch({ compact = false }: { compact?: boolean }) {
  const { scheme, setScheme } = useColorScheme();

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = scheme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setScheme(value)}
            className={`flex items-center gap-1.5 rounded px-2 py-1.5 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
              active
                ? 'bg-tint-primary text-action-primary'
                : 'text-text-muted hover:bg-background-subtle hover:text-text-primary'
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {!compact && <span className="hidden lg:inline">{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
