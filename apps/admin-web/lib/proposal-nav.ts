import {
  Activity,
  BarChart3,
  Building2,
  CalendarRange,
  ClipboardCheck,
  CreditCard,
  Film,
  Gauge,
  HandCoins,
  Inbox,
  KeyRound,
  Landmark,
  LifeBuoy,
  Percent,
  Receipt,
  RotateCcw,
  Scale,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  Wrench,
} from 'lucide-react';
import { adminNavItems, type AdminNavGroup } from './admin-nav';

/**
 * PROPOSAL (docs/design/ADMIN-PROPOSAL.md) - the admin console's navigation, regrouped.
 *
 * ── SIX GROUPS, NAMED BY THE QUESTION ──────────────────────────────────────────────
 * Today's menu has nine groups (`admin-nav.ts`), four of them holding one page each, and
 * "Platform configuration" holding eight unrelated ones including staff permissions. The
 * proposal is six groups an operator can say out loud - Today, Review, Customers, Money,
 * Platform, Access - each holding the queue first and the reference pages after it.
 *
 * Links that the prototype has redrawn point at `/proposal/...`; every other link still opens
 * the live page under `/admin`, so the prototype is clickable end to end without copying
 * pages it does not change. Capabilities are the same ones `admin-nav.ts` names (the API's
 * `@RequiresAdmin`), so the menu still never offers a page its viewer cannot open.
 */
export const PROPOSAL_NAV: AdminNavGroup[] = [
  {
    key: 'today',
    label: 'Today',
    icon: Gauge,
    links: [{ label: 'Overview', href: '/proposal', exact: true, icon: Gauge, keywords: ['home'] }],
  },
  {
    key: 'review',
    label: 'Review',
    icon: ClipboardCheck,
    links: [
      {
        label: 'Event approvals',
        href: '/proposal/approvals',
        icon: ClipboardCheck,
        needs: 'EVENT_REVIEW',
        keywords: ['moderation', 'events'],
      },
      {
        label: 'Organizer approvals',
        href: '/admin/organizers?status=PENDING',
        icon: Building2,
        needs: 'ORGANIZER_REVIEW',
        keywords: ['verification', 'kyc'],
      },
      { label: 'Calendar', href: '/admin/calendar', icon: CalendarRange, needs: 'EVENT_REVIEW' },
      { label: 'Movies', href: '/admin/movies', icon: Film, needs: 'BOOKING_READ' },
    ],
  },
  {
    key: 'customers',
    label: 'Customers',
    icon: LifeBuoy,
    links: [
      { label: 'Support inbox', href: '/admin/support', icon: Inbox, needs: 'BOOKING_READ' },
      {
        label: 'Booking lookup',
        href: '/admin/bookings',
        icon: Receipt,
        needs: 'BOOKING_READ',
        keywords: ['orders', 'reference'],
      },
      { label: 'Refund desk', href: '/admin/refunds', icon: RotateCcw, needs: 'REFUND_REVIEW' },
      {
        label: 'Chargebacks',
        href: '/admin/disputes',
        icon: ShieldAlert,
        needs: 'FINANCE_READ',
        keywords: ['disputes'],
      },
      { label: 'Accounts', href: '/admin/users', icon: Users, needs: 'BOOKING_READ' },
    ],
  },
  {
    key: 'money',
    label: 'Money',
    icon: HandCoins,
    links: [
      {
        label: 'Reconciliation',
        href: '/proposal/reconciliation',
        icon: Scale,
        needs: 'FINANCE_READ',
        keywords: ['discrepancies'],
      },
      { label: 'Payments', href: '/admin/payments', icon: CreditCard, needs: 'BOOKING_READ' },
      { label: 'Payouts', href: '/admin/payouts', icon: HandCoins, needs: 'PAYOUT_MANAGE' },
      { label: 'Settlements', href: '/admin/settlements', icon: Landmark, needs: 'PAYOUT_MANAGE' },
      { label: 'Reports', href: '/admin/reports', icon: BarChart3, needs: 'FINANCE_READ' },
    ],
  },
  {
    key: 'platform',
    label: 'Platform',
    icon: Wrench,
    links: [
      { label: 'Health and jobs', href: '/admin/ops', icon: Activity, needs: 'OPS_READ' },
      {
        label: 'Fees, tax and pricing',
        href: '/admin/settings',
        icon: Percent,
        needs: 'PLATFORM_CONFIG_READ',
        keywords: ['tax', 'gst', 'cinema pricing'],
      },
      {
        label: 'Payment setup',
        href: '/admin/payment-config',
        icon: SlidersHorizontal,
        needs: 'PAYMENT_ADMIN',
        keywords: ['razorpay', 'stripe', 'merchant'],
      },
    ],
  },
  {
    key: 'access',
    label: 'Access',
    icon: ShieldCheck,
    links: [
      {
        label: 'Staff and security',
        href: '/proposal/security',
        icon: ShieldCheck,
        needs: 'ADMIN_MANAGE',
        keywords: ['mfa', 'grants', 'team'],
      },
      { label: 'Audit log', href: '/admin/audit', icon: ScrollText, needs: 'BOOKING_READ' },
      { label: 'My sign-in', href: '/admin/security', icon: KeyRound, keywords: ['mfa'] },
    ],
  },
];

export const proposalNavItems = () => adminNavItems(PROPOSAL_NAV);
