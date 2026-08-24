import { PaymentEnv } from '@prisma/client';
import { LAUNCH_CURRENCIES, routesFor } from '../../../prisma/payment-routing-policy';
import { selectRoute, type RouteRow } from './payment-routing';

/**
 * Every launch market routes DELIBERATELY, not by falling through the wildcard.
 *
 * ── THE BUG THIS PREVENTS ──────────────────────────────────────────────────────────
 * Before this, only INR had a row of its own. A US or Canadian sale still reached Stripe —
 * via the catch-all, which happens to name a provider that supports both currencies. It
 * worked, but nothing recorded that we meant to sell there, and nothing would have failed
 * if the fallback provider had stopped serving one of them. A market served only by a
 * default is a market nobody decided to enter.
 *
 * These tests read the SAME policy the seed and the idempotent bootstrap use, so a route
 * that is missing in production is missing here too.
 */

const rows = (env: PaymentEnv): RouteRow[] =>
  routesFor(env).map((r) => ({
    country: r.country,
    currency: r.currency,
    method: r.method,
    provider: r.provider,
    failoverProvider: r.failoverProvider ?? null,
    priority: r.priority,
  }));

describe('launch-market payment routing', () => {
  const REAL = PaymentEnv.PRODUCTION;

  it('states a row for every launch currency', () => {
    const configured = routesFor(REAL)
      .map((r) => r.currency)
      .filter((c) => c !== '*');
    expect([...configured].sort()).toEqual([...LAUNCH_CURRENCIES].sort());
  });

  it.each([
    ['INR', 'razorpay'],
    ['USD', 'stripe'],
    ['CAD', 'stripe'],
  ])('%s resolves to %s', (currency, provider) => {
    expect(selectRoute(rows(REAL), { currency })?.provider).toBe(provider);
  });

  it('matches CAD on its own row, not on the catch-all', () => {
    // The distinction the whole file exists for. Remove the explicit row and CAD still
    // reaches Stripe — via the wildcard — so asserting the provider alone proves nothing.
    // Deleting every wildcard row must leave CAD still routable.
    const explicitOnly = rows(REAL).filter((r) => r.currency !== '*');
    expect(selectRoute(explicitOnly, { currency: 'CAD' })?.provider).toBe('stripe');
    expect(selectRoute(explicitOnly, { currency: 'USD' })?.provider).toBe('stripe');
    expect(selectRoute(explicitOnly, { currency: 'INR' })?.provider).toBe('razorpay');
  });

  it('leaves an unplanned currency to the wildcard, which is what it is for', () => {
    // AUD is not a launch market. It should still resolve — refusing the sale outright is
    // worse than taking it through the general-purpose provider — but it must not look
    // like a considered decision.
    const explicitOnly = rows(REAL).filter((r) => r.currency !== '*');
    expect(selectRoute(explicitOnly, { currency: 'AUD' })).toBeNull();
    expect(selectRoute(rows(REAL), { currency: 'AUD' })?.provider).toBe('stripe');
  });

  it('gives INR a failover and gives the North American currencies none', () => {
    // Razorpay does not settle USD or CAD. Naming it as a failover would turn a clean
    // "provider unavailable" into a confusing decline at the gateway.
    const byCurrency = new Map(routesFor(REAL).map((r) => [r.currency, r]));
    expect(byCurrency.get('INR')?.failoverProvider).toBe('stripe');
    expect(byCurrency.get('USD')?.failoverProvider).toBeUndefined();
    expect(byCurrency.get('CAD')?.failoverProvider).toBeUndefined();
  });

  it('applies to every environment that uses a real gateway', () => {
    // Reported as a list rather than a bare assertion, so a failure names WHICH market in
    // WHICH environment lost its route instead of just saying "expected not null".
    const missing: string[] = [];
    for (const env of [PaymentEnv.UAT, PaymentEnv.STAGING, PaymentEnv.PRODUCTION]) {
      for (const currency of LAUNCH_CURRENCIES) {
        if (!selectRoute(rows(env), { currency })) missing.push(`${currency} in ${env}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps the simulated environments on the dummy gateway only', () => {
    // A launch-currency row in QA would point real-looking traffic at a real provider.
    for (const env of [PaymentEnv.LOCAL, PaymentEnv.DEV, PaymentEnv.QA]) {
      const specs = routesFor(env);
      expect(specs).toHaveLength(1);
      expect(specs[0].provider).toBe('dummy');
      for (const currency of LAUNCH_CURRENCIES) {
        expect(selectRoute(rows(env), { currency })?.provider).toBe('dummy');
      }
    }
  });

  it('lets an explicit row beat the catch-all regardless of declaration order', () => {
    const shuffled = [...rows(REAL)].reverse();
    expect(selectRoute(shuffled, { currency: 'CAD' })?.provider).toBe('stripe');
    expect(selectRoute(shuffled, { currency: 'INR' })?.provider).toBe('razorpay');
    expect(selectRoute(shuffled, { currency: 'INR' })?.failoverProvider).toBe('stripe');
  });
});
