/**
 * An event's navigation: seven sections, and the pages inside each.
 *
 * ── WHY SECTIONS, NOT A LONGER ROW ─────────────────────────────────────────────────
 * The event area had eleven pages, fifteen once offline check-in is on, rendered as one row of
 * equally weighted tabs. Grouping labels between clusters helped reading but not reaching: the
 * row was wider than the screen at every width - 253px of it was hidden even at 1440 - so
 * Reports and Assistant sat behind a horizontal scroll nobody knew was there.
 *
 * Seven sections fit. Each answers one question an organizer arrives with ("are the tickets
 * right", "who has booked", "how do I run the door"), and a section with more than one page
 * shows its pages as a second row only while you are in it.
 *
 * ── ROUTES DID NOT MOVE ────────────────────────────────────────────────────────────
 * Every page keeps its URL. This file decides what the navigation SAYS, never where a page
 * lives, so every deep link and every "Fix this" link elsewhere in the console still resolves.
 *
 * Kept free of React and icons so the mapping can be tested as data.
 */

export interface EventPage {
  /** Path after `/organizer/events/<id>`; '' is the overview. */
  seg: string;
  label: string;
  /**
   * The offline check-in consoles. Their endpoints 404 unless the organization has offline
   * check-in on, so they are offered only then.
   */
  offline?: boolean;
}

export interface EventSection {
  key: string;
  label: string;
  pages: EventPage[];
}

export const EVENT_SECTIONS: readonly EventSection[] = [
  { key: 'overview', label: 'Overview', pages: [{ seg: '', label: 'Overview' }] },
  {
    /*
      What is on sale, when, and in which seats. Sessions lead because a ticket type belongs to
      a session - the Tickets page says "Add a session first" until one exists. The labels keep
      the words the pages themselves use ("Add session", "the Tickets tab" in Help).
    */
    key: 'tickets',
    label: 'Tickets & seating',
    pages: [
      { seg: '/sessions', label: 'Sessions' },
      /*
        Seating sits beside the sessions it describes. It was the half of "Tickets & seating"
        nobody could find: the section was named for it and had no page about it.
      */
      { seg: '/seating', label: 'Seating' },
      { seg: '/tickets', label: 'Tickets' },
      { seg: '/commerce', label: 'Add-ons & bundles' },
    ],
  },
  {
    // Who has bought, and who is coming.
    key: 'bookings',
    label: 'Bookings & attendees',
    pages: [
      { seg: '/orders', label: 'Orders' },
      { seg: '/attendees', label: 'Attendees' },
    ],
  },
  { key: 'promotion', label: 'Promotion', pages: [{ seg: '/promote', label: 'Promote' }] },
  {
    /*
      The door, online and offline. Reconciliation sits here rather than with bookings: it
      reconciles offline GATE SCANS against the server, which is the same job as the rest of
      this section done after the network comes back - not a view of who bought.
    */
    key: 'checkin',
    label: 'Check-in',
    pages: [
      { seg: '/checkin', label: 'Check-in' },
      { seg: '/command-center', label: 'Command center', offline: true },
      { seg: '/devices', label: 'Devices', offline: true },
      { seg: '/preflight', label: 'Preflight', offline: true },
      { seg: '/reconciliation', label: 'Reconciliation', offline: true },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    pages: [
      { seg: '/reports', label: 'Report' },
      { seg: '/assistant', label: 'Assistant' },
    ],
  },
  { key: 'settings', label: 'Settings', pages: [{ seg: '/edit', label: 'Event details' }] },
];

/** The page segment of a pathname under `base`: '' for the overview, '/tickets', and so on. */
export function segmentOf(pathname: string, base: string): string | null {
  const path = pathname.replace(/\/+$/, '');
  if (path === base) return '';
  if (!path.startsWith(`${base}/`)) return null;
  // Only the first segment names the page; anything deeper still belongs to it.
  return `/${path.slice(base.length + 1).split('/')[0]}`;
}

/** Which section and page a pathname is on. Null when it is not an event page we know. */
export function resolveEventLocation(
  pathname: string,
  base: string,
): { section: EventSection; page: EventPage } | null {
  const seg = segmentOf(pathname, base);
  if (seg === null) return null;
  for (const section of EVENT_SECTIONS) {
    const page = section.pages.find((p) => p.seg === seg);
    if (page) return { section, page };
  }
  return null;
}

/**
 * The sections as they should be offered, given whether offline check-in is on.
 *
 * The page somebody is ON is always kept, even an offline console with the flag off (or not
 * yet known): reaching one by link and finding no trace of it in the navigation reads as being
 * lost. A section never ends up empty - every section has at least one ordinary page.
 */
export function visibleSections(
  offlineEnabled: boolean,
  currentSeg: string | null,
): EventSection[] {
  return EVENT_SECTIONS.map((section) => ({
    ...section,
    pages: section.pages.filter((p) => !p.offline || offlineEnabled || p.seg === currentSeg),
  }));
}
