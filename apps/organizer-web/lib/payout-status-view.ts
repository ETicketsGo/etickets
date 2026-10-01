import type { PayoutAccountState } from '@eticketsgo/web-kit';

/**
 * How one payout state should be PRESENTED. Not what it means - the server decided that.
 *
 * ── WHY THIS IS SEPARATE FROM THE COMPONENT ────────────────────────────────────────
 * Every claim worth testing on the payout page is a decision made here: whether a call to action
 * appears at all, what the two availability lines say, whether the journey is drawn. Keeping them
 * in JSX would mean the only way to check "UNDER_REVIEW never offers a button" is to render a
 * tree, and this console has no renderer in its test setup. A pure function is checkable
 * exhaustively, which for a page about somebody's money is worth more than a snapshot.
 *
 * ── WHAT IT MUST NEVER DO ──────────────────────────────────────────────────────────
 * It takes the server's state and nothing else. It does not see `verifiedAt`, `chargesEnabled`,
 * `payoutsEnabled`, `requirementsDue` or `disabledReason`, and must not start: a second reading
 * of those five is the thing the server model was built to stop.
 */

export type PayoutStatusTone = 'neutral' | 'waiting' | 'attention' | 'good' | 'stopped';

export interface PayoutStatusView {
  heading: string;
  tone: PayoutStatusTone;
  /** The server's own sentence, passed through untouched. */
  explanation: string;
  /** "Available" / "Not available" - the word carries the meaning, never the colour. */
  salesWord: string;
  salesAffected: boolean;
  payoutWord: string;
  payoutsAffected: boolean;
  /** A call to action appears only when the server says somebody is waiting on the organizer. */
  cta: { label: string; href: string } | null;
  /** Shown whenever there is no CTA: the absence of a button is not an answer by itself. */
  noActionNotice: string | null;
  /**
   * Where this state sits on the four-step journey, or null when it is an interruption.
   *
   * ACTION_REQUIRED and RESTRICTED deliberately get null: a progress bar beside them would say
   * everything is advancing normally when it has stopped.
   */
  journeyStep: number | null;
}

const HEADING: Record<PayoutAccountState['code'], { heading: string; tone: PayoutStatusTone }> = {
  NO_ACCOUNT: { heading: 'No payout account yet', tone: 'neutral' },
  DETAILS_REQUIRED: { heading: 'Your payout details are unfinished', tone: 'attention' },
  UNDER_REVIEW: { heading: 'Under review', tone: 'waiting' },
  ACTION_REQUIRED: { heading: 'Your payment provider needs something', tone: 'attention' },
  RESTRICTED: { heading: 'Payout account stopped', tone: 'stopped' },
  VERIFIED: { heading: 'Bank account verified', tone: 'good' },
  PAYOUTS_ENABLED: { heading: 'Payouts are active', tone: 'good' },
};

/** The four steps an account walks when nothing interrupts it. */
export const PAYOUT_JOURNEY = ['Account details', 'Review', 'Verified', 'Payouts enabled'];
const JOURNEY_POSITION: Partial<Record<PayoutAccountState['code'], number>> = {
  NO_ACCOUNT: 0,
  DETAILS_REQUIRED: 0,
  UNDER_REVIEW: 1,
  VERIFIED: 2,
  PAYOUTS_ENABLED: 3,
};

export function payoutStatusView(state: PayoutAccountState): PayoutStatusView {
  const look = HEADING[state.code];
  return {
    heading: look.heading,
    tone: look.tone,
    explanation: state.explanation,
    salesAffected: state.salesAffected,
    salesWord: state.salesAffected ? 'Not available' : 'Available',
    payoutsAffected: state.payoutsAffected,
    /*
      "Not ready yet" rather than "Not available". Payouts that are merely waiting are the common
      case, and telling somebody their payouts are unavailable when they are simply being checked
      is the wrong fact.
    */
    payoutWord: state.payoutsAffected ? 'Not ready yet' : 'Available',
    cta:
      state.organizerActionRequired && state.action
        ? { label: state.action.label, href: state.action.href }
        : null,
    noActionNotice:
      state.organizerActionRequired && state.action
        ? null
        : 'No action is required from you right now.',
    journeyStep: JOURNEY_POSITION[state.code] ?? null,
  };
}
