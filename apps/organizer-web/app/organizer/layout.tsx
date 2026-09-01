'use client';

import { AppShell, RequireAuth, type NavItem } from '@eticketsgo/web-kit';
import {
  CalendarDays,
  LayoutDashboard,
  Banknote,
  Coins,
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

const nav: NavItem[] = [
  { label: 'Dashboard', href: '/organizer', exact: true, icon: LayoutDashboard },
  { label: 'Get started', href: '/organizer/onboarding', icon: Rocket },
  { label: 'Events', href: '/organizer/events', icon: CalendarDays },
  { label: 'Movies', href: '/organizer/movies', icon: Film },
  /*
    Named for what an organizer comes here to do, not for the row type underneath.

    This section was called "Cinemas", and it is the ONLY route to a seat map. A concert
    promoter reading a fourteen-item sidebar sees "Cinemas", correctly concludes it is not
    for them, and never finds the thing that makes reserved seating possible — which is
    exactly the report that prompted this. The rows really are cinemas in the database
    (`Cinema` owns `Screen`, and a screen owns the seat map), and the film-specific pages
    inside still speak of cinemas and screens because there they are accurate.
  */
  { label: 'Rooms & seat maps', href: '/organizer/cinemas', icon: Building2 },
  // A distinct icon from Payouts: the two sit three rows apart and mean opposite
  // things — money you hold in a tin, and money the platform sends you.
  { label: 'Counter', href: '/organizer/counter', icon: Coins },
  { label: 'Promotions', href: '/organizer/promotions', icon: TicketPercent },
  { label: 'Payouts', href: '/organizer/payouts', icon: Banknote },
  { label: 'Receipts', href: '/organizer/receipts', icon: ReceiptText },
  { label: 'Refunds', href: '/organizer/refunds', icon: Undo2 },
  { label: 'Notifications', href: '/organizer/notifications', icon: Bell },
  { label: 'Team', href: '/organizer/team', icon: Users },
  { label: 'Premium', href: '/organizer/premium', icon: Sparkles },
  { label: 'Help', href: '/organizer/help', icon: LifeBuoy },
  { label: 'Settings', href: '/organizer/settings', icon: Settings },
];

export default function OrganizerLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth
      roles={['ORGANIZER_OWNER', 'ORGANIZER_MANAGER', 'CHECKIN_STAFF', 'ADMIN', 'SUPER_ADMIN']}
      // A signed-in account without an organizer role is not an intruder, it is somebody who
      // has not created their organization yet — the step that grants the role. Sending them
      // there beats telling them their account cannot access the area that would fix it.
      roleMismatchRedirect="/start"
    >
      <AppShell brand="Organizer" nav={nav}>
        <OrgProvider>
          <div className="mb-4 flex justify-end">
            <OrgSwitcher />
          </div>
          {children}
        </OrgProvider>
      </AppShell>
    </RequireAuth>
  );
}
