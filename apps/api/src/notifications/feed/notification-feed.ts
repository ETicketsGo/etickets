/**
 * The notification centre as an organizer reads it: grouped by what to do, folded by cause.
 *
 * ── WHY A READ MODEL AND NOT A REWRITE OF THE ROWS ─────────────────────────────────
 * The inbox listed one row per stored notification. When the same fault was reported more
 * than once - per showtime by an earlier producer, again whenever the set of faults beside it
 * changed - the page showed the same sentence over and over, and the organizer had to compare
 * dozens of rows to discover they were one problem with one fix.
 *
 * Folding them here, at read time, leaves every stored row exactly as it was written. Those
 * rows are the record of what the platform told somebody and when; merging or deleting them
 * to tidy a screen would destroy the only evidence of it. The grouping is a view.
 *
 * ── WHY THIS FILE IS PURE ──────────────────────────────────────────────────────────
 * Every rule about what folds into what lives here, with no database and no clock, so the
 * tests can state "eighteen shows, one cause, one card" directly and a change to the rule
 * is a change to one function.
 */

/** The sections of the page, in the order they are shown. Unknown types land in the last. */
export const FEED_CATEGORIES = [
  'ACTION_REQUIRED',
  'BOOKINGS_AND_SALES',
  'EVENT_APPROVALS',
  'PAYMENTS_AND_PAYOUTS',
  'CUSTOMER_ACTIVITY',
  'SYSTEM_UPDATES',
] as const;
export type FeedCategory = (typeof FEED_CATEGORIES)[number];

export const FEED_CATEGORY_LABEL: Record<FeedCategory, string> = {
  ACTION_REQUIRED: 'Action required',
  BOOKINGS_AND_SALES: 'Bookings and sales',
  EVENT_APPROVALS: 'Event approvals',
  PAYMENTS_AND_PAYOUTS: 'Payments and payouts',
  CUSTOMER_ACTIVITY: 'Customer activity',
  SYSTEM_UPDATES: 'System updates',
};

/**
 * Which section a type belongs to.
 *
 * Keyed on the type as a string rather than the enum, because the point of the fallback is
 * the type nobody has classified yet: a new notification must still appear somewhere, and
 * "System updates" is the honest place for something we have not thought about.
 */
const CATEGORY_OF: Record<string, FeedCategory> = {
  // Something is broken and the organizer is the one who can, or must, act.
  EVENT_NOT_SELLABLE: 'ACTION_REQUIRED',
  TRANSFER_FAILED: 'ACTION_REQUIRED',
  PAYMENT_DISPUTE_OPENED: 'ACTION_REQUIRED',

  BOOKING_CONFIRMED: 'BOOKINGS_AND_SALES',
  BOOKING_CANCELLED: 'BOOKINGS_AND_SALES',
  SHOW_CANCELLED: 'BOOKINGS_AND_SALES',
  SHOW_CHANGED: 'BOOKINGS_AND_SALES',
  REFUND_COMPLETED: 'BOOKINGS_AND_SALES',
  PAYMENT_FAILED: 'BOOKINGS_AND_SALES',

  EVENT_APPROVED: 'EVENT_APPROVALS',
  EVENT_REJECTED: 'EVENT_APPROVALS',
  EVENT_SUBMITTED: 'EVENT_APPROVALS',
  ORGANIZATION_APPROVED: 'EVENT_APPROVALS',
  ORGANIZATION_REJECTED: 'EVENT_APPROVALS',
  ORGANIZATION_REGISTERED: 'EVENT_APPROVALS',

  SETTLEMENT_RELEASED: 'PAYMENTS_AND_PAYOUTS',
  PAYOUT_ACCOUNT_UPDATED: 'PAYMENTS_AND_PAYOUTS',
  PAYMENT_DISPUTE_CLOSED: 'PAYMENTS_AND_PAYOUTS',

  REFUND_REQUESTED: 'CUSTOMER_ACTIVITY',
  TICKET_CHECKED_IN: 'CUSTOMER_ACTIVITY',
  TICKET_TRANSFERRED: 'CUSTOMER_ACTIVITY',
  ATTENDEE_INVITED: 'CUSTOMER_ACTIVITY',
  ATTENDEE_ACCEPTED: 'CUSTOMER_ACTIVITY',
  ATTENDEE_DECLINED: 'CUSTOMER_ACTIVITY',
  SHARE_CREATED: 'CUSTOMER_ACTIVITY',
  SHARE_VIEWED: 'CUSTOMER_ACTIVITY',
  SHARE_REVOKED: 'CUSTOMER_ACTIVITY',
};

export function categoryOf(type: string): FeedCategory {
  return CATEGORY_OF[type] ?? 'SYSTEM_UPDATES';
}

/**
 * Severity, carried as a word as well as a colour on the page: a red dot alone says nothing
 * to somebody who cannot tell red from green.
 */
export type FeedSeverity = 'CRITICAL' | 'WARNING' | 'SUCCESS' | 'INFO';

const SEVERITY_OF: Record<string, FeedSeverity> = {
  EVENT_NOT_SELLABLE: 'CRITICAL',
  TRANSFER_FAILED: 'CRITICAL',
  PAYMENT_DISPUTE_OPENED: 'CRITICAL',
  EVENT_REJECTED: 'WARNING',
  ORGANIZATION_REJECTED: 'WARNING',
  PAYMENT_FAILED: 'WARNING',
  EVENT_APPROVED: 'SUCCESS',
  ORGANIZATION_APPROVED: 'SUCCESS',
  SETTLEMENT_RELEASED: 'SUCCESS',
  PAYMENT_DISPUTE_CLOSED: 'SUCCESS',
};

/** A stored notification, already rendered to the reader's language. */
export interface FeedSourceRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  subject: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
  /**
   * False when the type has no template and `subject`/`body` are the generic fallback - the
   * enum name and the raw payload. Omitted means templated.
   */
  templated?: boolean;
}

export interface FeedSession {
  id: string;
  startsAt: string;
  timeZone: string | null;
}

export interface FeedAction {
  label: string;
  href: string;
}

export interface FeedGroup {
  /** Stable for one cause, so the page can keep a card open across refetches. */
  key: string;
  category: FeedCategory;
  severity: FeedSeverity;
  type: string;
  title: string;
  summary: string;
  /** The longer explanation, for the "details" disclosure. Null when there is nothing more. */
  detail: string | null;
  /** Shown instead of an action when nobody the reader can reach is able to fix it. */
  ownerNote: string | null;
  action: FeedAction | null;
  eventId: string | null;
  /** Every stored notification folded into this card, newest first. */
  notificationIds: string[];
  /** The subset still unread, which is what "mark read" on the card acts on. */
  unreadIds: string[];
  read: boolean;
  firstAt: string;
  lastAt: string;
  /** Affected shows, earliest first. Empty for anything not about particular shows. */
  sessions: FeedSession[];
  /** How many shows are affected, which may exceed `sessions.length` when the list was capped. */
  affectedSessions: number;
  /**
   * Whether the cause still holds, checked live. Null when it was not or could not be checked,
   * which the page treats as "still a problem" - a stale "fixed" is the worse mistake.
   */
  resolved: boolean | null;
  /**
   * Whether the card may be put away. Never for an action that is still needed: reading about a
   * problem does not fix it, and the card is the organizer's reminder that it is still there.
   */
  dismissible: boolean;
}

/** What the live check knows about one event right now. */
export interface EventResolution {
  /** The event no longer has a problem selling: fixed, or no longer on sale at all. */
  clear: boolean;
  /** `causeIdentity()` of every blocker it has now. */
  causes: ReadonlySet<string>;
  /** The bare codes of the same, for notifications written before causes had identities. */
  codes: ReadonlySet<string>;
}

export type ResolutionLookup = (eventId: string) => EventResolution | undefined;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The short, plain statement of one cause, for the card's first line.
 *
 * The producer's own sentence is kept for the details: it is precise and occasionally long
 * ("Balcony is not mapped to a regulatory seat class, and this jurisdiction caps the price of
 * each class"). The card leads with what is wrong in words a theatre manager would use.
 */
function causeHeadline(code: string | null, subject: string | null): string | null {
  switch (code) {
    case 'SEAT_CLASS_UNMAPPED':
      return subject
        ? `${subject} seats need a regulatory seat class.`
        : 'Some seats need a regulatory seat class.';
    case 'CINEMA_NOT_CLASSIFIED':
      return 'The cinema needs its format, climate type and local body set.';
    case 'NO_PRICING_POLICY':
      return 'Ticket price rules for this area are not set up yet.';
    case 'PRICING_POLICY_CONFLICT':
      return 'Two ticket price rules for this area disagree.';
    case 'REGULATORY_PRICING_UNRESOLVED':
      return 'Ticket price rules for this area cannot be read.';
    case 'PRICE_OVER_CEILING':
      return subject
        ? `${subject} is priced above the legal maximum.`
        : 'A ticket is priced above the legal maximum.';
    case 'FREE_EVENT_HAS_PRICES':
      return subject
        ? `This is a free event, but ${subject} has a price.`
        : 'This is a free event, but a ticket has a price.';
    case 'SEATED_SESSION_HAS_NO_SEATS':
      return 'Shows use a seat map with no seats on sale.';
    case 'NO_TICKET_TYPES':
      return 'Shows have no ticket types.';
    case 'NO_SESSIONS':
      return 'The event has no show dates.';
    default:
      return null;
  }
}

/** The button label for the place that fixes a cause. */
function causeActionLabel(code: string | null): string {
  switch (code) {
    case 'SEAT_CLASS_UNMAPPED':
      return 'Map seat classes';
    case 'CINEMA_NOT_CLASSIFIED':
      return 'Classify the cinema';
    case 'PRICE_OVER_CEILING':
      return 'Fix ticket prices';
    case 'FREE_EVENT_HAS_PRICES':
      return 'Open event settings';
    case 'NO_TICKET_TYPES':
      return 'Add ticket types';
    case 'NO_SESSIONS':
      return 'Add show dates';
    default:
      return 'Open showtimes';
  }
}

/** Where the organizer goes for everything that is not an unsellable event. */
function actionFor(type: string, payload: Record<string, unknown>): FeedAction | null {
  const eventId = str(payload.eventId);
  switch (type) {
    case 'EVENT_APPROVED':
    case 'EVENT_REJECTED':
    case 'EVENT_SUBMITTED':
      return eventId ? { label: 'Open event', href: `/organizer/events/${eventId}` } : null;
    case 'ORGANIZATION_APPROVED':
    case 'ORGANIZATION_REJECTED':
      return { label: 'Open settings', href: '/organizer/settings' };
    case 'SETTLEMENT_RELEASED':
    case 'PAYOUT_ACCOUNT_UPDATED':
    case 'TRANSFER_FAILED':
    case 'PAYMENT_DISPUTE_OPENED':
    case 'PAYMENT_DISPUTE_CLOSED':
      return { label: 'Open payouts', href: '/organizer/payouts' };
    default:
      return eventId ? { label: 'Open event', href: `/organizer/events/${eventId}` } : null;
  }
}

/**
 * What makes two notifications the same card.
 *
 * For an unsellable event: the type, the event and the cause. Distinct causes stay distinct
 * cards even on one event, because they have different fixes; one cause on two events stays
 * two cards, because it is two places to go.
 *
 * Rows written before causes had an identity carry the sorted code set in `blockerCodes`
 * instead, which is still the right thing to fold them on: their reason text names the day
 * it was checked and would otherwise split one fault into one card per day.
 *
 * Everything else folds on the thing it is about - the event, dispute or settlement - so a
 * transfer retried three times is one card saying so, and two different payouts stay two.
 */
function groupKey(row: FeedSourceRow): string {
  const p = row.payload;
  if (row.type === 'EVENT_NOT_SELLABLE') {
    const cause = str(p.blockerCodes) ?? str(p.reason) ?? row.id;
    return [row.type, str(p.eventId) ?? '', cause].join('|');
  }
  const about = str(p.eventId) ?? str(p.disputeId) ?? str(p.settlementId);
  return about ? [row.type, about].join('|') : `${row.type}|id:${row.id}`;
}

/** The affected shows a row names, in either shape a producer has written them. */
function sessionsOf(payload: Record<string, unknown>): FeedSession[] {
  const out: FeedSession[] = [];
  if (Array.isArray(payload.sessions)) {
    for (const s of payload.sessions as unknown[]) {
      if (!s || typeof s !== 'object') continue;
      const o = s as Record<string, unknown>;
      const id = str(o.id);
      const startsAt = str(o.startsAt);
      if (id && startsAt) out.push({ id, startsAt, timeZone: str(o.timeZone) });
    }
  }
  // A row about one show, as a per-show producer writes it.
  const one = str(payload.eventSessionId);
  const startsAt = str(payload.startsAt);
  if (one && startsAt) out.push({ id: one, startsAt, timeZone: str(payload.timeZone) });
  return out;
}

/** Whether the fault a group reports is still there, answered from the live check. */
function resolutionOf(latest: FeedSourceRow, lookup: ResolutionLookup | undefined): boolean | null {
  const eventId = str(latest.payload.eventId);
  if (!lookup || !eventId) return null;
  const live = lookup(eventId);
  if (!live) return null;
  if (live.clear) return true;
  const cause = str(latest.payload.blockerCodes);
  if (!cause) return null;
  if (str(latest.payload.blockerCode)) return !live.causes.has(cause);
  // An older row: a "+"-joined set of bare codes. Fixed only when none of them remain.
  return !cause.split('+').some((code) => live.codes.has(code));
}

function sellabilityGroup(
  key: string,
  members: FeedSourceRow[],
  lookup: ResolutionLookup | undefined,
): FeedGroup {
  const latest = members[0];
  const p = latest.payload;
  const eventId = str(p.eventId);
  const eventTitle = str(p.eventTitle) ?? 'Your event';
  const code = str(p.blockerCode);
  const subject = str(p.subject);
  const owner = str(p.owner);

  const byId = new Map<string, FeedSession>();
  // Newest first, so a show listed twice keeps its latest known time.
  for (const m of members) {
    for (const s of sessionsOf(m.payload)) if (!byId.has(s.id)) byId.set(s.id, s);
  }
  const sessions = [...byId.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const reason = str(p.reason) ?? latest.body;
  const legacy = condenseLegacyReason(reason);
  const affected = Math.max(
    sessions.length,
    legacy?.shows ?? 0,
    ...members.map((m) => num(m.payload.affectedSessions) ?? 0),
  );

  const headline = causeHeadline(code, subject) ?? legacy?.reason ?? reason;
  const count =
    affected > 0 ? ` ${affected} ${affected === 1 ? 'showtime' : 'showtimes'} affected.` : '';
  const fix = str(p.fix);

  const resolved = resolutionOf(latest, lookup);
  const platform = owner === 'PLATFORM';
  const fixPath = str(p.fixPath);

  return {
    ...common(key, members),
    category: 'ACTION_REQUIRED',
    severity: resolved ? 'SUCCESS' : 'CRITICAL',
    type: latest.type,
    title: `${eventTitle} - Ticket sales blocked`,
    summary: `${headline}${count}`,
    detail: [reason, fix].filter(Boolean).join(' ') || null,
    ownerNote: platform
      ? 'We are fixing this. You do not need to do anything. We will tell you when it is done.'
      : null,
    // Nothing to fix once it is fixed, and the event it named may no longer exist.
    action:
      platform || resolved === true
        ? null
        : fixPath
          ? { label: causeActionLabel(code), href: fixPath }
          : eventId
            ? { label: 'Open event', href: `/organizer/events/${eventId}` }
            : null,
    eventId,
    sessions,
    affectedSessions: affected,
    resolved,
    dismissible: resolved === true,
  };
}

/**
 * Words for the organizer types that have no template yet.
 *
 * Their generic rendering is "Notification: SETTLEMENT_RELEASED" over a JSON dump, which is
 * fine as a developer's alarm in an email log and meaningless on a page an organizer reads.
 * This is the page's own wording, used only when no template exists; a real template, once
 * written, takes over without a change here.
 */
const UNTEMPLATED_COPY: Record<string, { title: string; summary: string }> = {
  SETTLEMENT_RELEASED: {
    title: 'Payout released',
    summary: 'A payout for your ticket sales has been released to your bank account.',
  },
  TRANSFER_FAILED: {
    title: 'Payout could not be sent',
    summary: 'We could not send a payout to your bank account. Check your payout details.',
  },
  PAYMENT_DISPUTE_OPENED: {
    title: 'A customer disputed a payment',
    summary: 'A customer has disputed a card payment for one of your bookings.',
  },
  PAYMENT_DISPUTE_CLOSED: {
    title: 'Payment dispute closed',
    summary: 'A disputed card payment has been decided.',
  },
  PAYOUT_ACCOUNT_UPDATED: {
    title: 'Payout account updated',
    summary: 'The bank account we pay you into has changed.',
  },
};

function plainGroup(key: string, members: FeedSourceRow[]): FeedGroup {
  const latest = members[0];
  const category = categoryOf(latest.type);
  const fallback = latest.templated === false ? UNTEMPLATED_COPY[latest.type] : undefined;
  return {
    ...common(key, members),
    category,
    severity: SEVERITY_OF[latest.type] ?? 'INFO',
    type: latest.type,
    title: fallback?.title ?? latest.subject,
    summary: fallback?.summary ?? latest.body,
    detail: null,
    ownerNote: null,
    action: actionFor(latest.type, latest.payload),
    eventId: str(latest.payload.eventId),
    sessions: [],
    affectedSessions: 0,
    resolved: null,
    // An action with no live check stays until it is read; information may always go.
    dismissible: category !== 'ACTION_REQUIRED' || members.every((m) => m.readAt),
  };
}

function common(key: string, members: FeedSourceRow[]) {
  const unreadIds = members.filter((m) => !m.readAt).map((m) => m.id);
  return {
    key,
    notificationIds: members.map((m) => m.id),
    unreadIds,
    read: unreadIds.length === 0,
    firstAt: members[members.length - 1].createdAt.toISOString(),
    lastAt: members[0].createdAt.toISOString(),
  };
}

/**
 * Fold rows into cards. `rows` may arrive in any order; members are kept newest first, and
 * the newest member speaks for the card, since it is the latest thing the platform said.
 */
export function groupNotifications(rows: FeedSourceRow[], lookup?: ResolutionLookup): FeedGroup[] {
  const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const byKey = new Map<string, FeedSourceRow[]>();
  for (const row of sorted) {
    const key = groupKey(row);
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  return [...byKey.entries()].map(([key, members]) =>
    members[0].type === 'EVENT_NOT_SELLABLE'
      ? sellabilityGroup(key, members, lookup)
      : plainGroup(key, members),
  );
}

export interface FeedSection {
  category: FeedCategory;
  label: string;
  groups: FeedGroup[];
}

/**
 * Cards into sections, in page order, leaving out the empty ones.
 *
 * Inside a section: a problem still standing before one that is fixed, unread before read,
 * then newest first. The order is the reading order - what needs the organizer comes first.
 */
export function sectionFeed(groups: FeedGroup[]): FeedSection[] {
  const rank = (g: FeedGroup) => (g.resolved === true ? 1 : 0) * 2 + (g.read ? 1 : 0);
  return FEED_CATEGORIES.map((category) => ({
    category,
    label: FEED_CATEGORY_LABEL[category],
    groups: groups
      .filter((g) => g.category === category)
      .sort((a, b) => rank(a) - rank(b) || b.lastAt.localeCompare(a.lastAt)),
  })).filter((s) => s.groups.length > 0);
}

/**
 * An older sellability message, written as one sentence per show:
 *
 *   "The show on 2026-09-07T01:31:32.952Z cannot be sold: Normal, Premium are not mapped to a
 *    regulatory seat class, ... The show on 2026-09-10T01:31:32.952Z cannot be sold: ..."
 *
 * Shown as stored, a card's summary was that whole paragraph, with raw timestamps, saying the
 * same thing once per show. This reads it back as the distinct reasons and how many shows they
 * cover, so the card says the problem once. The stored row is never changed. Null for any
 * text not in that shape, which is then shown as it is.
 */
export function condenseLegacyReason(
  text: string | null,
): { reason: string; shows: number } | null {
  if (!text) return null;
  const parts = text
    .split(/(?=The show on )/)
    .map((part) => part.trim())
    .filter(Boolean);
  const reasons: string[] = [];
  let shows = 0;
  for (const part of parts) {
    const m = /^The show on \S+ cannot be sold: ([\s\S]+)$/.exec(part);
    if (!m) return null;
    shows += 1;
    const why = m[1].trim();
    if (!reasons.includes(why)) reasons.push(why);
  }
  if (shows === 0) return null;
  const reason = reasons.join(' ');
  return { reason: reason.charAt(0).toUpperCase() + reason.slice(1), shows };
}
