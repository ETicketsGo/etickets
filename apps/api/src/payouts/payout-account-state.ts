/**
 * Where an organizer's payout setup actually stands, as one state instead of five booleans.
 *
 * ── WHY THE SERVER DECIDES THIS ────────────────────────────────────────────────────
 * The console was handed `verifiedAt`, `canSellPaidTickets`, `chargesEnabled`, `payoutsEnabled`,
 * `requirementsDue` and `disabledReason` and left to work out what they meant together. It showed
 * the organizer the word UNVERIFIED and nothing else - no indication of whether that stopped them
 * selling, whether it stopped them being paid, or whether anybody was waiting on them. Every
 * consumer that reconstructs that logic reconstructs it slightly differently, and a mobile client
 * or an admin screen would have made a third version.
 *
 * ── THE RULE THIS EXISTS TO ENFORCE ────────────────────────────────────────────────
 * An unverified BANK account is waiting on ETicketsGo, not on the organizer. Verification is
 * `POST admin/payouts/accounts/:id/verified`, which requires `AdminPermission.PAYOUT_MANAGE` -
 * there is no organizer-reachable control, so there is no honest CTA. That state reports
 * `organizerActionRequired: false` and says so in words. A "Verify now" button would be a lie.
 *
 * A provider requirement is the opposite: Stripe asking for a document IS the organizer's to
 * action, and that state carries a real destination.
 *
 * ── TWO PATHS, ONE ANSWER ──────────────────────────────────────────────────────────
 * Money reaches an organizer by one of two routes, and they are not variants of each other:
 *
 *   BANK    - a bank account on file, checked by a person here. India and the Razorpay/payout
 *             ledger work this way. Nothing about it is a provider fact.
 *   CONNECT - a provider-held account whose own flags say whether it may charge and pay out.
 *             Stripe Connect works this way.
 *
 * An organization can hold both, neither, or one. `basis` says which facts decided the state, so
 * a reader is never guessing why they were told what they were told.
 *
 * ── NOTHING PROVIDER-INTERNAL LEAVES HERE ──────────────────────────────────────────
 * `disabledReason` is provider text written for an operator, and `requirementsDue` is a list of
 * provider requirement codes. Neither is shown to an organizer: the state carries a count and a
 * safe sentence, and the raw values stay where admins and logs already see them.
 */

/** Which facts decided the state. */
export type PayoutAccountBasis = 'NONE' | 'BANK' | 'CONNECT';

export const PayoutAccountStateCode = {
  /** Nothing on file by either route. Sales are unaffected; there is simply nowhere to send money. */
  NO_ACCOUNT: 'NO_ACCOUNT',
  /** A provider account exists but its details were never finished. The organizer's to finish. */
  DETAILS_REQUIRED: 'DETAILS_REQUIRED',
  /** On file and waiting on ETicketsGo or the provider. Nobody is waiting on the organizer. */
  UNDER_REVIEW: 'UNDER_REVIEW',
  /** The provider is asking the organizer for something specific. */
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  /** The provider has stopped this account, and not for something the organizer can simply supply. */
  RESTRICTED: 'RESTRICTED',
  /** Checked and good, but nothing yet proves money can leave. */
  VERIFIED: 'VERIFIED',
  /** Proven able to pay out. */
  PAYOUTS_ENABLED: 'PAYOUTS_ENABLED',
} as const;
export type PayoutAccountStateCode =
  (typeof PayoutAccountStateCode)[keyof typeof PayoutAccountStateCode];

/** A real destination, only ever present when a real organizer action exists. */
export interface PayoutAccountAction {
  kind: 'ADD_BANK_ACCOUNT' | 'CONTINUE_PROVIDER_ONBOARDING' | 'CONTACT_SUPPORT';
  label: string;
  /** Relative to the organizer console. */
  href: string;
}

export interface PayoutAccountState {
  code: PayoutAccountStateCode;
  basis: PayoutAccountBasis;
  /** Whether PAID ticket sales are affected. Free events never are. */
  salesAffected: boolean;
  /** Whether money can currently leave to the organizer. */
  payoutsAffected: boolean;
  /** Whether anybody is waiting on the ORGANIZER. False when the wait is ours. */
  organizerActionRequired: boolean;
  /** One sentence an organizer can act on, carrying no provider-internal text. */
  explanation: string;
  action: PayoutAccountAction | null;
  /**
   * How many provider requirements are outstanding, when the provider said so.
   *
   * A COUNT, never the codes: `requirementsDue` holds provider requirement identifiers written
   * for an operator, and they mean nothing to an organizer.
   */
  outstandingRequirements: number;
}

/** A bank account on file, as the payout ledger holds it. */
export interface BankAccountFact {
  currency: string;
  verifiedAt: Date | null;
}

/** The provider-held account's own flags, when this organization has one. */
export interface ConnectAccountFact {
  hasAccount: boolean;
  onboardingStatus: string;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsDue: string[];
  disabledReason: string | null;
}

export interface PayoutAccountFacts {
  bankAccounts: readonly BankAccountFact[];
  /** Null where this organization's market does not use a provider-held account. */
  connect: ConnectAccountFact | null;
}

const ADD_BANK: PayoutAccountAction = {
  kind: 'ADD_BANK_ACCOUNT',
  label: 'Add your bank account',
  href: '/organizer/payouts',
};
const CONTINUE_ONBOARDING: PayoutAccountAction = {
  kind: 'CONTINUE_PROVIDER_ONBOARDING',
  label: 'Finish your payout details',
  href: '/organizer/payouts',
};
const CONTACT_SUPPORT: PayoutAccountAction = {
  kind: 'CONTACT_SUPPORT',
  label: 'Contact ETicketsGo',
  href: '/organizer/help',
};

/**
 * The organizer-facing state, from the facts both routes provide.
 *
 * The provider account is decided first where one exists, because its flags are the thing that
 * actually governs whether money moves. A bank account is only consulted when there is no
 * provider account to ask.
 */
export function derivePayoutAccountState(facts: PayoutAccountFacts): PayoutAccountState {
  const connect = facts.connect;

  if (connect?.hasAccount) {
    const outstanding = connect.requirementsDue.length;

    /*
      A requirement the provider has named is the one case where the organizer genuinely has
      something to do, so it is checked before the stopped states: an account can be restricted
      BECAUSE of the requirement, and telling somebody "contact support" when the provider has
      asked them for a document wastes everybody's time.
    */
    if (outstanding > 0) {
      return {
        code: PayoutAccountStateCode.ACTION_REQUIRED,
        basis: 'CONNECT',
        salesAffected: !connect.chargesEnabled,
        payoutsAffected: !connect.payoutsEnabled,
        organizerActionRequired: true,
        explanation:
          outstanding === 1
            ? 'Your payment provider needs one more detail before your payouts can continue.'
            : `Your payment provider needs ${outstanding} more details before your payouts can continue.`,
        action: CONTINUE_ONBOARDING,
        outstandingRequirements: outstanding,
      };
    }

    if (['RESTRICTED', 'DISABLED', 'REJECTED'].includes(connect.onboardingStatus)) {
      return {
        code: PayoutAccountStateCode.RESTRICTED,
        basis: 'CONNECT',
        salesAffected: !connect.chargesEnabled,
        payoutsAffected: !connect.payoutsEnabled,
        /*
          Nothing specific has been asked for, so there is nothing for the organizer to supply.
          Contacting us is a real action - a person here can read the provider's reason, which
          they cannot - so this one does carry a destination.
        */
        organizerActionRequired: true,
        explanation:
          'Your payout account has been stopped by the payment provider. We can look into it with you.',
        action: CONTACT_SUPPORT,
        outstandingRequirements: 0,
      };
    }

    if (!connect.detailsSubmitted) {
      return {
        code: PayoutAccountStateCode.DETAILS_REQUIRED,
        basis: 'CONNECT',
        salesAffected: !connect.chargesEnabled,
        payoutsAffected: true,
        organizerActionRequired: true,
        explanation: 'Your payout details were started but not finished.',
        action: CONTINUE_ONBOARDING,
        outstandingRequirements: 0,
      };
    }

    if (connect.payoutsEnabled) {
      /*
        `salesAffected` is derived from `chargesEnabled`, not assumed false.

        It was hardcoded here, and the table-driven test caught it: a provider can hold charges
        while payouts still work, so an account can be payouts-enabled and unable to sell. The two
        flags are independent and this model exists to keep them that way.
      */
      return {
        code: PayoutAccountStateCode.PAYOUTS_ENABLED,
        basis: 'CONNECT',
        salesAffected: !connect.chargesEnabled,
        payoutsAffected: false,
        organizerActionRequired: false,
        explanation: connect.chargesEnabled
          ? 'Your payout account is active.'
          : 'Your payouts are active, but your payment provider is not accepting charges right now.',
        action: null,
        outstandingRequirements: 0,
      };
    }

    /*
      Details are in, nothing is outstanding, and the provider has not yet turned payouts on.
      That is a wait, not a task - saying "verified" here would claim something the provider has
      not said, which is the distinction this whole model exists to keep.
    */
    return {
      code: PayoutAccountStateCode.UNDER_REVIEW,
      basis: 'CONNECT',
      salesAffected: !connect.chargesEnabled,
      payoutsAffected: true,
      organizerActionRequired: false,
      explanation:
        'Your payment provider is still checking your details. No action is required from you right now.',
      action: null,
      outstandingRequirements: 0,
    };
  }

  // ── the bank route ───────────────────────────────────────────────────────────────
  if (facts.bankAccounts.length === 0) {
    return {
      code: PayoutAccountStateCode.NO_ACCOUNT,
      basis: 'NONE',
      /*
        Selling is NOT affected. An organizer with no bank account can publish and sell today;
        the money simply has nowhere to go yet. Conflating the two would tell somebody their
        event cannot sell when it can, which is the more expensive error of the two.
      */
      salesAffected: false,
      payoutsAffected: true,
      organizerActionRequired: true,
      explanation: 'We do not know where to send your money yet.',
      action: ADD_BANK,
      outstandingRequirements: 0,
    };
  }

  const verified = facts.bankAccounts.filter((a) => a.verifiedAt !== null);
  if (verified.length === 0) {
    /*
      THE CASE THIS MODEL WAS BUILT FOR. A bank account is checked by a person at ETicketsGo
      (`POST admin/payouts/accounts/:id/verified`, PAYOUT_MANAGE). The organizer cannot verify it,
      cannot hurry it, and has nothing to supply - so there is no action and no CTA.
    */
    return {
      code: PayoutAccountStateCode.UNDER_REVIEW,
      basis: 'BANK',
      salesAffected: false,
      payoutsAffected: true,
      organizerActionRequired: false,
      explanation:
        'We have your bank details and are checking them. No action is required from you right now.',
      action: null,
      outstandingRequirements: 0,
    };
  }

  /*
    VERIFIED, not PAYOUTS_ENABLED. A checked bank account is the organizer's half of the job; the
    platform's own readiness - whether the gateway can actually settle to it - is a separate fact
    this function is not given, and claiming payouts are enabled on the strength of a verified
    account would assert something nothing here proves.
  */
  return {
    code: PayoutAccountStateCode.VERIFIED,
    basis: 'BANK',
    salesAffected: false,
    payoutsAffected: false,
    organizerActionRequired: false,
    explanation: 'Your bank account is verified.',
    action: null,
    outstandingRequirements: 0,
  };
}
