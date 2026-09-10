'use client';

import { usePathname } from 'next/navigation';
import { AppShell, RequireAuth, type NavItem } from '@eticketsgo/web-kit';
import {
  CalendarDays,
  LayoutDashboard,
  Banknote,
  Coins,
  Ticket,
  Users,
  Settings,
  Sparkles,
  Film,
  Building2,
  Rocket,
  LifeBuoy,
  TicketPercent,
  Bell,
  ReceiptText,
  Undo2,
} from 'lucide-react';
import { OrgProvider, OrgSwitcher } from '@/components/org-context';
import { ColorSchemeSwitch, WorkspaceTheme, useWorkspace } from '@/components/workspace-chrome';

const nav: NavItem[] = [
  { label: 'Dashboard', href: '/organizer', exact: true, icon: LayoutDashboard },
  { label: 'Get started', href: '/organizer/onboarding', icon: Rocket },

  { group: 'Selling', label: 'Events', href: '/organizer/events', icon: CalendarDays },
  /*
    Venues sits with Events because that is the relationship: every event happens at one. It
    had no page at all until now — a venue could only be created mid-wizard and never
    edited, while its name printed on every listing a customer saw.
  */
  /*
    Venues and rooms, in one place, because they were never separable in practice.

    "Cinemas" became "Rooms & seat maps" after a concert promoter read the sidebar, concluded
    correctly that cinemas were not for them, and so never found the only route to a seat map.
    The rename fixed the word and left the real problem: this was a SECOND places section
    beside "Venues", and setting up one site meant crossing between them.

    Worse, creating a room with no venue makes one, named after the room — so an organizer
    could see the same name in both lists as two unrelated things, with nothing to explain it.

    One entry, then, and "rooms" kept in the label because that is the word that made seat
    maps findable. The film-specific pages inside still say cinema and screen, where those
    words are accurate.
  */
  { label: 'Venues & rooms', href: '/organizer/venues', icon: Building2 },
  /*
    The box office counter's way in. Distinct from an event's order list, which answers "who
    bought for THIS show" — a counter is holding a phone call about a booking whose show it
    does not yet know.
  */
  { label: 'Find a booking', href: '/organizer/bookings', icon: Ticket },
  // A distinct icon from Payouts: they sit near each other and mean opposite things —
  // money you hold in a tin, and money the platform sends you.
  { label: 'Counter', href: '/organizer/counter', icon: Coins },
  { label: 'Promotions', href: '/organizer/promotions', icon: TicketPercent },

  /*
    Films get their own heading rather than being hidden when unused.

    Most organizers never show one, and an unexplained "Movies" among fifteen siblings reads
    as something they have failed to set up. Hiding it until an organization has a film is
    the obvious fix and the wrong one: a cinema operator on day one would have nowhere to
    add their first. A heading says "skip this unless it is yours" and stays findable.
  */
  { group: 'Films', label: 'Movies', href: '/organizer/movies', icon: Film },

  { group: 'Money', label: 'Payouts', href: '/organizer/payouts', icon: Banknote },
  { label: 'Receipts', href: '/organizer/receipts', icon: ReceiptText },
  { label: 'Refunds', href: '/organizer/refunds', icon: Undo2 },

  { group: 'Account', label: 'Notifications', href: '/organizer/notifications', icon: Bell },
  { label: 'Team', href: '/organizer/team', icon: Users },
  { label: 'Premium', href: '/organizer/premium', icon: Sparkles },
  { label: 'Help', href: '/organizer/help', icon: LifeBuoy },
  { label: 'Settings', href: '/organizer/settings', icon: Settings },
];

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
 * The organizer's own masthead, their palette, and their team's chrome.
 *
 * Split out from the layout because it reads the workspace, and the layout's job is to decide
 * whether there should be chrome at all (a print route gets none).
 */
function OrganizerChrome({ children }: { children: React.ReactNode }) {
  const workspace = useWorkspace();
  return (
    <AppShell
      brand="Organizer"
      nav={nav}
      workspace={{ name: workspace.name, logoUrl: workspace.logoUrl }}
      headerAccessory={<ColorSchemeSwitch />}
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
