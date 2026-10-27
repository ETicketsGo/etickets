import type { NavItem } from '@eticketsgo/web-kit';
import type { OrgPermissions } from '@/lib/org-permissions';
import {
  Banknote,
  BriefcaseBusiness,
  Gauge,
  Bell,
  Building2,
  CalendarDays,
  ClipboardList,
  Coins,
  Film,
  LayoutDashboard,
  LifeBuoy,
  Megaphone,
  ReceiptText,
  Rocket,
  ScanLine,
  Settings,
  Sparkles,
  Ticket,
  Undo2,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';

/**
 * The sidebar, minus anything this organization has no business with.
 *
 * ── ONE FLAT LIST ─────────────────────────────────────────────────────────────────
 * The owner rejected the folding sidebar (four collapsible groups, then a second level of
 * disclosure under Overview, Events, Bookings, Finance and Settings) as hard to navigate:
 * reaching Notifications meant opening Workspace, then Overview. It is now every top-level page
 * in a fixed order, always visible, under three non-clickable labels - Selling, Operations,
 * Business (docs/design/ORGANIZER-REGRESSION.md).
 *
 * Nothing was removed and no route changed. Secondary pages are the TABS of the page they
 * belong to (`children`, rendered by `SectionTabs`): Payouts, Receipts and invoices and Refunds
 * under Finance; Premium under Settings. Counter was a tab of Bookings and is now its own row
 * under it, because nobody found it there. Quick navigation (Ctrl/Cmd+K)
 * lists every one of them, and Get started (`sidebar: false`) too.
 *
 * "Bookings & attendees" is the find-a-booking page. Attendee lists themselves live inside
 * each event (Attendees tab), so this is the organization-wide way in, not a new page.
 * There is deliberately no "Analytics" item: no organization-wide analytics page exists, and
 * the figures the API offers are on Overview. An item that opened a page we have not built
 * would be worse than its absence.
 *
 * ── WHY FILMS IS CONDITIONAL ──────────────────────────────────────────────────────
 * Every organizer who does no film business - which is most of them - read a permanent Films
 * section as something they had failed to set up, and a 40-year promoter's first impression
 * of the console was that it was cinema software. Movies appears in the list once the
 * organization HAS a film, and the way to add a first one is a line on Venues & seating,
 * where somebody setting up a cinema already is. `/organizer/movies` still resolves, and the
 * API still decides who may read it. Navigation visibility is UX; it is not and must never
 * become the authorization.
 *
 * `movies > 0` is an imperfect signal and is knowingly used. This domain has no organization
 * type, and the `Cinema` model cannot stand in for one: every seat map requires a `Screen`
 * and every `Screen` requires a `Cinema`, so any organizer who draws a seat map for ANY event
 * creates one. A durable organization capability is the right long-term answer and is not
 * invented here.
 */
export function navFor({
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
      { label: 'Check-in', href: '/organizer/gate', exact: true, icon: ScanLine },
      { label: 'Help & support', href: '/organizer/help', icon: LifeBuoy },
    ];
  }
  return [
    { label: 'Overview', href: '/organizer', exact: true, icon: LayoutDashboard },
    /*
      Get started is NOT a sidebar row: while setup is unfinished the sidebar shows a "Finish
      setup" link at its top (and Overview links to it), and once setup is done a permanent row
      for a job done once is clutter. Quick navigation still finds it.
    */
    {
      label: 'Get started',
      href: '/organizer/onboarding',
      icon: Rocket,
      sidebar: false,
      keywords: ['setup', 'onboarding', 'checklist'],
    },

    {
      group: 'Selling',
      groupIcon: Ticket,
      label: 'Events',
      href: '/organizer/events',
      icon: Ticket,
    },
    // Every show across every event, by day and week (#279). Schedules live inside events.
    { label: 'Calendar', href: '/organizer/calendar', icon: CalendarDays },
    /*
      Venues and the spaces inside them, in one place, because they were never separable in
      practice: a concert promoter read "Cinemas" as not for them and never found the only
      route to a seat map, and two places sections meant crossing between them to set up one
      site. "Seating" is the word the owner chose for what this section unlocks; the space and
      seat-map pages behind it keep their own prefixes, so they are listed as `match` and the
      item stays marked while you are on any of them.
    */
    {
      label: 'Venues & seating',
      href: '/organizer/venues',
      icon: Building2,
      match: ['/organizer/cinemas', '/organizer/spaces'],
    },
    // Only for an organization that actually shows films. See the note above the function.
    ...(doesFilmBusiness
      ? [{ label: 'Movies', href: '/organizer/movies', icon: Film } satisfies NavItem]
      : []),

    {
      group: 'Operations',
      groupIcon: Gauge,
      /*
        The box office counter's way in. Distinct from an event's order list, which answers
        "who bought for THIS show" - a counter is holding a phone call about a booking whose
        show it does not yet know.
      */
      label: 'Bookings & attendees',
      href: '/organizer/bookings',
      icon: ClipboardList,
    },
    /*
      A sidebar row of its own, straight under Bookings. As a tab of Bookings it was found only
      through Find a page: the desk sidebar lists no secondary pages, and somebody selling at
      the door does not think of a sale as "finding a booking".
    */
    {
      label: 'Counter',
      href: '/organizer/counter',
      icon: Coins,
      keywords: ['box office', 'cash', 'walk-up', 'sell at the door', 'give back cash'],
    },
    {
      label: 'Check-in',
      href: '/organizer/gate',
      exact: true,
      icon: ScanLine,
      keywords: ['scan', 'gate', 'door'],
    },
    { label: 'Notifications', href: '/organizer/notifications', icon: Bell },
    {
      label: 'Marketing',
      keywords: ['promotions', 'coupons', 'promote', 'discount codes', 'promo codes'],
      href: '/organizer/promotions',
      icon: Megaphone,
      /*
        Followers and audience counts (aggregates only, never names), as a TAB of Marketing
        rather than a sidebar row: one more row makes the expanded sidebar scroll at a
        768px-tall window (console-navigation e2e). Quick navigation finds it by name and by
        "followers". Campaigns and analytics pages are later work and get no entry until
        they exist.
      */
      children: [
        {
          label: 'Audience & growth',
          href: '/organizer/audience',
          icon: UserPlus,
          keywords: ['followers', 'subscribers', 'fans', 'audience', 'growth'],
        },
      ],
    },

    /*
      Finance leads: it is the question an organizer opens this section with - what came in,
      what came off it, what is owed - and Payouts, Receipts and Refunds are the detail under
      it, shown as the section's tabs. The three keep their own pages; nothing moved.
    */
    {
      group: 'Business',
      groupIcon: BriefcaseBusiness,
      label: 'Finance & payouts',
      tabLabel: 'Finance',
      href: '/organizer/finance',
      icon: Wallet,
      children: [
        /*
          The words people type in Find a page. On QA "bank", "invite", "discount", "legal",
          "tax" and "theme" found nothing, though each is one of these pages' main job.
        */
        {
          label: 'Payouts',
          href: '/organizer/payouts',
          icon: Banknote,
          keywords: ['bank account', 'settlements', 'get paid', 'payout account'],
        },
        {
          label: 'Receipts and invoices',
          href: '/organizer/receipts',
          icon: ReceiptText,
          keywords: ['tax invoices', 'credit notes'],
        },
        { label: 'Refunds', href: '/organizer/refunds', icon: Undo2 },
      ],
    },
    {
      label: 'Team',
      href: '/organizer/team',
      icon: Users,
      keywords: ['invite', 'members', 'roles', 'staff'],
    },
    {
      label: 'Settings',
      href: '/organizer/settings',
      icon: Settings,
      keywords: [
        'legal details',
        'tax registration',
        'gst',
        'address',
        'profile',
        'workspace colour',
        'theme',
        'dark mode',
        'logo',
      ],
      children: [{ label: 'Premium & enterprise', href: '/organizer/premium', icon: Sparkles }],
    },
    {
      label: 'Help & support',
      href: '/organizer/help',
      icon: LifeBuoy,
      keywords: ['contact', 'support', 'faq', 'question'],
    },
  ];
}
