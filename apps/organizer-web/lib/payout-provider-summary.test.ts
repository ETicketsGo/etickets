import { describe, expect, it } from 'vitest';
import {
  buildProviderEntries,
  summarizeProviderEntries,
  type RazorpayReadinessFacts,
  type StripeReadinessFacts,
} from '@eticketsgo/shared-types';
import { providerSummaryView } from './payout-provider-summary';
import { razorpayPanelMessage, stripePanelMessage } from './provider-panel-messages';

/**
 * The summary card and the provider panels beneath it must tell one story. The panel facts and the
 * summary entries are built from the SAME facts here, and each scenario asserts that every line
 * agrees with its panel on the two things an organizer acts on: can I sell, and am I paid.
 */
const STRIPE_STATES: Record<string, StripeReadinessFacts> = {
  none: {
    hasAccount: false,
    chargesEnabled: false,
    payoutsEnabled: false,
    canSellPaidTickets: false,
  },
  unfinished: {
    hasAccount: true,
    chargesEnabled: false,
    payoutsEnabled: false,
    canSellPaidTickets: false,
  },
  chargesOnly: {
    hasAccount: true,
    chargesEnabled: true,
    payoutsEnabled: false,
    canSellPaidTickets: true,
  },
  active: {
    hasAccount: true,
    chargesEnabled: true,
    payoutsEnabled: true,
    canSellPaidTickets: true,
  },
};
const RZP_STATES: Record<string, RazorpayReadinessFacts> = {
  routeOff: { hasAccount: false, payoutsEnabled: false, routeEnabled: false, payoutReady: false },
  unlinked: { hasAccount: false, payoutsEnabled: false, routeEnabled: true, payoutReady: false },
  linked: { hasAccount: true, payoutsEnabled: false, routeEnabled: true, payoutReady: false },
  active: { hasAccount: true, payoutsEnabled: true, routeEnabled: true, payoutReady: true },
};

const SCENARIOS = {
  'US only': { card: true, inr: false },
  'India only': { card: false, inr: true },
  both: { card: true, inr: true },
  neither: { card: false, inr: false },
} as const;

describe('summary agrees with every panel', () => {
  for (const [name, markets] of Object.entries(SCENARIOS)) {
    for (const [sName, s] of Object.entries(STRIPE_STATES)) {
      for (const [rName, r] of Object.entries(RZP_STATES)) {
        it(`${name} / stripe ${sName} / razorpay ${rName}`, () => {
          const providers = buildProviderEntries({
            markets,
            stripe: s,
            razorpay: r,
            bankAccounts: [],
          });
          const summary = summarizeProviderEntries(providers);
          const view = providerSummaryView({ providers, providerSummary: summary });
          const scope = { inr: markets.inr, card: markets.card };

          // A line exists exactly for the panels the page shows.
          expect(view.lines.map((l) => l.key)).toEqual(
            providers.map((e) => `${e.provider}-${e.market}`),
          );
          expect(providers.some((e) => e.provider === 'STRIPE')).toBe(markets.card);
          expect(providers.some((e) => e.provider === 'RAZORPAY')).toBe(markets.inr);

          for (const line of view.lines) {
            if (line.key === 'STRIPE-CARD') {
              const panel = stripePanelMessage({ ...s }, scope);
              // Sales: the panel warns exactly when the summary says sales are blocked.
              expect(line.paymentsBlocked).toBe(panel?.tone === 'warning');
              // Payouts: a silent panel is "active"; an info panel is "waiting".
              if (panel === null) expect(line.payoutsTone).toBe('good');
              if (panel?.tone === 'info') expect(line.payoutsTone).toBe('waiting');
            } else {
              const panel = razorpayPanelMessage({ ...r }, scope);
              // Razorpay never blocks a sale, in the panel or the summary.
              expect(line.paymentsBlocked).toBe(false);
              expect(panel.tone === 'warning').toBe(false);
              expect(line.payoutsTone === 'good').toBe(panel.tone === 'success');
            }
          }

          // The headline can only be as good as the worst line.
          const anyBlocked = view.lines.some((l) => l.paymentsBlocked);
          if (anyBlocked) expect(view.tone).toBe('stopped');
          if (view.lines.length === 0) expect(summary.level).toBe('NONE');
          if (
            view.lines.length &&
            view.lines.every((l) => l.payoutsTone === 'good' && !l.paymentsBlocked)
          ) {
            expect(summary.level).toBe('READY');
          }
        });
      }
    }
  }

  /*
    Stripe with platform transfers off: the account is fine at Stripe, but no transfer is sent,
    so the organizer is paid by manual settlement and needs a dollar bank account. The card said
    "Payouts are active / Every payout setup you use is ready" above "No account on file".
  */
  it('Stripe with transfers off never says active; without a bank account it asks for one', () => {
    const facts = { ...STRIPE_STATES.active, transfersEnabled: false };
    const noBank = buildProviderEntries({
      markets: SCENARIOS['US only'],
      stripe: facts,
      bankAccounts: [],
    });
    const v1 = providerSummaryView({
      providers: noBank,
      providerSummary: summarizeProviderEntries(noBank),
    });
    expect(v1.heading).toBe('Add a bank account to get paid');
    expect(v1.lines[0].payouts).toMatch(/^Manual settlements: add a bank account below/);
    expect(v1.lines[0].automatic).toBe(
      'Automatic payouts (Stripe transfers): not enabled. Nothing is needed from you.',
    );
    expect(v1.lines[0].payments).toBe('Buyers can pay you.');
    expect(JSON.stringify(v1)).not.toMatch(
      /Payouts are active|Every payout setup you use is ready/,
    );

    const verified = buildProviderEntries({
      markets: SCENARIOS['US only'],
      stripe: facts,
      bankAccounts: [{ currency: 'USD', verifiedAt: new Date() }],
    });
    const v2 = providerSummaryView({
      providers: verified,
      providerSummary: summarizeProviderEntries(verified),
    });
    expect(v2.lines[0].payouts).toMatch(/^Manual settlements: active/);
    expect(v2.detail).toBe(
      'Settlements are paid by ETicketsGo by bank transfer once an event has finished and its holding period has passed.',
    );
  });

  it('both markets with every transfer off: each line names its own automatic path', () => {
    const providers = buildProviderEntries({
      markets: SCENARIOS.both,
      stripe: { ...STRIPE_STATES.active, transfersEnabled: false },
      razorpay: RZP_STATES.routeOff,
      bankAccounts: [
        { currency: 'USD', verifiedAt: new Date() },
        { currency: 'INR', verifiedAt: new Date() },
      ],
    });
    const v = providerSummaryView({
      providers,
      providerSummary: summarizeProviderEntries(providers),
    });
    const by = Object.fromEntries(v.lines.map((l) => [l.key, l.automatic]));
    expect(by['STRIPE-CARD']).toMatch(/Stripe transfers/);
    expect(by['RAZORPAY-INR']).toMatch(/Razorpay Route/);
  });

  it('is stable: the same facts always give the same lines in the same order', () => {
    const input = {
      markets: SCENARIOS.both,
      stripe: STRIPE_STATES.unfinished,
      razorpay: RZP_STATES.active,
      bankAccounts: [],
    };
    expect(buildProviderEntries(input)).toEqual(buildProviderEntries({ ...input }));
  });

  it('never says nothing is needed while no bank account is saved', () => {
    // QA: "Nothing is blocked on your side" and "No action is needed from you" sat directly
    // above "No bank account saved yet", while Overview called the bank account blocking.
    const providers = buildProviderEntries({
      markets: SCENARIOS['India only'],
      stripe: STRIPE_STATES.none,
      razorpay: RZP_STATES.routeOff,
      bankAccounts: [],
    });
    const summary = summarizeProviderEntries(providers);
    const view = providerSummaryView({ providers, providerSummary: summary });
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/nothing is blocked|no action is needed/i);
    expect(view.heading).toBe('Add a bank account to get paid');
    expect(view.lines[0].payouts).toMatch(/add a bank account/i);

    // Once one is saved, the waiting words come back.
    const saved = buildProviderEntries({
      markets: SCENARIOS['India only'],
      stripe: STRIPE_STATES.none,
      razorpay: RZP_STATES.routeOff,
      bankAccounts: [{ currency: 'INR', verifiedAt: null, rejectedAt: null }],
    });
    const later = providerSummaryView({
      providers: saved,
      providerSummary: summarizeProviderEntries(saved),
    });
    expect(later.heading).not.toBe('Add a bank account to get paid');
  });

  it('uses plain ASCII words', () => {
    const providers = buildProviderEntries({
      markets: SCENARIOS.both,
      stripe: STRIPE_STATES.none,
      razorpay: RZP_STATES.unlinked,
      bankAccounts: [{ currency: 'INR', verifiedAt: null, rejectedAt: new Date() }],
    });
    const v = providerSummaryView({
      providers,
      providerSummary: summarizeProviderEntries(providers),
    });
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/[^\x20-\x7e]/);
    expect(text).toContain('could not verify your bank details');
  });
});
