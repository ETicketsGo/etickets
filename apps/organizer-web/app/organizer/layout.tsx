'use client';

import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  AppShell,
  ColorSchemeSwitch,
  NotificationsButton,
  RequireAuth,
  api,
} from '@eticketsgo/web-kit';
import { navFor } from '@/components/organizer-nav';
import { OrgProvider, OrgSwitcher } from '@/components/org-context';
import { WorkspaceTheme, useWorkspace } from '@/components/workspace-chrome';

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
  return <NotificationsButton href="/organizer/notifications" unread={data?.unreadCount} />;
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
  return (
    <AppShell
      brand="Organizer"
      nav={nav}
      workspace={{ name: workspace.name, logoUrl: workspace.logoUrl }}
      headerAccessory={<ColorSchemeSwitch />}
      accountRole={workspace.roleLabel}
      notifications={<OrganizerNotifications />}
      /*
        The console's one primary action, for the members who can create events. Check-in
        staff cannot, and are not offered it - the same rule their sidebar follows.
      */
      primaryAction={
        workspace.can.financials || workspace.can.ownerActions
          ? { label: 'Create event', href: '/organizer/events/new' }
          : null
      }
      // Organizer pages are tables, schedules and seat maps; the frame should not be what
      // squeezes them. Forms and prose keep their own measure inside it - see AppShell.
      width="fluid"
    >
      <WorkspaceTheme />
      <OrgProvider>
        <div className="mb-4 flex justify-end empty:mb-0">
          <OrgSwitcher />
        </div>
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
