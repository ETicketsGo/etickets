'use client';

import { AppShell, RequireAuth, type NavItem } from '@eticketsgo/web-kit';
import {
  LayoutDashboard,
  Building2,
  CalendarDays,
  Receipt,
  CreditCard,
  RotateCcw,
  Banknote,
  Users,
  ScrollText,
  Settings,
  Film,
  LifeBuoy,
  Activity,
} from 'lucide-react';

const nav: NavItem[] = [
  { label: 'Dashboard', href: '/admin', exact: true, icon: LayoutDashboard },
  { label: 'Organizers', href: '/admin/organizers', icon: Building2 },
  { label: 'Events', href: '/admin/events', icon: CalendarDays },
  { label: 'Movies', href: '/admin/movies', icon: Film },
  { label: 'Bookings', href: '/admin/bookings', icon: Receipt },
  { label: 'Payments', href: '/admin/payments', icon: CreditCard },
  { label: 'Refunds', href: '/admin/refunds', icon: RotateCcw },
  { label: 'Payouts', href: '/admin/payouts', icon: Banknote },
  { label: 'Users', href: '/admin/users', icon: Users },
  { label: 'Support', href: '/admin/support', icon: LifeBuoy },
  { label: 'Audit', href: '/admin/audit', icon: ScrollText },
  { label: 'Operations', href: '/admin/ops', icon: Activity },
  { label: 'Settings', href: '/admin/settings', icon: Settings },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth roles={['ADMIN', 'SUPER_ADMIN']}>
      <AppShell brand="Admin" nav={nav}>
        {children}
      </AppShell>
    </RequireAuth>
  );
}
