import {
  Activity,
  BadgePercent,
  Banknote,
  BarChart3,
  Building2,
  CalendarClock,
  CalendarRange,
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  Film,
  GitBranch,
  Handshake,
  KanbanSquare,
  HandCoins,
  Landmark,
  LayoutDashboard,
  LifeBuoy,
  MessageSquareText,
  Percent,
  KeyRound,
  Mail,
  Receipt,
  ReceiptText,
  RotateCcw,
  Scale,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Store,
  Target,
  Ticket,
  UserRoundSearch,
  Users,
  UsersRound,
  Wallet,
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
  /**
   * Further capabilities the page ALSO needs, when the API requires several (all-of), e.g. an
   * acquisition manager page that needs CRM_AGENT and CRM_MANAGER.
   */
  alsoNeeds?: string[];
  /** Other words somebody might type into quick navigation. */
  keywords?: string[];
  /** The section's own pages, folded under it in the menu and shown as tabs on each page. */
  children?: AdminNavLink[];
  /** This link's name as the first tab of its section, where `label` would repeat it. */
  tabLabel?: string;
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
        tabLabel: 'Review queue',
        href: '/admin/organizers',
        icon: Building2,
        needs: 'ORGANIZER_REVIEW',
        keywords: ['verification', 'kyc', 'approve'],
        /*
          Organizer email campaigns: what goes out under the platform's name, the bounce and
          complaint rates, and the brake. A tab of Organizers, not a menu row, for the same
          768px menu-height reason as Organizer Acquisition. Reading is ORGANIZER_READ; the
          pause control also needs ORGANIZER_REVIEW and is hidden from a reader.
        */
        children: [
          {
            label: 'Email campaigns',
            href: '/admin/campaigns',
            icon: Mail,
            needs: 'ORGANIZER_READ',
            keywords: ['campaigns', 'marketing email', 'bounces', 'complaints', 'spam'],
          },
        ],
      },
      /*
        Organizer Acquisition, the sales desk: prospects the platform would like to sell for.
        A SECTION of this group rather than a group of its own: one more group heading made the
        expanded menu taller than a 768px window (console-navigation e2e). Its pages fold under
        it, show as tabs on each page, and quick navigation finds every one.

        Every page needs CRM_AGENT (GET /admin/crm/*); Team Performance and Reports also need
        CRM_MANAGER, as their API does. An operator holding neither sees none of it.
      */
      {
        label: 'Organizer Acquisition',
        tabLabel: 'Overview',
        href: '/admin/acquisition',
        icon: Target,
        needs: 'CRM_AGENT',
        keywords: ['crm', 'sales', 'acquisition', 'prospects', 'leads'],
        children: [
          {
            label: 'Prospects',
            href: '/admin/acquisition/prospects',
            icon: UserRoundSearch,
            needs: 'CRM_AGENT',
            keywords: ['leads', 'crm', 'import', 'export'],
          },
          {
            label: 'Pipeline',
            href: '/admin/acquisition/pipeline',
            icon: KanbanSquare,
            needs: 'CRM_AGENT',
            keywords: ['stages', 'funnel', 'crm'],
          },
          {
            label: 'Follow-ups',
            href: '/admin/acquisition/follow-ups',
            icon: CalendarClock,
            needs: 'CRM_AGENT',
            keywords: ['tasks', 'overdue', 'crm'],
          },
          {
            label: 'Activities',
            href: '/admin/acquisition/activities',
            icon: MessageSquareText,
            needs: 'CRM_AGENT',
            keywords: ['calls', 'outreach', 'crm'],
          },
          {
            label: 'Team Performance',
            href: '/admin/acquisition/team',
            icon: UsersRound,
            needs: 'CRM_AGENT',
            alsoNeeds: ['CRM_MANAGER'],
            keywords: ['agents', 'interns', 'crm team'],
          },
          {
            label: 'Reports',
            href: '/admin/acquisition/reports',
            icon: Handshake,
            needs: 'CRM_AGENT',
            alsoNeeds: ['CRM_MANAGER'],
            keywords: ['india', 'usa', 'conversion', 'crm reports'],
          },
        ],
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
      /*
        Organizer billing: the platform's own plans for organizers, not ticket money. A SECTION
        here rather than a group of its own, for the same 768px menu-height reason as
        Organizer Acquisition. Every page loads GET /admin/billing/* (BILLING_READ); the write
        controls on each page also need BILLING_MANAGE, BILLING_ADJUST or ENTITLEMENT_GRANT
        and are hidden from a reader (`useHolds`). An account page (/admin/billing/accounts/...)
        is reached from the subscriptions list and the overview's search box.
      */
      {
        label: 'Billing & subscriptions',
        tabLabel: 'Overview',
        href: '/admin/billing',
        icon: Wallet,
        needs: 'BILLING_READ',
        keywords: ['plans', 'pricing', 'subscriptions', 'mrr', 'arr', 'trials', 'credits'],
        children: [
          {
            label: 'Plans & prices',
            href: '/admin/billing/plans',
            icon: ReceiptText,
            needs: 'BILLING_READ',
            keywords: ['plans', 'pricing', 'catalogue', 'entitlements'],
          },
          {
            label: 'Subscriptions',
            href: '/admin/billing/subscriptions',
            icon: ClipboardList,
            needs: 'BILLING_READ',
            keywords: ['trials', 'complimentary', 'organizer plans'],
          },
        ],
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
      // GET /admin/audit needs AUDIT_READ: it left BOOKING_READ, the support desk's floor.
      {
        label: 'Audit log',
        href: '/admin/audit',
        icon: ScrollText,
        needs: 'AUDIT_READ',
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
        Booking fees, tax rules and cinema pricing each declare their own guard on the API:
        PLATFORM_CONFIG_READ to read, PLATFORM_CONFIG to change. They used to inherit
        AdminController's BOOKING_READ, which let the support desk edit them. The page opens
        with the read capability; its edit controls also need PLATFORM_CONFIG (see
        `lib/capabilities.ts`).
      */
      {
        label: 'Booking fees',
        href: '/admin/settings',
        icon: Percent,
        needs: 'PLATFORM_CONFIG_READ',
        keywords: ['fee rules', 'settings'],
        /*
          Platform fee policies: exceptions to the fee schedule for one event or one organizer
          (waive, fixed, percentage). A page of Booking fees rather than a row of its own: one
          more top-level row made this group taller than a 768px window (console-navigation
          e2e). GET /admin/platform-fee-policies needs PLATFORM_CONFIG_READ; creating and
          deactivating need PLATFORM_CONFIG and a fresh MFA code.
        */
        children: [
          {
            label: 'Platform fee policies',
            href: '/admin/fee-policies',
            icon: BadgePercent,
            needs: 'PLATFORM_CONFIG_READ',
            keywords: ['fee waiver', 'waive fee', 'fee override', 'promotion', 'finance'],
          },
        ],
      },
      {
        label: 'Tax rules',
        href: '/admin/tax-rules',
        icon: Percent,
        needs: 'PLATFORM_CONFIG_READ',
        keywords: ['gst'],
      },
      {
        label: 'Cinema pricing',
        href: '/admin/cinema-pricing',
        icon: Percent,
        needs: 'PLATFORM_CONFIG_READ',
        // Its page links to Cinema legal types (local body, format, cooling), which has no menu
        // entry of its own; these words find it from quick navigation.
        keywords: ['ceilings', 'regulated', 'legal type', 'local body', 'multiplex'],
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
  {
    /*
      Every operator's own sign-in security (authenticator, recovery codes). No capability: it
      is about the caller's own account, so it is never hidden and never refused.
    */
    key: 'account',
    label: 'My account',
    icon: KeyRound,
    links: [
      {
        label: 'Account security',
        href: '/admin/security',
        icon: KeyRound,
        keywords: ['mfa', 'authenticator', 'two-factor', 'recovery codes', 'password'],
      },
    ],
  },
];

/**
 * The menu in the shared shell's shape: one `NavItem` per link, the first of each group
 * carrying the group's name and rail icon, every one carrying its capability.
 */
export function adminNavItems(nav: AdminNavGroup[] = ADMIN_NAV): NavItem[] {
  const item = (l: AdminNavLink): NavItem => ({
    label: l.label,
    href: l.href,
    icon: l.icon,
    exact: l.exact,
    capabilities: l.needs ? [l.needs, ...(l.alsoNeeds ?? [])] : undefined,
    keywords: l.keywords,
    tabLabel: l.tabLabel,
    children: l.children?.map(item),
  });
  return nav.flatMap((g) =>
    g.links.map((l, i) => ({
      ...item(l),
      ...(i === 0 ? { group: g.label, groupIcon: g.icon } : {}),
    })),
  );
}

/** Every link, flattened, in menu order. */
export function allNavLinks(nav: AdminNavGroup[] = ADMIN_NAV): AdminNavLink[] {
  return nav.flatMap((g) => g.links.flatMap((l) => [l, ...(l.children ?? [])]));
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
  return nav.find((g) => allNavLinks([g]).some((l) => l.href === href))?.key ?? null;
}
