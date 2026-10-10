import type { BadgeTone, OrganizerAction } from '@eticketsgo/web-kit';
import { saleStateLabel, type EventSaleState, type SaleStateKind } from '@eticketsgo/shared-types';
import { saleTone } from '../../../lib/sale-state';

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
 *   2. Selling:      "Selling" | "Partly selling: <reason>" | "Not selling: <reason>"
 *                    (the server's unified sale state, which already weighs the status)
 *   3. Setup:        "Setup complete" | "<n> things to set up"  (the organization's actions)
 *
 * "Selling" is only ever said when the server has answered SELLING. Until it answers, the
 * honest word is "Checking", never "Selling".
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
  /** The server's state; null while it has not answered or could not be read. */
  state: SaleStateKind | null;
  /** "Selling", "Partly selling: <reason>", "Not selling: <reason>", or why there is no answer. */
  label: string;
  /** The server's full sentence for the lead reason, when there is one. */
  detail?: string;
  tone: BadgeTone;
}

/**
 * The server's unified sale state for a show or an event, in the console's words.
 *
 * Nothing is worked out here any more. This file used to combine the event status, the show's
 * clock, sold and capacity, the configuration check and checkout's eligibility rule into its
 * own "selling" - and said "Not selling: 1 problem to fix" about a Vijayawada show the cinema
 * workspace called "Selling" and checkout was selling. The API now makes that judgement once
 * (`GET /organizer-calendar/sale-eligibility` per show, `.../event-sale-eligibility` per event,
 * both from `sale-state.ts` in shared-types) and every screen reads it. A PARTIAL answer is
 * never shown as bare "Selling"; no answer is never shown as "Selling" either.
 */
export function sellingOf(
  answer: Pick<EventSaleState, 'state' | 'reasons'> | undefined,
  failed = false,
): Selling {
  if (!answer)
    return {
      state: null,
      label: failed ? 'Sales status unavailable' : 'Checking sales',
      tone: 'neutral',
    };
  const lead = answer.reasons[0];
  return {
    state: answer.state,
    label: saleStateLabel(answer),
    tone: saleTone(answer),
    ...(answer.state !== 'SELLING' && lead ? { detail: lead.message } : {}),
  };
}

export function sellingTone(s: Selling): BadgeTone {
  return s.tone;
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
