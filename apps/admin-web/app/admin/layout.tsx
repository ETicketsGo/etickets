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
  ShieldCheck,
  ScrollText,
  Percent,
  Film,
  LifeBuoy,
  Activity,
  BarChart3,
  SlidersHorizontal,
  Store,
  GitBranch,
  Scale,
  Landmark,
  Sparkles,
} from 'lucide-react';

/*
  ── TWENTY-THREE ITEMS IN ONE LIST IS NOT A MENU ───────────────────────────────────
  The admin sidebar was a flat list, so finding anything meant reading all of it, and two
  screens that answer the same question ("what does this platform add to a ticket price")
  sat six items apart. The organizer console solved this a while ago with groups; this uses
  the same mechanism.

  Grouped, never hidden. An admin uses half of these once a month, and a menu that hides
  what you have not used is a menu you cannot learn.
*/
const nav: NavItem[] = [
  { label: 'Dashboard', href: '/admin', exact: true, icon: LayoutDashboard },

  { group: 'Marketplace', label: 'Organizers', href: '/admin/organizers', icon: Building2 },
  { label: 'Events', href: '/admin/events', icon: CalendarDays },
  { label: 'Movies', href: '/admin/movies', icon: Film },
  { label: 'Bookings', href: '/admin/bookings', icon: Receipt },
  { label: 'Accounts', href: '/admin/users', icon: Users },

  { group: 'Money', label: 'Payments', href: '/admin/payments', icon: CreditCard },
  { label: 'Refunds', href: '/admin/refunds', icon: RotateCcw },
  { label: 'Payouts', href: '/admin/payouts', icon: Banknote },
  { label: 'Settlements', href: '/admin/settlements', icon: Landmark },
  { label: 'Finance Recon', href: '/admin/finance-reconciliation', icon: Scale },
  { label: 'Reports', href: '/admin/reports', icon: BarChart3 },

  /*
    What the platform charges, in one group. "Settings" held the booking-fee bands and
    nothing else, which told nobody what was inside it - and the tax and cinema-pricing
    rules that decide the rest of the same number were elsewhere entirely.
  */
  { group: 'Pricing rules', label: 'Booking fees', href: '/admin/settings', icon: Percent },
  { label: 'Tax rules', href: '/admin/tax-rules', icon: Percent },
  { label: 'Cinema pricing', href: '/admin/cinema-pricing', icon: Percent },

  {
    group: 'Providers',
    label: 'Payment Config',
    href: '/admin/payment-config',
    icon: SlidersHorizontal,
  },
  { label: 'Merchant Onboarding', href: '/admin/merchant-onboarding', icon: Store },
  { label: 'Env Promotion', href: '/admin/payment-promotion', icon: GitBranch },

  { group: 'Platform', label: 'Staff & duties', href: '/admin/staff', icon: ShieldCheck },
  { label: 'Support', href: '/admin/support', icon: LifeBuoy },
  { label: 'Audit', href: '/admin/audit', icon: ScrollText },
  { label: 'Operations', href: '/admin/ops', icon: Activity },
  { label: 'AI Console', href: '/admin/ai', icon: Sparkles },
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
