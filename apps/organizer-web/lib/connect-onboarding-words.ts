import type { RazorpayAccountStatus } from '@eticketsgo/web-kit';

/**
 * What an organizer is told about their provider payout account.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * The provider card printed `onboardingStatus` straight to the screen, so an organizer read
 * PENDING_VERIFICATION or RESTRICTED or REJECTED - words from our database, in our shape, with no
 * indication of whether anybody was waiting on them. The payout status card one row above was
 * rebuilt precisely to stop doing that, and the two cards then contradicted each other on the
 * same page.
 *
 * This is a LABEL map, not a second state machine. It renames values the server already decided;
 * it never works out what they mean together. Whether sales or payouts are affected, and whether
 * the organizer must act, is answered once by `/payouts/account-state`, and this card does not
 * attempt to answer it again.
 */
export interface ConnectWords {
  /** The status, in the organizer's vocabulary. Never the enum. */
  label: string;
  /** Who is waiting, when anybody is. Null when the sentence would add nothing. */
  note: string | null;
}

const WORDS: Record<string, ConnectWords> = {
  NOT_STARTED: { label: 'Not set up yet', note: 'Your payout account has not been created.' },
  ONBOARDING: { label: 'Being set up', note: 'We are still collecting what the provider needs.' },
  PENDING_VERIFICATION: {
    label: 'Being checked',
    // The organizer has already done their part here, and saying so prevents a pointless chase.
    note: 'The provider is checking your details. Nothing is needed from you.',
  },
  ENABLED: { label: 'Ready', note: null },
  RESTRICTED: { label: 'Limited', note: 'Some details are still needed before money can move.' },
  DISABLED: { label: 'Turned off', note: 'This account cannot receive money at the moment.' },
  REJECTED: { label: 'Not approved', note: 'The provider could not approve this account.' },
};

export function connectWords(status: string): ConnectWords {
  /*
    An unknown value is a provider adding a state we have not met. Printing it raw is how this
    card went wrong in the first place, so the fallback stays vague rather than leaking it.
  */
  return WORDS[status] ?? { label: 'Being set up', note: null };
}

/**
 * What to say when the platform has not switched provider settlements on.
 *
 * The card used to say: "Razorpay Route is not yet enabled for this platform - payouts are held;
 * contact support to enable Route settlements." Three things wrong with that in one sentence. It
 * names the payment provider and one of its products. It states a configuration of OUR platform,
 * which is not the organizer's business and not their problem. And it tells them to contact
 * support about something only we can do, so the only action it offers is a wasted one.
 */
export const PLATFORM_SETTLEMENTS_OFF =
  'We are not making payouts to this account yet. Your sales are unaffected, and no action is required from you.';

/** Whether the organizer has any outstanding requirement of their own. */
export function hasOrganizerRequirements(status: RazorpayAccountStatus): boolean {
  return status.requirementsDue.length > 0;
}
