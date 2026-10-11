/**
 * What each provider panel on the Payouts page tells an organizer about SELLING and about BEING PAID.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Two panels sat on one page and contradicted each other. The Stripe panel said "You must finish
 * payout setup before you can sell paid tickets." The Razorpay panel said "We are not making
 * payouts to this account yet. Your sales are unaffected." An organizer in both markets could not
 * tell which was true. Both were true - of DIFFERENT providers - because the server enforces two
 * different things:
 *
 *   ACCEPTING A PAYMENT (payments.service.ts, createPayment)
 *     USD / CAD  -> Stripe. A paid booking is REFUSED unless the organizer has a connected account
 *                   with a provider account id AND charges enabled. This is a sales gate.
 *     INR        -> Razorpay. The order is created on the PLATFORM account and returns before any
 *                   organizer account is read. There is NO sales gate: a linked account is never
 *                   consulted when a buyer pays.
 *
 *   RECEIVING A PAYOUT
 *     Stripe     -> needs payouts enabled on the connected account.
 *     Razorpay   -> needs the platform to have Route switched on, a linked account, and payouts
 *                   enabled on it. Money is held until then; sales continue regardless.
 *
 * So "finish setup or you cannot sell" is true for Stripe and false for Razorpay, and a Razorpay
 * panel must never imply a sales block, nor a Stripe panel imply a rupee sale is blocked.
 *
 * This file only PRESENTS those existing server facts. It decides nothing about eligibility and
 * reads nothing the panels were not already given.
 *
 * ── MARKET ─────────────────────────────────────────────────────────────────────────
 * The Stripe gate bites dollar and Canadian-dollar sales only. An organizer who also sells in
 * rupees must be told rupee sales continue, and one who sells only in one market is not told
 * about the other.
 */

import { PLATFORM_SETTLEMENTS_OFF } from './connect-onboarding-words';

export type PanelTone = 'warning' | 'info' | 'success';

export interface PanelMessage {
  tone: PanelTone;
  text: string;
}

/** Which of the two settlement markets this organizer trades in (from home country and sales). */
export interface MarketScope {
  /** Rupee sales: registered in India, or has sold in INR. */
  inr: boolean;
  /** Dollar / Canadian-dollar sales: registered elsewhere, or has sold in a non-INR currency. */
  card: boolean;
}

export interface StripeFacts {
  hasAccount: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  canSellPaidTickets: boolean;
}

export interface RazorpayFacts {
  hasAccount: boolean;
  payoutsEnabled: boolean;
  routeEnabled: boolean;
  payoutReady: boolean;
}

/**
 * Stripe. This one DOES gate sales, so its sales message is a warning exactly when the server
 * would refuse a dollar or Canadian-dollar booking: no connected account, or charges not enabled.
 */
export function stripePanelMessage(f: StripeFacts, scope: MarketScope): PanelMessage | null {
  // The server's gate is `providerAccountId && chargesEnabled`; the flag alone is not enough.
  const canSell = f.hasAccount && f.canSellPaidTickets;

  if (!canSell) {
    // Said only for what it blocks. Rupee tickets never touch this account.
    const rupeesContinue = scope.inr
      ? ' Tickets sold in rupees are not affected; they do not use this account.'
      : '';
    return {
      tone: 'warning',
      text: `You must finish payout setup before you can sell paid tickets in US or Canadian dollars.${rupeesContinue}`,
    };
  }

  if (!f.payoutsEnabled) {
    return {
      tone: 'info',
      text: 'You can sell paid tickets. Payouts to your bank are not active yet, so your settlements will wait until they are.',
    };
  }

  return null;
}

/**
 * Razorpay. This one NEVER gates sales, so no message here may suggest it does. It is about
 * payouts only, and each state says what is being waited on.
 */
export function razorpayPanelMessage(f: RazorpayFacts, scope: MarketScope): PanelMessage {
  // Named only when it distinguishes something: an organizer with no dollar sales has no other
  // sales to be confused with, so "your sales" is enough for them.
  const sales = scope.card ? 'Your sales in rupees are unaffected' : 'Your sales are unaffected';

  if (!f.routeEnabled) {
    // The single-market wording is the long-standing sentence, kept word for word.
    if (!scope.card) return { tone: 'info', text: PLATFORM_SETTLEMENTS_OFF };
    return {
      tone: 'info',
      text: `We are not making payouts to this account yet. ${sales}, and no action is required from you.`,
    };
  }
  if (!f.hasAccount) {
    return {
      tone: 'info',
      text: `Link your payout account to receive payouts. ${sales}; buyers can pay you without it.`,
    };
  }
  if (!f.payoutReady) {
    return {
      tone: 'info',
      text: `Payouts to this account have not started yet. ${sales}.`,
    };
  }
  return {
    tone: 'success',
    text: `Payouts to this account are active. ${sales}.`,
  };
}
