'use client';

import { useQuery } from '@tanstack/react-query';
import { orgPermissions, type OrgPermissions } from '@/lib/org-permissions';
import {
  api,
  ColorSchemeSwitch as SharedColorSchemeSwitch,
  WorkspaceAccent,
} from '@eticketsgo/web-kit';
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
  /** This member's role in THIS organization, in words: the line under their name. */
  roleLabel: string | null;
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
    roleLabel: ORG_ROLE_LABEL[org?.myRole ?? ''] ?? null,
  };
}

/** A member's role in an organization, as the top bar says it under their name. */
const ORG_ROLE_LABEL: Record<string, string> = {
  ORGANIZER_OWNER: 'Owner',
  ORGANIZER_MANAGER: 'Manager',
  CHECKIN_STAFF: 'Check-in staff',
};

/** Applies the organization's palette. Renders nothing. */
export function WorkspaceTheme() {
  const { accent } = useWorkspace();
  return <WorkspaceAccent accent={accent} />;
}

/**
 * Light, dark, or whatever the machine is doing: the shared web-kit control, with its words
 * unless `compact`. Kept under this name because the settings page imports it from here.
 */
export function ColorSchemeSwitch({ compact = false }: { compact?: boolean }) {
  return <SharedColorSchemeSwitch labels={!compact} />;
}
