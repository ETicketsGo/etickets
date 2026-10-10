import {
  Activity,
  Banknote,
  BarChart3,
  Building2,
  CalendarRange,
  ClipboardCheck,
  CreditCard,
  Film,
  GitBranch,
  HandCoins,
  Landmark,
  LayoutDashboard,
  LifeBuoy,
  Percent,
  Receipt,
  RotateCcw,
  Scale,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Store,
  Ticket,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { NavItem } from '@eticketsgo/web-kit';

/**
 * The admin console's navigation, grouped by the job an operator is doing.
 *
 * ── WHY IT IS GROUPED THIS WAY ─────────────────────────────────────────────────────
 * An operator starting a shift thinks in jobs - approve what is waiting, answer what customers
 * raised, make sure the money moved - so the groups name the jobs, in the order a shift usually
 * takes them.
 *
 * ── FOLDED, AND ONLY WHAT YOU CAN OPEN ─────────────────────────────────────────────
 * The menu is rendered by the shared console shell (`AppShell` in web-kit), the same one the
 * organizer console uses: only the group holding the current page starts open, the rest are
 * one click (or one Ctrl+K search) away. Twenty-five rows in nine open groups was the "own long
 * scrollbar" the owner complained about.
 *
 * Every link names the back-office capability its page's data needs (`needs`), copied from
 * the API's `@RequiresAdmin` on the endpoint the page loads. An operator without it is not
 * shown the link, the rail flyout or the quick-navigation result: offering a moderator a
 * payouts page that answers "you may not see this" was half the admin menu for anybody who
 * is not a super admin. A super admin holds every capability (`permissionsFor`) and sees all.
 *
 * ── THIS IS NOT THE AUTHORIZATION ──────────────────────────────────────────────────
 * Hiding a link is not refusing a request. Each route keeps its own guard on the API; this
 * mirrors that guard so the menu does not lie, and `admin-nav.test.ts` holds every page under
 * `app/admin` to having a way in from here for somebody who holds its capability.
 */

export interface AdminNavLink {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Active only on this exact path, not on paths below it. */
  exact?: boolean;
  /**
   * The `AdminPermission` the page's primary load requires (the API's `@RequiresAdmin`).
   * Absent only for a page every operator can use.
   */
  needs?: string;
  /** Other words somebody might type into quick navigation. */
  keywords?: string[];
}

export interface AdminNavGroup {
  /** Stable id. Never shown. */
  key: string;
  label: string;
  /** The rail's button for the group. */
  icon: LucideIcon;
  links: AdminNavLink[];
}

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    key: 'overview',
    label: 'Overview',
    icon: LayoutDashboard,
    links: [
      /*
        No capability: the landing page leads with the operator's own queues (NeedsYou) and
        asks for the BOOKING_READ figures only when they are held, so everybody can open it.
      */
      {
        label: 'Dashboard',
        href: '/admin',
        exact: true,
        icon: LayoutDashboard,
        keywords: ['home', 'overview'],
      },
      // GET /admin/reports/* - business-reports.controller, FINANCE_READ.
      {
        label: 'Business reports',
        href: '/admin/reports',
        icon: BarChart3,
        needs: 'FINANCE_READ',
        keywords: ['analytics', 'revenue'],
      },
    ],
  },
  {
    key: 'events',
    label: 'Events',
    icon: Ticket,
    links: [
      /*
        "Approval queue", because that is what the page opens on: the event list's default filter
        is "Under review". Every other status is one filter away on the same page.
      */
      {
        label: 'Approval queue',
        href: '/admin/events',
        icon: ClipboardCheck,
        needs: 'EVENT_REVIEW',
        keywords: ['events', 'review', 'moderation'],
      },
      {
        label: 'Calendar',
        href: '/admin/calendar',
        icon: CalendarRange,
        needs: 'EVENT_REVIEW',
        keywords: ['shows', 'schedule'],
      },
      // GET /admin/movies inherits AdminController's BOOKING_READ.
      {
        label: 'Movies',
        href: '/admin/movies',
        icon: Film,
        needs: 'BOOKING_READ',
        keywords: ['films'],
      },
    ],
  },
  {
    key: 'organizers',
    label: 'Organizers & verification',
    icon: Building2,
    links: [
      // ORGANIZER_REVIEW, not ORGANIZER_READ: GET /admin/organizers is the review queue.
      {
        label: 'Organizers',
        href: '/admin/organizers',
        icon: Building2,
        needs: 'ORGANIZER_REVIEW',
        keywords: ['verification', 'kyc', 'approve'],
      },
    ],
  },
  {
    key: 'bookings',
    label: 'Bookings & payments',
    icon: Receipt,
    links: [
      {
        label: 'Bookings',
        href: '/admin/bookings',
        icon: Receipt,
        needs: 'BOOKING_READ',
        keywords: ['orders'],
      },
      { label: 'Payments', href: '/admin/payments', icon: CreditCard, needs: 'BOOKING_READ' },
      {
        label: 'Accounts',
        href: '/admin/users',
        icon: Users,
        needs: 'BOOKING_READ',
        keywords: ['users', 'customers'],
      },
    ],
  },
  {
    key: 'refunds',
    label: 'Refunds & disputes',
    icon: RotateCcw,
    links: [
      { label: 'Refunds', href: '/admin/refunds', icon: RotateCcw, needs: 'REFUND_REVIEW' },
      /*
        A chargeback is a dispute raised through the card network, with a provider deadline on
        each one - it sits with refunds because both are a customer asking for money back.
      */
      {
        label: 'Chargebacks',
        href: '/admin/disputes',
        icon: ShieldAlert,
        needs: 'FINANCE_READ',
        keywords: ['disputes'],
      },
      {
        label: 'Support & complaints',
        href: '/admin/support',
        icon: LifeBuoy,
        needs: 'BOOKING_READ',
        keywords: ['help', 'tickets'],
      },
    ],
  },
  {
    key: 'payouts',
    label: 'Payouts & reconciliation',
    icon: HandCoins,
    links: [
      { label: 'Payouts', href: '/admin/payouts', icon: Banknote, needs: 'PAYOUT_MANAGE' },
      { label: 'Settlements', href: '/admin/settlements', icon: Landmark, needs: 'PAYOUT_MANAGE' },
      {
        label: 'Finance reconciliation',
        href: '/admin/finance-reconciliation',
        icon: Scale,
        needs: 'FINANCE_READ',
        keywords: ['discrepancies'],
      },
    ],
  },
  {
    key: 'alerts',
    label: 'Operational alerts',
    icon: Activity,
    links: [
      {
        label: 'Operations',
        href: '/admin/ops',
        icon: Activity,
        needs: 'OPS_READ',
        keywords: ['health', 'queues', 'jobs', 'maintenance'],
      },
    ],
  },
  {
    key: 'audit',
    label: 'Audit history',
    icon: ScrollText,
    links: [
      {
        label: 'Audit log',
        href: '/admin/audit',
        icon: ScrollText,
        needs: 'BOOKING_READ',
        keywords: ['history'],
      },
    ],
  },
  {
    key: 'config',
    label: 'Platform configuration',
    icon: Wrench,
    links: [
      /*
        Booking fees, tax rules and cinema pricing are served by AdminController, whose class
        guard is BOOKING_READ - so that is what opens them today, and the menu says the same.
        Whether they should need PLATFORM_CONFIG is a server question, recorded in the PR.
      */
      {
        label: 'Booking fees',
        href: '/admin/settings',
        icon: Percent,
        needs: 'BOOKING_READ',
        keywords: ['fee rules', 'settings'],
      },
      {
        label: 'Tax rules',
        href: '/admin/tax-rules',
        icon: Percent,
        needs: 'BOOKING_READ',
        keywords: ['gst'],
      },
      {
        label: 'Cinema pricing',
        href: '/admin/cinema-pricing',
        icon: Percent,
        needs: 'BOOKING_READ',
        keywords: ['ceilings', 'regulated'],
      },
      {
        label: 'Payment config',
        href: '/admin/payment-config',
        icon: SlidersHorizontal,
        needs: 'PAYMENT_ADMIN',
        keywords: ['providers', 'routing', 'razorpay', 'stripe'],
      },
      {
        label: 'Merchant onboarding',
        href: '/admin/merchant-onboarding',
        icon: Store,
        needs: 'PAYMENT_ADMIN',
      },
      {
        label: 'Env promotion',
        href: '/admin/payment-promotion',
        icon: GitBranch,
        needs: 'PAYMENT_ADMIN',
        keywords: ['environment'],
      },
      {
        label: 'Staff & duties',
        href: '/admin/staff',
        icon: ShieldCheck,
        needs: 'ADMIN_MANAGE',
        keywords: ['team', 'permissions', 'roles'],
      },
      { label: 'AI console', href: '/admin/ai', icon: Sparkles, needs: 'PLATFORM_CONFIG' },
    ],
  },
];

/**
 * The menu in the shared shell's shape: one `NavItem` per link, the first of each group
 * carrying the group's name and rail icon, every one carrying its capability.
 */
export function adminNavItems(nav: AdminNavGroup[] = ADMIN_NAV): NavItem[] {
  return nav.flatMap((g) =>
    g.links.map((l, i) => ({
      label: l.label,
      href: l.href,
      icon: l.icon,
      exact: l.exact,
      capabilities: l.needs ? [l.needs] : undefined,
      keywords: l.keywords,
      ...(i === 0 ? { group: g.label, groupIcon: g.icon } : {}),
    })),
  );
}

/** Every link, flattened, in menu order. */
export function allNavLinks(nav: AdminNavGroup[] = ADMIN_NAV): AdminNavLink[] {
  return nav.flatMap((g) => g.links);
}

export function isLinkActive(pathname: string, link: Pick<AdminNavLink, 'href' | 'exact'>) {
  if (link.exact) return pathname === link.href;
  return pathname === link.href || pathname.startsWith(`${link.href}/`);
}

/**
 * The one link that is current, or null.
 *
 * The LONGEST matching href wins, so a page two levels down marks its own section and not a
 * shorter prefix of it - exactly one item carries `aria-current`, never two.
 */
export function activeHref(pathname: string, nav: AdminNavGroup[] = ADMIN_NAV): string | null {
  let best: string | null = null;
  for (const link of allNavLinks(nav)) {
    if (isLinkActive(pathname, link) && (!best || link.href.length > best.length)) {
      best = link.href;
    }
  }
  return best;
}

/** The group holding the current page; it is the one the sidebar opens. */
export function activeGroupKey(pathname: string, nav: AdminNavGroup[] = ADMIN_NAV): string | null {
  const href = activeHref(pathname, nav);
  if (!href) return null;
  return nav.find((g) => g.links.some((l) => l.href === href))?.key ?? null;
}
