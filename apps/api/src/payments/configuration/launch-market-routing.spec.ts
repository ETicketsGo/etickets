import { PaymentEnv } from '@prisma/client';
import {
  LAUNCH_CURRENCIES,
  providersFromEnvironment,
  routesFor,
  type AvailableProviders,
} from '../../../prisma/payment-routing-policy';
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
 * ── AND THE BUG THAT CAME AFTER IT ─────────────────────────────────────────────────
 * The policy then answered "which provider serves INR here?" from the environment's NAME, and
 * the wiring drifted from the names in both directions. QA was given real Razorpay test keys
 * and still routed everything to `dummy`, so the launch gate reported no India row while INR
 * payments were being taken through Razorpay. UAT was given no keys at all and still routed
 * INR to `razorpay` and the rest to `stripe`, pointing at two gateways it cannot authenticate
 * against — which moves the failure from readiness, where somebody would see it, to the
 * gateway, where a customer does.
 *
 * So these tests say what each case is WIRED with, rather than what it is called.
 *
 * They read the SAME policy the seed and the idempotent bootstrap use, so a route that is
 * missing in production is missing here too.
 */

/** An environment holding keys for both real gateways. */
const FULLY_WIRED: AvailableProviders = { razorpay: true, stripe: true, dummy: false };
/** QA as it actually stands: real Razorpay test keys, no Stripe, simulator permitted. */
const RAZORPAY_ONLY: AvailableProviders = { razorpay: true, stripe: false, dummy: true };
/** An environment with nothing configured and no simulator permitted. */
const NOTHING: AvailableProviders = { razorpay: false, stripe: false, dummy: false };
/** A developer box: no provider keys, simulator permitted. */
const SIMULATED: AvailableProviders = { razorpay: false, stripe: false, dummy: true };

const rows = (env: PaymentEnv, have: AvailableProviders): RouteRow[] =>
  routesFor(env, have).map((r) => ({
    country: r.country,
    currency: r.currency,
    method: r.method,
    provider: r.provider,
    failoverProvider: r.failoverProvider ?? null,
    priority: r.priority,
  }));

describe('launch-market payment routing, in a fully wired environment', () => {
  const REAL = PaymentEnv.PRODUCTION;
  const real = () => rows(REAL, FULLY_WIRED);

  it('states a row for every launch currency', () => {
    const configured = routesFor(REAL, FULLY_WIRED)
      .map((r) => r.currency)
      .filter((c) => c !== '*');
    expect([...configured].sort()).toEqual([...LAUNCH_CURRENCIES].sort());
  });

  it.each([
    ['INR', 'razorpay'],
    ['USD', 'stripe'],
    ['CAD', 'stripe'],
  ])('%s resolves to %s', (currency, provider) => {
    expect(selectRoute(real(), { currency })?.provider).toBe(provider);
  });

  it('matches CAD on its own row, not on the catch-all', () => {
    // The distinction the whole file exists for. Remove the explicit row and CAD still
    // reaches Stripe — via the wildcard — so asserting the provider alone proves nothing.
    // Deleting every wildcard row must leave CAD still routable.
    const explicitOnly = real().filter((r) => r.currency !== '*');
    expect(selectRoute(explicitOnly, { currency: 'CAD' })?.provider).toBe('stripe');
    expect(selectRoute(explicitOnly, { currency: 'USD' })?.provider).toBe('stripe');
    expect(selectRoute(explicitOnly, { currency: 'INR' })?.provider).toBe('razorpay');
  });

  it('leaves an unplanned currency to the wildcard, which is what it is for', () => {
    // AUD is not a launch market. It should still resolve — refusing the sale outright is
    // worse than taking it through the general-purpose provider — but it must not look
    // like a considered decision.
    const explicitOnly = real().filter((r) => r.currency !== '*');
    expect(selectRoute(explicitOnly, { currency: 'AUD' })).toBeNull();
    expect(selectRoute(real(), { currency: 'AUD' })?.provider).toBe('stripe');
  });

  it('gives INR a failover and gives the North American currencies none', () => {
    // Razorpay does not settle USD or CAD. Naming it as a failover would turn a clean
    // "provider unavailable" into a confusing decline at the gateway.
    const byCurrency = new Map(routesFor(REAL, FULLY_WIRED).map((r) => [r.currency, r]));
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
        if (!selectRoute(rows(env, FULLY_WIRED), { currency }))
          missing.push(`${currency} in ${env}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('lets an explicit row beat the catch-all regardless of declaration order', () => {
    const shuffled = [...real()].reverse();
    expect(selectRoute(shuffled, { currency: 'CAD' })?.provider).toBe('stripe');
    expect(selectRoute(shuffled, { currency: 'INR' })?.provider).toBe('razorpay');
    expect(selectRoute(shuffled, { currency: 'INR' })?.failoverProvider).toBe('stripe');
  });
});

describe('routing follows what the environment is wired with', () => {
  it('sends INR to Razorpay in QA, because QA really does hold Razorpay keys', () => {
    /*
      The defect this replaces: QA was pinned to a single `dummy` wildcard by its NAME, while
      holding real Razorpay test keys and taking INR payments through them. The launch gate's
      country/provider matrix — the one screen built to answer "where does INR settle?" — read
      `* * * -> dummy`, so it could never report GO and it was answering the question wrongly.
    */
    const specs = routesFor(PaymentEnv.QA, RAZORPAY_ONLY);
    const inr = specs.find((r) => r.currency === 'INR');
    expect(inr?.provider).toBe('razorpay');
    // No failover: Stripe is not configured here, and a real gateway must never fall over to
    // the simulator — that would turn an outage into money silently not taken.
    expect(inr?.failoverProvider).toBeUndefined();
  });

  it('leaves the currencies QA cannot really take on the simulator', () => {
    const specs = routesFor(PaymentEnv.QA, RAZORPAY_ONLY);
    const byCurrency = new Map(specs.map((r) => [r.currency, r.provider]));
    expect(byCurrency.get('USD')).toBe('dummy');
    expect(byCurrency.get('CAD')).toBe('dummy');
    expect(byCurrency.get('*')).toBe('dummy');
  });

  it('writes NO row for a currency nothing can take, rather than a hopeful one', () => {
    /*
      UAT held INR → razorpay and a stripe wildcard while holding no keys for either. A route
      to a gateway we cannot authenticate against is worse than no route: readiness reports
      `NO_INR_ROUTE` for the empty case, which is true and says what to fix, whereas the
      hopeful row is only discovered by the customer standing at the gateway.
    */
    expect(routesFor(PaymentEnv.UAT, NOTHING)).toEqual([]);
  });

  it('keeps a developer box entirely on the simulator', () => {
    for (const env of [PaymentEnv.LOCAL, PaymentEnv.DEV]) {
      const specs = routesFor(env, SIMULATED);
      expect(specs.every((r) => r.provider === 'dummy')).toBe(true);
      for (const currency of LAUNCH_CURRENCIES) {
        expect(selectRoute(rows(env, SIMULATED), { currency })?.provider).toBe('dummy');
      }
    }
  });

  it('never names the simulator as a real gateway’s failover', () => {
    // Checked across every wiring, because this is the one combination that would lose money
    // quietly: a live provider outage failing over to a gateway that takes no money at all.
    for (const have of [FULLY_WIRED, RAZORPAY_ONLY, NOTHING, SIMULATED]) {
      for (const env of Object.values(PaymentEnv)) {
        for (const route of routesFor(env, have)) {
          expect(route.failoverProvider).not.toBe('dummy');
        }
      }
    }
  });
});

describe('reading the wiring from the environment', () => {
  const read = (vars: Record<string, string>) => (k: string) => vars[k];

  it('counts a provider as present only when its whole credential pair is', () => {
    // A key id with no secret is a half-finished setup, and treating it as configured would
    // route real traffic at a gateway that cannot authenticate.
    expect(
      providersFromEnvironment(PaymentEnv.QA, read({ RAZORPAY_KEY_ID: 'rzp_test_x' })).razorpay,
    ).toBe(false);
    expect(
      providersFromEnvironment(
        PaymentEnv.QA,
        read({ RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 's' }),
      ).razorpay,
    ).toBe(true);
  });

  it('treats blank as absent, because an empty variable is how a secret goes missing', () => {
    expect(
      providersFromEnvironment(
        PaymentEnv.QA,
        read({ RAZORPAY_KEY_ID: '  ', RAZORPAY_KEY_SECRET: '' }),
      ).razorpay,
    ).toBe(false);
  });

  it('permits the simulator only where the environment rules allow it', () => {
    expect(providersFromEnvironment(PaymentEnv.QA, read({})).dummy).toBe(true);
    expect(providersFromEnvironment(PaymentEnv.UAT, read({})).dummy).toBe(false);
    expect(providersFromEnvironment(PaymentEnv.PRODUCTION, read({})).dummy).toBe(false);
  });
});
