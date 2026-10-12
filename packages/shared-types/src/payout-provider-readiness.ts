/**
 * Per-provider payout readiness: the one place that says, for each payment provider an organizer
 * uses, whether they can ACCEPT a payment and whether they can RECEIVE a payout.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * The Payouts page had a "Payout status" summary card fed by one `OrganizerPaymentAccount` row -
 * whichever the database returned first, for ANY provider - sitting above a Stripe panel and a
 * Razorpay panel that each read their own provider's row. With both providers on file the card
 * could say "Payouts are active" (Razorpay's row) while the Stripe panel said "finish setup or you
 * cannot sell dollar tickets", or the reverse.
 *
 * The rules below are the ones the server actually enforces (see `provider-panel-messages.ts` for
 * the long form):
 *
 *   STRIPE (US / Canadian dollars)  a paid booking is REFUSED unless the organizer has a connected
 *                                   account AND charges are enabled. Payouts need payoutsEnabled.
 *   RAZORPAY (Indian rupees)        an INR order is created on the PLATFORM account and never reads
 *                                   an organizer account, so there is NO sales gate. Payouts need
 *                                   the platform's Route switch, a linked account, and payoutsEnabled.
 *
 * ── ONE SOURCE OF TRUTH ────────────────────────────────────────────────────────────
 * The API builds the account-state list with these functions, and the provider panels in the
 * organizer console read their "can this organizer sell?" and "which payout stage?" from the same
 * functions. A summary line and a panel therefore cannot disagree: they are the same answer.
 *
 * Read-only derivation. Nothing here decides eligibility, routing or settlement; it only reports
 * what those already enforce.
 */

export type PayoutProviderId = 'STRIPE' | 'RAZORPAY';
/** The settlement market a provider serves: card = US and Canadian dollars, INR = Indian rupees. */
export type PayoutMarketId = 'CARD' | 'INR';

/**
 * Whether a buyer can pay this organizer in the market.
 * NOT_GATED means the server never consults the organizer's account for that market.
 */
export type AcceptingState = 'ACCEPTING' | 'BLOCKED' | 'NOT_GATED';
export type PayoutReceiving = 'AVAILABLE' | 'PENDING' | 'UNAVAILABLE';
export type BankVerificationState = 'NONE' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';

export type StripeStage = 'NO_ACCOUNT' | 'SETUP_UNFINISHED' | 'PAYOUTS_NOT_ACTIVE' | 'ACTIVE';
export type RazorpayStage = 'PLATFORM_PAYOUTS_OFF' | 'LINK_ACCOUNT' | 'PAYOUTS_PENDING' | 'ACTIVE';

export interface StripeReadinessFacts {
  hasAccount: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  canSellPaidTickets: boolean;
}

export interface RazorpayReadinessFacts {
  hasAccount: boolean;
  payoutsEnabled: boolean;
  routeEnabled: boolean;
  payoutReady: boolean;
}

/** The server's sales gate for dollars: a provider account id AND charges enabled. */
export function stripeAccepts(f: Pick<StripeReadinessFacts, 'hasAccount' | 'canSellPaidTickets'>) {
  return f.hasAccount && f.canSellPaidTickets;
}

export function stripeStage(f: StripeReadinessFacts): StripeStage {
  if (!f.hasAccount) return 'NO_ACCOUNT';
  if (!stripeAccepts(f)) return 'SETUP_UNFINISHED';
  if (!f.payoutsEnabled) return 'PAYOUTS_NOT_ACTIVE';
  return 'ACTIVE';
}

export function razorpayStage(f: RazorpayReadinessFacts): RazorpayStage {
  if (!f.routeEnabled) return 'PLATFORM_PAYOUTS_OFF';
  if (!f.hasAccount) return 'LINK_ACCOUNT';
  if (!f.payoutReady) return 'PAYOUTS_PENDING';
  return 'ACTIVE';
}

export interface ProviderReadiness<Stage extends string> {
  stage: Stage;
  accepting: AcceptingState;
  payouts: PayoutReceiving;
  /** True when the organizer (not ETicketsGo or the provider) holds the next step. */
  organizerActionRequired: boolean;
}

export function stripeReadiness(f: StripeReadinessFacts): ProviderReadiness<StripeStage> {
  const stage = stripeStage(f);
  return {
    stage,
    accepting: stripeAccepts(f) ? 'ACCEPTING' : 'BLOCKED',
    // Payouts and charges are independent flags at the provider, so payouts can work while
    // charges are off. Not active yet with an account that can charge is a wait; anything
    // else is the organizer's to finish.
    payouts:
      f.hasAccount && f.payoutsEnabled
        ? 'AVAILABLE'
        : stage === 'PAYOUTS_NOT_ACTIVE'
          ? 'PENDING'
          : 'UNAVAILABLE',
    organizerActionRequired: stage === 'NO_ACCOUNT' || stage === 'SETUP_UNFINISHED',
  };
}

export function razorpayReadiness(f: RazorpayReadinessFacts): ProviderReadiness<RazorpayStage> {
  const stage = razorpayStage(f);
  return {
    stage,
    // Never gated: the order is made on the platform account.
    accepting: 'NOT_GATED',
    payouts:
      stage === 'ACTIVE' ? 'AVAILABLE' : stage === 'LINK_ACCOUNT' ? 'UNAVAILABLE' : 'PENDING',
    organizerActionRequired: stage === 'LINK_ACCOUNT',
  };
}

/** A bank account on file, as the payout ledger holds it. */
export interface BankFact {
  currency: string;
  verifiedAt: Date | string | null;
  rejectedAt?: Date | string | null;
}

/** The bank-account verification state across the accounts given. Verified wins, then waiting. */
export function bankVerification(accounts: readonly BankFact[]): BankVerificationState {
  if (accounts.length === 0) return 'NONE';
  if (accounts.some((a) => a.verifiedAt)) return 'VERIFIED';
  if (accounts.some((a) => !a.verifiedAt && !a.rejectedAt)) return 'UNDER_REVIEW';
  return 'REJECTED';
}

export interface PayoutProviderEntry {
  provider: PayoutProviderId;
  market: PayoutMarketId;
  stage: StripeStage | RazorpayStage;
  accepting: AcceptingState;
  payouts: PayoutReceiving;
  /** Verification of bank accounts in this market's currencies; null where none apply. */
  bank: BankVerificationState | null;
  organizerActionRequired: boolean;
}

export type PayoutSummaryLevel = 'NONE' | 'ACTION' | 'WAITING' | 'READY';

export interface PayoutProviderSummary {
  level: PayoutSummaryLevel;
  /** The entry that decided `level`, as provider; null for NONE. */
  decidedBy: PayoutProviderId | null;
}

export interface ProviderEntryInput {
  stripe?: StripeReadinessFacts | null;
  razorpay?: RazorpayReadinessFacts | null;
  /** Which markets this organizer trades in. A provider is listed only for a market in use. */
  markets: { card: boolean; inr: boolean };
  bankAccounts: readonly BankFact[];
}

const PROVIDER_ORDER: Record<PayoutProviderId, number> = { STRIPE: 0, RAZORPAY: 1 };
const CARD_CURRENCIES = new Set(['USD', 'CAD']);

/** Lower is worse. Blocked sales outrank everything, then a payout the organizer must fix. */
function severity(e: PayoutProviderEntry): number {
  if (e.accepting === 'BLOCKED') return 0;
  if (e.organizerActionRequired || e.payouts === 'UNAVAILABLE') return 1;
  if (e.payouts === 'PENDING') return 2;
  return 3;
}

/**
 * The list, worst first and then Stripe before Razorpay, so the same facts always give the same
 * order. An empty list means the organizer trades in neither market.
 */
export function buildProviderEntries(input: ProviderEntryInput): PayoutProviderEntry[] {
  const entries: PayoutProviderEntry[] = [];
  const empty = <T>(v: T | null | undefined, fallback: T): T => v ?? fallback;

  if (input.markets.card) {
    const f = empty<StripeReadinessFacts>(input.stripe, {
      hasAccount: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      canSellPaidTickets: false,
    });
    const r = stripeReadiness(f);
    const bank = input.bankAccounts.filter((a) => CARD_CURRENCIES.has(a.currency.toUpperCase()));
    entries.push({
      provider: 'STRIPE',
      market: 'CARD',
      stage: r.stage,
      accepting: r.accepting,
      payouts: r.payouts,
      bank: bank.length ? bankVerification(bank) : null,
      organizerActionRequired: r.organizerActionRequired,
    });
  }
  if (input.markets.inr) {
    const f = empty<RazorpayReadinessFacts>(input.razorpay, {
      hasAccount: false,
      payoutsEnabled: false,
      routeEnabled: false,
      payoutReady: false,
    });
    const r = razorpayReadiness(f);
    // Always reported for rupees: India settles to a bank account a person at ETicketsGo checks.
    const bank = input.bankAccounts.filter((a) => a.currency.toUpperCase() === 'INR');
    entries.push({
      provider: 'RAZORPAY',
      market: 'INR',
      stage: r.stage,
      accepting: r.accepting,
      payouts: r.payouts,
      bank: bankVerification(bank),
      organizerActionRequired: r.organizerActionRequired,
    });
  }
  return entries.sort(
    (a, b) => severity(a) - severity(b) || PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider],
  );
}

/** One level for the whole list, from its worst entry. Entries are already worst first. */
export function summarizeProviderEntries(entries: readonly PayoutProviderEntry[]) {
  const worst = entries[0];
  if (!worst) return { level: 'NONE', decidedBy: null } satisfies PayoutProviderSummary;
  const s = severity(worst);
  const level: PayoutSummaryLevel = s <= 1 ? 'ACTION' : s === 2 ? 'WAITING' : 'READY';
  return { level, decidedBy: worst.provider } satisfies PayoutProviderSummary;
}
