'use client';

import { AppShell, RequireAuth, type NavItem } from '@eticketsgo/web-kit';
import {
  CalendarDays,
  LayoutDashboard,
  Banknote,
  Users,
  Settings,
  Sparkles,
  Film,
  Building2,
} from 'lucide-react';
import { OrgProvider, OrgSwitcher } from '@/components/org-context';

const nav: NavItem[] = [
  { label: 'Dashboard', href: '/organizer', exact: true, icon: LayoutDashboard },
  { label: 'Events', href: '/organizer/events', icon: CalendarDays },
  { label: 'Movies', href: '/organizer/movies', icon: Film },
  { label: 'Cinemas', href: '/organizer/cinemas', icon: Building2 },
  { label: 'Payouts', href: '/organizer/payouts', icon: Banknote },
  { label: 'Team', href: '/organizer/team', icon: Users },
  { label: 'Premium', href: '/organizer/premium', icon: Sparkles },
  { label: 'Settings', href: '/organizer/settings', icon: Settings },
];

export default function OrganizerLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth
      roles={['ORGANIZER_OWNER', 'ORGANIZER_MANAGER', 'CHECKIN_STAFF', 'ADMIN', 'SUPER_ADMIN']}
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
