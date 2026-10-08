'use client';

import { usePathname } from 'next/navigation';
import type { OrgPermissions } from '@/lib/org-permissions';
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
  ScanLine,
  TicketPercent,
  Bell,
  ReceiptText,
  Undo2,
  Wallet,
} from 'lucide-react';
import { OrgProvider, OrgSwitcher } from '@/components/org-context';
import { ColorSchemeSwitch, WorkspaceTheme, useWorkspace } from '@/components/workspace-chrome';

/**
 * The sidebar, minus anything this organization has no business with.
 *
 * ── WHY FILMS IS CONDITIONAL NOW ───────────────────────────────────────────────────
 * It used to be a permanent top-level heading, on the reasoning that hiding it would leave a
 * cinema operator with nowhere to add their first film. That reasoning was right about the risk
 * and wrong about the remedy: every organizer who does no film business - which is most of them -
 * read a whole section of the product as something they had failed to set up, and a 40-year
 * promoter's first impression of the console was that it was cinema software.
 *
 * The remedy keeps the discoverability without the permanent section: Films appears once the
 * organization HAS a film, and the way to add a first one is a line on Venues & rooms, where
 * somebody setting up a cinema already is. Nothing is hidden that anyone can use - `/organizer/
 * movies` still resolves, and the API still decides who may read it. Navigation visibility is
 * UX; it is not and must never become the authorization.
 *
 * `movies > 0` is an imperfect signal and is knowingly used. This domain has no organization
 * type, and the `Cinema` model cannot stand in for one - though not because it is the room.
 * `Screen` is the room; `Cinema` is the SITE. It is unusable as a film signal because every seat
 * map requires a `Screen` and every `Screen` requires a `Cinema`, so any organizer who draws a
 * seat map for ANY event creates one. Seated events made `Cinema` mean "a seated venue". A
 * durable organization capability is the right long-term answer and is not invented here.
 */
function navFor({
  doesFilmBusiness,
  can,
}: {
  doesFilmBusiness: boolean;
  can: OrgPermissions;
}): NavItem[] {
  /*
    Check-in staff get the gate and nothing else.

    Their whole job is a scanner. The console offered them eighteen sections - Finance,
    Payouts, Receipts, Refunds, Team, Settings among them - every one of which the API
    refuses, and asked them to find Check-in inside an events list. A temporary worker on
    their first shift, at a door with a queue forming, was navigating a finance console.

    This is UX, not authorization: the API refuses those routes whether or not they are
    listed, and a separate change tightened the one place it did not.
  */
  if (!can.financials && !can.ownerActions) {
    return [
      { label: 'Gate', href: '/organizer/gate', exact: true, icon: ScanLine },
      { label: 'Help', href: '/organizer/help', icon: LifeBuoy },
    ];
  }
  return [
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

    One entry, then. The label said "rooms" for a while, because that was the word that made
    seat maps findable once "Cinemas" had driven a concert promoter away. It now says SPACES,
    which is the platform's word for a bookable area inside a venue - it keeps what that
    rename was protecting (nothing film-specific in the sidebar) and matches what the pages
    behind it, the API and the seating model all call the thing. The film-specific pages
    inside still say cinema and screen, where those words are accurate.
  */
    { label: 'Venues & spaces', href: '/organizer/venues', icon: Building2 },
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

    // Only for an organization that actually shows films. See the note above the function.
    ...(doesFilmBusiness
      ? [{ group: 'Films', label: 'Movies', href: '/organizer/movies', icon: Film } as NavItem]
      : []),

    /*
      Finance leads the Money group: it is the question an organizer opens this section with -
      what came in, what came off it, what is owed - and Payouts, Receipts and Refunds are the
      detail under it. The three keep their own pages; nothing moved.
    */
    { group: 'Money', label: 'Finance', href: '/organizer/finance', icon: Wallet },
    { label: 'Payouts', href: '/organizer/payouts', icon: Banknote },
    { label: 'Receipts', href: '/organizer/receipts', icon: ReceiptText },
    { label: 'Refunds', href: '/organizer/refunds', icon: Undo2 },

    { group: 'Account', label: 'Notifications', href: '/organizer/notifications', icon: Bell },
    { label: 'Team', href: '/organizer/team', icon: Users },
    { label: 'Premium', href: '/organizer/premium', icon: Sparkles },
    { label: 'Help', href: '/organizer/help', icon: LifeBuoy },
    { label: 'Settings', href: '/organizer/settings', icon: Settings },
  ].filter(Boolean) as NavItem[];
}

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
