'use client';

import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Rocket } from 'lucide-react';
import {
  AppShell,
  RequireAuth,
  SectionTabs,
  api,
  brandButtonClasses,
  type ShellNotice,
} from '@eticketsgo/web-kit';
import { navFor } from '@/components/organizer-nav';
import { OrgProvider, OrgSwitcher } from '@/components/org-context';
import { useOnboardingDismissed, useOnboardingProgress } from '@/lib/onboarding';
import { WorkspaceTheme, useWorkspace } from '@/components/workspace-chrome';
import { DeskNotificationsButton, DeskSchemeSwitch } from '@/components/desk-chrome';

/**
 * A page that exists to become paper gets no shell.
 *
 * The sidebar, the org switcher and the app frame are useful on a screen and are wasted ink
 * on a sheet — and hiding them with print CSS is worse than not rendering them: the usual
 * trick pulls the printable area out of the document flow, which prints exactly one page and
 * silently drops every ticket after the first. Authentication still applies; only the
 * furniture goes.
 */
function isPrintRoute(path: string): boolean {
  return path.endsWith('/print') || path.includes('/print/');
}

/**
 * The bell in the top bar, with the organizer stream's real unread count.
 *
 * The same count the notification centre reads, scoped to the ORGANIZER audience so a person
 * who also buys tickets does not see their customer messages counted here. Until it answers -
 * or if it fails - the bell shows no number rather than a guessed one.
 */
function OrganizerNotifications() {
  const { data } = useQuery({
    queryKey: ['notifications', 'unread-count', 'ORGANIZER'],
    queryFn: () => api.notifications.unreadCount('ORGANIZER'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return <DeskNotificationsButton href="/organizer/notifications" unread={data?.unreadCount} />;
}

/**
 * "Finish setup, 3 of 5 done" at the top of the sidebar, while setup is unfinished.
 *
 * Get started used to be a permanent sidebar row under Overview; a setup checklist is a job
 * done once, so it is offered only while there is something left, and it goes when the required
 * steps are done (or the organizer chose "Skip for now" on the page). The same server action
 * list as Get started and Overview, read from the same react-query key.
 */
function useSetupNotice(orgId: string, enabled: boolean): ShellNotice | null {
  const dismissed = useOnboardingDismissed();
  const { completed, total, allComplete, isLoading, isError } = useOnboardingProgress(
    orgId,
    enabled,
  );
  if (!enabled || dismissed || isLoading || isError || total === 0 || allComplete) return null;
  return {
    label: 'Finish setup',
    detail: `${completed} of ${total} done`,
    href: '/organizer/onboarding',
    icon: Rocket,
    progress: completed / total,
  };
}

/**
 * The organizer's own masthead, their palette, and their team's chrome.
 *
 * Split out from the layout because it reads the workspace, and the layout's job is to decide
 * whether there should be chrome at all (a print route gets none).
 */
function OrganizerChrome({ children }: { children: React.ReactNode }) {
  const workspace = useWorkspace();
  /*
    Read from the shell, which sits OUTSIDE OrgProvider, so the organization list is reached
    through the same small store the masthead uses. A nav that waited for a provider below it
    would blank on every navigation.
  */
  const nav = navFor({ doesFilmBusiness: workspace.doesFilmBusiness, can: workspace.can });
  const canCreate = workspace.can.financials || workspace.can.ownerActions;
  const pathname = usePathname() ?? '';
  // Owners and managers set an organization up; check-in staff have nothing to finish.
  const setup = useSetupNotice(workspace.id ?? '', workspace.can.financials);
  return (
    <AppShell
      brand="Organizer"
      nav={nav}
      workspace={{ name: workspace.name, logoUrl: workspace.logoUrl }}
      headerAccessory={<DeskSchemeSwitch />}
      accountRole={workspace.roleLabel}
      sidebarNotice={setup}
      notifications={<OrganizerNotifications />}
      /*
        The console's one primary action, for the members who can create events. Check-in
        staff cannot, and are not offered it - the same rule their sidebar follows.
      */
      primaryAction={canCreate ? { label: 'Create event', href: '/organizer/events/new' } : null}
      /*
        On a phone the top bar has no room for it beside the appearance switch, so the primary
        action leads the menu instead: there, with its words, rather than nowhere.
      */
      drawerAccessory={
        canCreate ? (
          <Link
            href="/organizer/events/new"
            className={`w-full ${brandButtonClasses('primary', 'md')}`}
          >
            Create event
          </Link>
        ) : undefined
      }
      // Organizer pages are tables, schedules and seat maps; the frame should not be what
      // squeezes them. Forms and prose keep their own measure inside it - see AppShell.
      width="fluid"
      /*
        The brand layer's desk (docs/design/DESIGN-SYSTEM.md): paper and ink, no navy. Admin keeps
        the classic frame until it adopts the system; the shell's behaviour is the same in both.
      */
      appearance="desk"
    >
      <WorkspaceTheme />
      <OrgProvider>
        <div className="mb-4 flex justify-end empty:mb-0">
          <OrgSwitcher />
        </div>
        {/* Finance's Payouts / Receipts / Refunds, Bookings' Counter, Settings' Premium. */}
        <SectionTabs items={nav} pathname={pathname} />
        {children}
      </OrgProvider>
    </AppShell>
  );
}

export default function OrganizerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (isPrintRoute(pathname)) {
    return (
      <RequireAuth
        roles={['ORGANIZER_OWNER', 'ORGANIZER_MANAGER', 'CHECKIN_STAFF', 'ADMIN', 'SUPER_ADMIN']}
        roleMismatchRedirect="/start"
      >
        <OrgProvider>{children}</OrgProvider>
      </RequireAuth>
    );
  }

  return (
    <RequireAuth
      roles={['ORGANIZER_OWNER', 'ORGANIZER_MANAGER', 'CHECKIN_STAFF', 'ADMIN', 'SUPER_ADMIN']}
      // A signed-in account without an organizer role is not an intruder, it is somebody who
      // has not created their organization yet — the step that grants the role. Sending them
      // there beats telling them their account cannot access the area that would fix it.
      roleMismatchRedirect="/start"
    >
      <OrganizerChrome>{children}</OrganizerChrome>
    </RequireAuth>
  );
}
