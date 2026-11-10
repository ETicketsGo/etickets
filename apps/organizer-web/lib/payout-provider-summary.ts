import type { PayoutAccountState } from '@eticketsgo/web-kit';
import type { PayoutProviderEntry } from '@eticketsgo/shared-types';
import { isManualPayout, manualPayoutLine, type BankOwnership } from './manual-payouts';

/**
 * The words for the "Payout status" summary: one line per provider/market, and a headline taken
 * from the worst of them.
 *
 * ── WHY A LIST, AND WHY NOTHING IS DECIDED HERE ────────────────────────────────────
 * The card used to show ONE state read from whichever payment-account row the server found first,
 * of any provider, and so could say "Payouts are active" above a Stripe panel saying "finish setup
 * or you cannot sell". The server now returns an entry per provider and market the organizer uses
 * (`providers`, worst first, with `providerSummary`), built by the same shared rules the panels
 * use. This file only turns those entries into sentences. It does not read a single provider flag,
 * and must not: a second reading is exactly what produced the contradiction.
 */

export type SummaryTone = 'neutral' | 'waiting' | 'attention' | 'good' | 'stopped';

export interface SummaryLine {
  key: string;
  title: string;
  payments: string;
  paymentsBlocked: boolean;
  payouts: string;
  payoutsTone: 'good' | 'waiting' | 'bad';
  bank: string | null;
  /** While the platform sends no automatic transfers for this market: the automatic path, named so it is not mistaken for the only one. */
  automatic?: string;
  organizerActionRequired: boolean;
}

export interface ProviderSummaryView {
  heading: string;
  tone: SummaryTone;
  detail: string;
  lines: SummaryLine[];
}

const TITLE: Record<PayoutProviderEntry['provider'], string> = {
  STRIPE: 'Stripe: US and Canadian dollars',
  RAZORPAY: 'Razorpay: Indian rupees',
};

const PAYMENTS: Record<PayoutProviderEntry['accepting'], string> = {
  ACCEPTING: 'Buyers can pay you.',
  BLOCKED: 'You cannot sell paid tickets in this currency until payout setup is finished.',
  NOT_GATED: 'Your sales are not affected.',
};

const PAYOUTS: Record<PayoutProviderEntry['payouts'], string> = {
  AVAILABLE: 'Payouts are active.',
  PENDING: 'Payouts have not started yet. No action is needed from you.',
  UNAVAILABLE: 'Payouts cannot start until you finish setup.',
};

/*
  "No action is needed from you" is true of the provider account (we set that up), and false when
  no bank account is saved: Get started and Overview both list "Add the bank account your money is
  sent to" as blocking, because a settlement cannot be paid without one. The card said "Nothing is
  blocked on your side" and "No action is needed from you" directly above "No bank account saved
  yet". Without a bank account the payout line says what is missing instead.
*/
const PAYOUTS_NO_BANK = 'Payouts cannot be paid until you add a bank account below.';

const BANK: Record<NonNullable<PayoutProviderEntry['bank']>, string> = {
  NONE: 'No bank account saved yet.',
  UNDER_REVIEW: 'Bank account saved. We are checking it.',
  VERIFIED: 'Bank account verified.',
  REJECTED: 'We could not verify your bank details. Check them and save them again.',
};

export function providerSummaryView(
  state: Pick<PayoutAccountState, 'providers' | 'providerSummary'>,
  /** Whether the rupee bank account is in the business's own name (see lib/manual-payouts). */
  opts: {
    inrOwnership?: BankOwnership;
    /** A changed legal identity waiting for (or refused at) staff review holds every payout. */
    identityHold?: 'PENDING_REVIEW' | 'CHANGES_REQUESTED' | null;
  } = {},
): ProviderSummaryView {
  const lines: SummaryLine[] = state.providers.map((e) => {
    /*
      A market the platform sends no automatic transfers for (rupees with Route off, dollars with
      Stripe transfers off) is paid through manual settlements, which work. The provider's own
      flags describe the automatic path only, so read here they said "Payouts have not started
      yet" (rupees) or "Payouts are active" (dollars) beside a bank account the organizer had
      not yet given us.
    */
    if (isManualPayout(e)) {
      // Ownership is worked out on this page for the rupee account only; the API enforces it for
      // every currency when a payout is marked paid.
      const ownership =
        e.provider === 'RAZORPAY' ? (opts.inrOwnership ?? 'NOT_CHECKED') : 'NOT_CHECKED';
      const m = manualPayoutLine(e.bank, ownership, e.provider);
      return {
        key: `${e.provider}-${e.market}`,
        title: TITLE[e.provider],
        payments: PAYMENTS[e.accepting],
        paymentsBlocked: e.accepting === 'BLOCKED',
        payouts: m.payouts,
        payoutsTone: m.payoutsTone,
        bank: m.bank,
        automatic: m.automatic,
        organizerActionRequired: m.organizerActionRequired,
      };
    }
    return {
      key: `${e.provider}-${e.market}`,
      title: TITLE[e.provider],
      payments: PAYMENTS[e.accepting],
      paymentsBlocked: e.accepting === 'BLOCKED',
      payouts: e.payouts === 'PENDING' && e.bank === 'NONE' ? PAYOUTS_NO_BANK : PAYOUTS[e.payouts],
      payoutsTone: e.payouts === 'AVAILABLE' ? 'good' : e.payouts === 'PENDING' ? 'waiting' : 'bad',
      bank: e.bank ? BANK[e.bank] : null,
      organizerActionRequired: e.organizerActionRequired,
    };
  });

  /*
    A changed legal identity holds every payout, whichever provider: the API refuses to record
    a payout paid or release a settlement until staff approve it. Said on every line, so no line
    reads "active" while the money cannot move.
  */
  if (opts.identityHold && lines.length > 0) {
    const pending = opts.identityHold === 'PENDING_REVIEW';
    for (const l of lines) {
      l.payouts = pending
        ? 'On hold while we check your changed legal details.'
        : 'On hold: we could not approve your changed legal details. Correct them in Settings.';
      l.payoutsTone = pending ? 'waiting' : 'bad';
    }
    return {
      heading: pending
        ? 'Payouts are on hold while we check your legal details'
        : 'Correct your legal details to resume payouts',
      tone: pending ? 'waiting' : 'attention',
      detail: 'Your sales are not affected. Only payouts wait for this review.',
      lines,
    };
  }

  /*
    With a manual-settlement line the headline is read from the lines, not from the server's
    level: that level was decided by the provider's automatic path, which is exactly what is
    wrong here.
  */
  if (state.providers.some(isManualPayout) && lines.length > 0) {
    if (!lines.some((l) => l.paymentsBlocked) && state.providers.some((e) => e.bank === 'NONE')) {
      return {
        heading: 'Add a bank account to get paid',
        tone: 'attention',
        detail:
          'Your ticket sales are not affected. We cannot pay your settlements until we know where to send them.',
        lines,
      };
    }
    if (lines.some((l) => l.payoutsTone === 'bad' || l.paymentsBlocked)) {
      return {
        heading: 'Action needed on your payout setup',
        tone: lines.some((l) => l.paymentsBlocked) ? 'stopped' : 'attention',
        detail: 'The lines below show what is holding your payouts and where to fix it.',
        lines,
      };
    }
    if (lines.some((l) => l.payoutsTone === 'waiting')) {
      return {
        heading: 'Payouts start once we have checked your bank account',
        tone: 'waiting',
        detail: 'Nothing is blocked on your side right now.',
        lines,
      };
    }
    return {
      heading: 'Payouts are active',
      tone: 'good',
      detail:
        'Settlements are paid by ETicketsGo by bank transfer once an event has finished and its holding period has passed.',
      lines,
    };
  }

  switch (state.providerSummary.level) {
    case 'NONE':
      return {
        heading: 'No payout setup needed yet',
        tone: 'neutral',
        detail:
          'Tell us where your business is registered in Settings, then Legal and tax details, and the right payout setup appears here.',
        lines,
      };
    case 'ACTION':
      return {
        heading: 'Action needed on your payout setup',
        tone: lines.some((l) => l.paymentsBlocked) ? 'stopped' : 'attention',
        detail: 'The lines below show what is blocked and where.',
        lines,
      };
    case 'WAITING':
      if (lines.length > 0 && state.providers.some((e) => e.bank === 'NONE')) {
        return {
          heading: 'Add a bank account to get paid',
          tone: 'attention',
          detail:
            'Your ticket sales are not affected. We cannot pay your settlements until we know where to send them.',
          lines,
        };
      }
      return {
        heading: 'Payouts are not active yet',
        tone: 'waiting',
        detail: 'Nothing is blocked on your side right now.',
        lines,
      };
    case 'READY':
      return {
        heading: 'Payouts are active',
        tone: 'good',
        detail: 'Every payout setup you use is ready.',
        lines,
      };
  }
}
