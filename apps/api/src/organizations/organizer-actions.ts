import {
  organizationReadiness,
  type ReadinessItem,
  type ReadinessInput,
} from './organization-readiness';

/**
 * Everything an organizer still has to do, as one list.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────────
 * The console grew three to-do surfaces that did not know about each other:
 *
 *   "Needs your attention"  - `organizationReadiness()`, server-side, facts about the business.
 *   "Finish setting up"     - `useOnboardingProgress()`, CLIENT-side, derived from four list
 *                             endpoints, about things you have built.
 *   "Get started"           - the same client hook again, rendered as a page.
 *
 * They were never duplicates in the way it looked: the first asks "what do we still not know
 * about you", the second asks "have you built what you need to sell". Both are real questions.
 * What WAS duplicated was exactly one item - can you be paid - computed two different ways, with
 * two different phrasings and two different completion rules.
 *
 * ── WHAT THIS DOES ─────────────────────────────────────────────────────────────────
 * It composes. `organizationReadiness` is called, not reimplemented; its items keep their keys,
 * their titles and their consequence sentences, which are the best copy in the product. The
 * operational checks move here from the client so that completion is decided once, on the server,
 * and the duplicated payout item is dropped in favour of readiness's own - which is the stricter
 * and better-worded of the two.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────────────
 * It does not touch event sellability. Whether a particular event can be sold is answered by
 * `SellabilityIssue[]` against that event, and it must stay that way: an organization with an
 * unfinished profile can still have a perfectly sellable event, and a complete profile does not
 * make an event with an unmapped seat class sellable. They share a presentation shape here and
 * nothing else. A test asserts no organization action is ever scoped to an event.
 */

export type OrganizerActionCategory =
  /** Facts about the business: identity, address, contacts. */
  | 'BUSINESS'
  /** Getting paid. */
  | 'MONEY'
  /** Things to build before selling: a venue, a room, an event, a team. */
  | 'OPERATIONS';

export type OrganizerActionSeverity = 'BLOCKING' | 'IMPORTANT' | 'SUGGESTED';

export interface OrganizerAction {
  /** Stable, so a surface can link or filter without matching on prose. */
  key: string;
  category: OrganizerActionCategory;
  severity: OrganizerActionSeverity;
  /** Organization-wide, or about one event. Only ever ORGANIZATION from this composer. */
  scope: 'ORGANIZATION' | 'EVENT';
  organizationId: string;
  eventId?: string;
  /**
   * Whether something is actually prevented.
   *
   * Separate from severity on purpose: readiness calls an item BLOCKING when the organizer
   * cannot be paid or approved, which is not the same as "you cannot sell". Nothing here stops a
   * sale, and saying otherwise to force completion would be a lie the product tells.
   */
  blocking: boolean;
  title: string;
  /** What it costs until it is done. Never "this is required" with no reason. */
  consequence: string;
  /** Where to fix it, relative to the organizer console. */
  fixPath: string;
  /** What the control says. */
  actionLabel: string;
  done: boolean;
  /**
   * Shown but not counted against completion.
   *
   * Reserved seating is not something every organizer needs - a promoter selling standing tickets
   * is finished without ever drawing a seat map, and a checklist telling them they are 4-of-5
   * done is lying to make a feature look important.
   */
  optional?: boolean;
}

/** What the operational half needs, counted by the caller's queries. */
export interface OperationalFacts {
  venueCount: number;
  /** Rooms that could actually host reserved seating - the same list the seating picker uses. */
  seatingRoomCount: number;
  /** Members beyond the sole owner. */
  teamMemberCount: number;
  publishedEventCount: number;
}

/** Which readiness keys belong to which category. Everything else is about the business. */
const MONEY_KEYS = new Set(['payout-account']);

function categoryOf(item: ReadinessItem): OrganizerActionCategory {
  return MONEY_KEYS.has(item.key) ? 'MONEY' : 'BUSINESS';
}

/**
 * A readiness gap, as an action.
 *
 * `done` is always false: readiness only ever returns what is MISSING, so an item being present
 * in that list is the same statement as it not being done. Inventing completed readiness rows
 * here would mean re-deriving the checks it already made.
 */
function fromReadiness(organizationId: string, item: ReadinessItem): OrganizerAction {
  return {
    key: item.key,
    category: categoryOf(item),
    severity: item.severity,
    scope: 'ORGANIZATION',
    organizationId,
    // Nothing readiness reports stops a sale. It stops payment, approval or a document.
    blocking: false,
    title: item.title,
    consequence: item.consequence,
    fixPath: item.fixPath,
    actionLabel: 'Fix this',
    done: false,
  };
}

/**
 * The operational checks, moved off the client.
 *
 * The CLIENT used to decide these from four list endpoints, which meant the dashboard and the
 * Get-started page could disagree with each other the moment one of their queries was stale. The
 * questions are unchanged and so is their wording.
 *
 * The payouts step is deliberately absent. It asked "can this organization be paid" using
 * `canSellPaidTickets`, while readiness asked the same question from `hasPayoutAccount` - one
 * question, two answers. Readiness keeps it, because its phrasing says what the gap costs.
 */
function operational(organizationId: string, facts: OperationalFacts): OrganizerAction[] {
  return [
    {
      key: 'venue',
      category: 'OPERATIONS',
      severity: 'IMPORTANT',
      scope: 'ORGANIZATION',
      organizationId,
      blocking: false,
      title: 'Add your first venue',
      consequence: 'An event happens somewhere. Without a venue there is nowhere to put one.',
      // `?new=1` opens the form on arrival: this pointed at the page it was rendered on, so the
      // button appeared to do nothing.
      fixPath: facts.venueCount > 0 ? '/organizer/venues' : '/organizer/venues?new=1',
      actionLabel: facts.venueCount > 0 ? 'Manage venues' : 'Add venue',
      done: facts.venueCount > 0,
    },
    {
      key: 'seating',
      category: 'OPERATIONS',
      severity: 'SUGGESTED',
      scope: 'ORGANIZATION',
      organizationId,
      blocking: false,
      title: 'Set up a room with a seat map',
      consequence: 'Only needed if buyers should pick their own seats.',
      fixPath: '/organizer/venues',
      actionLabel: facts.seatingRoomCount > 0 ? 'Manage rooms' : 'Set up a room',
      done: facts.seatingRoomCount > 0,
      optional: true,
    },
    {
      key: 'team',
      category: 'OPERATIONS',
      severity: 'SUGGESTED',
      scope: 'ORGANIZATION',
      organizationId,
      blocking: false,
      title: 'Invite a team member',
      consequence: 'Managers and check-in staff can work without your login.',
      fixPath: '/organizer/team',
      actionLabel: facts.teamMemberCount > 0 ? 'Manage team' : 'Invite',
      done: facts.teamMemberCount > 0,
    },
    {
      key: 'experience',
      category: 'OPERATIONS',
      severity: 'IMPORTANT',
      scope: 'ORGANIZATION',
      organizationId,
      blocking: false,
      title: 'Create and publish an experience',
      consequence: 'Nothing can be sold until an event is published.',
      fixPath: '/organizer/events',
      actionLabel: facts.publishedEventCount > 0 ? 'View events' : 'Create event',
      done: facts.publishedEventCount > 0,
    },
  ];
}

export interface OrganizerActionSummary {
  organizationId: string;
  actions: OrganizerAction[];
  /** Counted over the items that bear on completion: optional ones are shown, never counted. */
  progress: { done: number; total: number };
  counts: { blocking: number; important: number; suggested: number };
}

/**
 * One list, from the readiness gaps and the operational facts.
 *
 * Order is deliberate: what is missing about the business comes before what has not been built,
 * because the first is what stops an organizer being paid or approved and the second is work they
 * can see for themselves.
 */
export function organizerActions(
  organizationId: string,
  readinessInput: ReadinessInput,
  facts: OperationalFacts,
): OrganizerActionSummary {
  const actions = [
    ...organizationReadiness(readinessInput).map((item) => fromReadiness(organizationId, item)),
    ...operational(organizationId, facts),
  ];
  const counted = actions.filter((a) => !a.optional);
  return {
    organizationId,
    actions,
    progress: { done: counted.filter((a) => a.done).length, total: counted.length },
    counts: {
      blocking: actions.filter((a) => !a.done && a.severity === 'BLOCKING').length,
      important: actions.filter((a) => !a.done && a.severity === 'IMPORTANT').length,
      suggested: actions.filter((a) => !a.done && a.severity === 'SUGGESTED').length,
    },
  };
}
