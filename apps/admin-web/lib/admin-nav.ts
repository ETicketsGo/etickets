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
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * The admin console's navigation, grouped by the job an operator is doing.
 *
 * ── WHY IT WAS REGROUPED ───────────────────────────────────────────────────────────
 * The previous groups were named after what the screens ARE ("Marketplace", "Money",
 * "Providers"), so the refund queue and the chargeback queue sat in one long "Money" list with
 * the reports and the reconciliation console, and "Pricing rules" and "Providers" were two
 * groups for one kind of work: changing how the platform is configured. An operator starting a
 * shift thinks in jobs - approve what is waiting, answer what customers raised, make sure the
 * money moved - so the groups now name the jobs, in the order a shift usually takes them.
 *
 * ── GROUPED, NEVER HIDDEN ──────────────────────────────────────────────────────────
 * Every admin route is still here, and every group starts open. A group can be folded by the
 * person using it (the choice is remembered on their device), but nothing is folded on their
 * behalf: an admin uses half of these once a month, and a menu that hides what you have not used
 * is a menu you cannot learn. `admin-nav.test.ts` holds every page under `app/admin` to having a
 * way in from here.
 *
 * ── PERMISSIONS ARE NOT DECIDED HERE ───────────────────────────────────────────────
 * Showing a link is not granting access. Each route keeps its own guard on the API, and each page
 * already says when the signed-in duties do not cover it. This file changes where things are
 * found, never who may open them.
 */

export interface AdminNavLink {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Active only on this exact path, not on paths below it. */
  exact?: boolean;
}

export interface AdminNavGroup {
  /** Stable id, used for the remembered fold state. Never shown. */
  key: string;
  /** Null for the ungrouped top entry. */
  label: string | null;
  links: AdminNavLink[];
}

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    key: 'overview',
    label: 'Overview',
    links: [
      { label: 'Dashboard', href: '/admin', exact: true, icon: LayoutDashboard },
      { label: 'Business reports', href: '/admin/reports', icon: BarChart3 },
    ],
  },
  {
    key: 'events',
    label: 'Events',
    links: [
      /*
        "Approval queue", because that is what the page opens on: the event list's default filter
        is "Under review". Every other status is one filter away on the same page.
      */
      { label: 'Approval queue', href: '/admin/events', icon: ClipboardCheck },
      { label: 'Calendar', href: '/admin/calendar', icon: CalendarRange },
      { label: 'Movies', href: '/admin/movies', icon: Film },
    ],
  },
  {
    key: 'organizers',
    label: 'Organizers & verification',
    links: [{ label: 'Organizers', href: '/admin/organizers', icon: Building2 }],
  },
  {
    key: 'bookings',
    label: 'Bookings & payments',
    links: [
      { label: 'Bookings', href: '/admin/bookings', icon: Receipt },
      { label: 'Payments', href: '/admin/payments', icon: CreditCard },
      { label: 'Accounts', href: '/admin/users', icon: Users },
    ],
  },
  {
    key: 'refunds',
    label: 'Refunds & disputes',
    links: [
      { label: 'Refunds', href: '/admin/refunds', icon: RotateCcw },
      /*
        A chargeback is a dispute raised through the card network, with a provider deadline on
        each one - it sits with refunds because both are a customer asking for money back.
      */
      { label: 'Chargebacks', href: '/admin/disputes', icon: ShieldAlert },
      { label: 'Support & complaints', href: '/admin/support', icon: LifeBuoy },
    ],
  },
  {
    key: 'payouts',
    label: 'Payouts & reconciliation',
    links: [
      { label: 'Payouts', href: '/admin/payouts', icon: Banknote },
      { label: 'Settlements', href: '/admin/settlements', icon: Landmark },
      { label: 'Finance reconciliation', href: '/admin/finance-reconciliation', icon: Scale },
    ],
  },
  {
    key: 'alerts',
    label: 'Operational alerts',
    links: [{ label: 'Operations', href: '/admin/ops', icon: Activity }],
  },
  {
    key: 'audit',
    label: 'Audit history',
    links: [{ label: 'Audit log', href: '/admin/audit', icon: ScrollText }],
  },
  {
    key: 'config',
    label: 'Platform configuration',
    links: [
      { label: 'Booking fees', href: '/admin/settings', icon: Percent },
      { label: 'Tax rules', href: '/admin/tax-rules', icon: Percent },
      { label: 'Cinema pricing', href: '/admin/cinema-pricing', icon: Percent },
      { label: 'Payment config', href: '/admin/payment-config', icon: SlidersHorizontal },
      { label: 'Merchant onboarding', href: '/admin/merchant-onboarding', icon: Store },
      { label: 'Env promotion', href: '/admin/payment-promotion', icon: GitBranch },
      { label: 'Staff & duties', href: '/admin/staff', icon: ShieldCheck },
      { label: 'AI console', href: '/admin/ai', icon: Sparkles },
    ],
  },
];

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

/** The group holding the current page; it is shown open even if the person folded it. */
export function activeGroupKey(pathname: string, nav: AdminNavGroup[] = ADMIN_NAV): string | null {
  const href = activeHref(pathname, nav);
  if (!href) return null;
  return nav.find((g) => g.links.some((l) => l.href === href))?.key ?? null;
}

const FOLD_KEY = 'etg_admin_nav_folded';

/** Folded group keys, from this device. Storage can throw in a private window. */
export function readFolded(): string[] {
  try {
    if (typeof window === 'undefined') return [];
    const raw = window.localStorage.getItem(FOLD_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function writeFolded(keys: string[]): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(FOLD_KEY, JSON.stringify(keys));
  } catch {
    /* a fold that cannot be remembered is not worth failing the console over */
  }
}
