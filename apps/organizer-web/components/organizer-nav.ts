import type { NavItem } from '@eticketsgo/web-kit';
import type { OrgPermissions } from '@/lib/org-permissions';
import {
  Banknote,
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
  Users,
  Wallet,
} from 'lucide-react';

/**
 * The sidebar, minus anything this organization has no business with.
 *
 * ── FOUR GROUPS, ELEVEN DAILY PLACES, EVERYTHING ELSE ONE LEVEL DOWN ────────────────
 * The sidebar had grown to nineteen flat items under Selling / Films / Money / Account, so an
 * organizer read the whole list every time to find anything, and the things they do daily sat
 * beside things they do once a year. It is now four groups that answer four questions -
 * Workspace (what am I running), Operations (the day of the show), Business (how is it going,
 * and who works here), Account - with the pages an organizer uses every day at the top level
 * and every other existing page listed under the section it belongs to.
 *
 * Nothing was removed and no route changed. Payouts, Receipts and Refunds are under Finance;
 * Counter under Bookings; Get started and Notifications under Overview; Premium under
 * Settings. Each is still a link, still `aria-current` when open, and its section opens on
 * its own when you are on it.
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
 * of the console was that it was cinema software. Movies appears under Events once the
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
    {
      group: 'Workspace',
      label: 'Overview',
      href: '/organizer',
      exact: true,
      icon: LayoutDashboard,
      children: [
        { label: 'Get started', href: '/organizer/onboarding', icon: Rocket },
        { label: 'Notifications', href: '/organizer/notifications', icon: Bell },
      ],
    },
    /*
      The calendar page is built by its own workstream; this is only the way in. Until that
      page ships the route has no page, which is why it is listed here and not invented.
    */
    { label: 'Calendar', href: '/organizer/calendar', icon: CalendarDays },
    {
      label: 'Events',
      href: '/organizer/events',
      icon: Ticket,
      // Only for an organization that actually shows films. See the note above the function.
      children: doesFilmBusiness
        ? [{ label: 'Movies', href: '/organizer/movies', icon: Film }]
        : undefined,
    },
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

    {
      group: 'Operations',
      /*
        The box office counter's way in. Distinct from an event's order list, which answers
        "who bought for THIS show" - a counter is holding a phone call about a booking whose
        show it does not yet know.
      */
      label: 'Bookings & attendees',
      href: '/organizer/bookings',
      icon: ClipboardList,
      // A distinct icon from Payouts: money you hold in a tin, not money the platform sends.
      children: [{ label: 'Counter', href: '/organizer/counter', icon: Coins }],
    },
    { label: 'Check-in', href: '/organizer/gate', exact: true, icon: ScanLine },
    { label: 'Marketing', href: '/organizer/promotions', icon: Megaphone },

    /*
      Finance leads: it is the question an organizer opens this section with - what came in,
      what came off it, what is owed - and Payouts, Receipts and Refunds are the detail under
      it. The three keep their own pages; nothing moved.
    */
    {
      group: 'Business',
      label: 'Finance & payouts',
      href: '/organizer/finance',
      icon: Wallet,
      children: [
        { label: 'Payouts', href: '/organizer/payouts', icon: Banknote },
        { label: 'Receipts', href: '/organizer/receipts', icon: ReceiptText },
        { label: 'Refunds', href: '/organizer/refunds', icon: Undo2 },
      ],
    },
    { label: 'Team', href: '/organizer/team', icon: Users },

    {
      group: 'Account',
      label: 'Settings',
      href: '/organizer/settings',
      icon: Settings,
      children: [{ label: 'Premium', href: '/organizer/premium', icon: Sparkles }],
    },
    { label: 'Help & support', href: '/organizer/help', icon: LifeBuoy },
  ];
}
