import type { PayoutAccountState } from '@eticketsgo/web-kit';
import type { PayoutProviderEntry } from '@eticketsgo/shared-types';

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
): ProviderSummaryView {
  const lines: SummaryLine[] = state.providers.map((e) => ({
    key: `${e.provider}-${e.market}`,
    title: TITLE[e.provider],
    payments: PAYMENTS[e.accepting],
    paymentsBlocked: e.accepting === 'BLOCKED',
    payouts: e.payouts === 'PENDING' && e.bank === 'NONE' ? PAYOUTS_NO_BANK : PAYOUTS[e.payouts],
    payoutsTone: e.payouts === 'AVAILABLE' ? 'good' : e.payouts === 'PENDING' ? 'waiting' : 'bad',
    bank: e.bank ? BANK[e.bank] : null,
    organizerActionRequired: e.organizerActionRequired,
  }));

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
