import type {
  BadgeTone,
  EventSellability,
  OrganizerAction,
  OrganizerSessionSaleEligibility,
} from '@eticketsgo/web-kit';

/**
 * The three separate questions the Overview answers about an event, kept separate.
 *
 * ── WHY THREE, AND NEVER ONE ───────────────────────────────────────────────────────
 * The console said "Ready to sell" for a DRAFT event. Nothing could be bought: a draft is not
 * on the storefront. The sentence came from asking only "is the configuration complete", and
 * reading the answer as "can somebody buy this". Those are different questions, and so is a
 * third one, where the event is in its life:
 *
 *   1. Lifecycle:    Draft -> In review -> Published -> Ended / Cancelled  (the event's status)
 *   2. Selling:      "Selling" | "Not selling: <reason>"  (status AND the server's sale check)
 *   3. Setup:        "Setup complete" | "<n> things to set up"  (the organization's actions)
 *
 * "Selling" is only ever said when the event is PUBLISHED, the show is still ahead and not
 * full, and BOTH server checks have answered with nothing in the way: the configuration check
 * (sellability) and checkout's own sale-eligibility rules. Until both answer the honest word
 * is "Checking", never "Selling".
 *
 * Every rule here is a reading of fields the API returns; nothing is inferred from colour,
 * counted twice, or guessed. `status.test.ts` pins the rules, draft-is-never-selling first.
 */

/** The lifecycle word for an event status, in the console's one vocabulary. */
export function lifecycleLabel(status: string): string {
  switch (status) {
    case 'DRAFT':
      return 'Draft';
    case 'UNDER_REVIEW':
      return 'In review';
    case 'PUBLISHED':
    case 'SOLD_OUT':
      // Sold out is a sales fact about a published event, said by the selling line.
      return 'Published';
    case 'PAUSED':
      return 'Paused';
    case 'CANCELLED':
      return 'Cancelled';
    case 'COMPLETED':
      return 'Ended';
    case 'ARCHIVED':
      return 'Archived';
    default:
      return status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ');
  }
}

export function lifecycleTone(status: string): BadgeTone {
  if (status === 'PUBLISHED' || status === 'SOLD_OUT') return 'success';
  if (status === 'UNDER_REVIEW' || status === 'PAUSED') return 'warning';
  if (status === 'CANCELLED') return 'error';
  return 'neutral';
}

export interface Selling {
  /** True only when somebody could buy right now; null while the server has not answered. */
  selling: boolean | null;
  /** "Selling", "Checking sales" or "Not selling: <plain reason>". */
  label: string;
  /** The server's full sentence for a refusal, when there is one. */
  detail?: string;
}

const not = (reason: string): Selling => ({ selling: false, label: `Not selling: ${reason}` });

/** Why an event in this status is not on sale, or null when its status allows selling. */
function statusReason(eventStatus: string): string | null {
  switch (eventStatus) {
    case 'PUBLISHED':
      return null;
    case 'DRAFT':
      return 'draft, not submitted';
    case 'UNDER_REVIEW':
      return 'waiting for review';
    case 'PAUSED':
      return 'paused';
    case 'SOLD_OUT':
      return 'sold out';
    case 'CANCELLED':
      return 'cancelled';
    case 'COMPLETED':
    case 'ARCHIVED':
      return 'ended';
    default:
      return 'not published';
  }
}

/** The blockers that stop THIS show: ones naming it, and ones that belong to no show at all. */
function blockersFor(sellability: EventSellability, sessionId?: string) {
  return sellability.blockers.filter((b) => {
    if (!sessionId) return true;
    const sessions = b.sessions;
    // An older API without `sessions`, or a fault with none: it is about the whole event.
    if (!sessions || sessions.length === 0)
      return !b.eventSessionId || b.eventSessionId === sessionId;
    return sessions.some((s) => s.id === sessionId);
  });
}

function blockerReason(count: number): string {
  return count === 1 ? '1 problem to fix' : `${count} problems to fix`;
}

/**
 * A few words for a sale-eligibility refusal, for the chip. The server's full sentence for the
 * organizer travels with it as `detail` and is shown beside the chip, never thrown away.
 */
const ELIGIBILITY_REASON: Record<string, string> = {
  NO_PRICING_POLICY: 'no state price rules yet',
  PRICING_POLICY_CONFLICT: 'state price rules need correcting',
  REGULATORY_PRICING_UNRESOLVED: 'state price rules cannot be applied',
  CINEMA_NOT_CLASSIFIED: 'cinema type not on record',
  SEAT_CLASS_UNMAPPED: 'seat class not mapped',
  PRICE_OVER_CEILING: 'price over the state limit',
};

/** What one show needs to be judged: its own state, plus the two server checks. */
export interface ShowSaleInput {
  sessionStatus: string;
  startsAt: string;
  sold: number | null;
  capacity: number | null;
  sessionId: string;
  /** `GET /events/:id/sellability`: is the event configured so a sale can be made. */
  sellability: EventSellability | undefined;
  /**
   * `GET /organizer-calendar/sale-eligibility`: would checkout sell this show NOW, by the
   * sale-eligibility rules it refuses a cart by (#280) - state price rules, seat classes,
   * ceilings. The configuration check above does not ask these, which is how a Telangana
   * cinema show with no state price rules read "Selling" while every checkout refused it.
   */
  eligibility: OrganizerSessionSaleEligibility | undefined;
  now?: Date;
}

/**
 * Whether ONE SHOW is selling: its event is published, the show is scheduled and has not
 * started (sales close when the show starts), it has places left, checkout's own eligibility
 * rules would sell it, and no configuration blocker names it.
 *
 * Both server checks must have answered. Either one missing is "Checking sales", never
 * "Selling".
 */
export function sessionSelling(input: ShowSaleInput & { eventStatus: string }): Selling {
  const reason = statusReason(input.eventStatus);
  if (reason) return not(reason);
  if (input.sessionStatus === 'CANCELLED') return not('show cancelled');
  if (input.sessionStatus === 'PAUSED') return not('show paused');
  if (input.sessionStatus === 'COMPLETED') return not('show ended');
  if (Date.parse(input.startsAt) <= (input.now ?? new Date()).getTime())
    return not('show has started');
  if (input.capacity && input.sold != null && input.sold >= input.capacity) return not('sold out');
  if (!input.sellability || !input.eligibility) return { selling: null, label: 'Checking sales' };
  if (!input.eligibility.open) {
    const first = input.eligibility.blockers[0];
    return {
      ...not((first && ELIGIBILITY_REASON[first.code]) ?? 'checkout would refuse it'),
      detail: first?.message,
    };
  }
  const blockers = blockersFor(input.sellability, input.sessionId);
  if (blockers.length > 0)
    return { ...not(blockerReason(blockers.length)), detail: blockers[0].message };
  return { selling: true, label: 'Selling' };
}

/**
 * Whether an EVENT is selling, judged by its next show.
 *
 * `next` is undefined while the shows are loading, and null when the event has no show in the
 * window the Overview reads. A show further out may well be on sale, so that is said as a
 * fact about dates - never as "Selling", and never as "Not selling".
 */
export function eventSelling(
  eventStatus: string,
  next: ShowSaleInput | null | undefined,
  horizonDays: number,
): Selling {
  const reason = statusReason(eventStatus);
  if (reason) return not(reason);
  if (next === undefined) return { selling: null, label: 'Checking sales' };
  if (next === null) return { selling: null, label: `No shows in the next ${horizonDays} days` };
  return sessionSelling({ ...next, eventStatus });
}

export function sellingTone(s: Selling): BadgeTone {
  return s.selling === true ? 'success' : s.selling === null ? 'neutral' : 'warning';
}

export interface SetupSummary {
  /** Things that actually stop something today. Shown prominently, never folded away. */
  blockers: OrganizerAction[];
  /** Everything else still to do, most important first. Folded into a compact checklist. */
  todo: OrganizerAction[];
  /** How many non-optional steps are still open (blockers included). */
  open: number;
  /** "Setup complete" or "<n> things to set up". */
  label: string;
}

const SEVERITY_ORDER = { BLOCKING: 0, IMPORTANT: 1, SUGGESTED: 2 } as const;

/**
 * The organization's setup, split into what blocks and what is merely recommended.
 *
 * The old Overview put every open item - a bank account nobody can be paid without and a
 * profile picture alike - in one tall red-bordered card above everything else, so the page
 * opened on a compliance checklist. A genuine blocker still leads the page; the rest is one
 * line that opens into the list.
 */
export function setupSummary(actions: OrganizerAction[] | undefined): SetupSummary {
  const openActions = (actions ?? []).filter((a) => !a.done);
  const isBlocker = (a: OrganizerAction) => a.blocking || a.severity === 'BLOCKING';
  const blockers = openActions.filter(isBlocker);
  const todo = openActions
    .filter((a) => !isBlocker(a))
    .sort(
      (a, b) =>
        Number(!!a.optional) - Number(!!b.optional) ||
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
  const open = openActions.filter((a) => !a.optional).length;
  return {
    blockers,
    todo,
    open,
    label:
      open === 0 ? 'Setup complete' : open === 1 ? '1 thing to set up' : `${open} things to set up`,
  };
}
