import { test, expect } from '@playwright/test';
import { QA_VALIDATE, QA_SKIP_REASON } from './qa-target';
import { apiLogin, type AuthTokens } from './helpers';

// Deployment-facing: skipped unless asked for. See qa-target.ts for why.
test.skip(!QA_VALIDATE, QA_SKIP_REASON);

/**
 * The US path: a dollar-priced event routes to Stripe, and refuses to charge until the
 * organizer can be paid.
 *
 * ── WHY THIS SUITE EXISTS ──────────────────────────────────────────────────────────
 * Three defects in the marketplace layer were invisible until Stripe had real keys, and
 * every one of them was a single-provider assumption left over from when this platform
 * sold in one country: the webhook asked the globally configured provider to verify a
 * Stripe signature, Connect onboarding asked it for connected accounts, and the gate that
 * refuses a payment with nowhere to settle asked it whether it supported transfers — and
 * being told "no" by the mock, skipped itself.
 *
 * The last one is the reason this file exists. It fails silently and in the expensive
 * direction: the charge succeeds, lands on the platform, and has nothing tying it to the
 * organizer it was collected for.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────────────
 * No test completes a Stripe payment. Checkout is a third party's hosted page, and
 * Connect onboarding is a hosted flow requiring a human. What this covers is everything up
 * to that boundary — which is all of OUR side.
 */
const API = 'https://api-qa-f580.up.railway.app/api';

let customer: AuthTokens;
test.beforeAll(async ({ request }) => {
  test.skip(!QA_VALIDATE, QA_SKIP_REASON);
  customer = await apiLogin(request, 'customer1@eticketsgo.test');
});

/** The published USD event QA keeps for this purpose. */
async function usdSession(request: import('@playwright/test').APIRequestContext) {
  const list = await (await request.get(`${API}/public/events?pageSize=100&country=US`)).json();
  const usd = (list.data ?? []).find((e: { currency: string }) => e.currency === 'USD');
  expect(usd, 'QA needs a published USD event — see STRIPE-US-READINESS.md').toBeTruthy();
  const detail = await (await request.get(`${API}/public/events/${usd.slug}`)).json();
  const session = detail.sessions.find(
    (s: { seatBased?: boolean; ticketTypes: unknown[] }) => !s.seatBased && s.ticketTypes.length,
  );
  return { event: usd, session };
}

test('a US venue prices in dollars, all the way to the booking', async ({ request }) => {
  const { event, session } = await usdSession(request);
  expect(event.venue.country).toMatch(/^(US|USA|United States)$/i);
  expect(session.ticketTypes[0].currency).toBe('USD');

  const booking = await (
    await request.post(`${API}/bookings`, {
      headers: { Authorization: `Bearer ${customer.accessToken}` },
      data: {
        eventSessionId: session.id,
        items: [{ ticketTypeId: session.ticketTypes[0].id, quantity: 2 }],
        buyerName: 'USD Routing',
        buyerEmail: 'customer1@eticketsgo.test',
      },
    })
  ).json();

  /*
    The booking's currency comes from the ticket types, not from a column default. Before
    the currency work every booking on this platform claimed INR whatever it was selling —
    and the currency is what chooses the fee tiers, the tax rules and the payment provider.
  */
  expect(booking.currency).toBe('USD');
  expect(booking.fees.currency).toBe('USD');
});

test('the charge is refused while the organizer has nowhere to be paid', async ({ request }) => {
  /*
    THE ASSERTION THIS FILE IS FOR.

    This gate asked the globally configured provider whether it supported transfers. That
    is the mock, which does not, so the gate skipped — and a USD booking would have gone to
    Stripe with no connectedAccountId and no transferGroup. The money would have arrived
    with nothing recording whose it was.

    A 409 here means the gate ran, which means it correctly identified that THIS booking
    routes to a marketplace provider. It is a refusal that proves a decision.
  */
  const { session } = await usdSession(request);
  const auth = { Authorization: `Bearer ${customer.accessToken}` };
  const booking = await (
    await request.post(`${API}/bookings`, {
      headers: auth,
      data: {
        eventSessionId: session.id,
        items: [{ ticketTypeId: session.ticketTypes[0].id, quantity: 1 }],
        buyerName: 'Connect Gate',
        buyerEmail: 'customer1@eticketsgo.test',
      },
    })
  ).json();

  const pay = await request.post(`${API}/bookings/${booking.id}/pay`, { headers: auth, data: {} });
  const body = await pay.json();

  /*
    Two outcomes are correct, and which one appears depends on a Stripe dashboard setting
    rather than on this codebase:

      409  the organizer has no charges-enabled account yet — the gate refusing;
      200  onboarding is complete, and the response must be a REAL Stripe Checkout URL.

    Asserting only the 409 would make this suite fail the moment the platform is finished
    being set up, which teaches people to delete it.
  */
  if (pay.status() === 409) {
    expect(body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect(body.message).toMatch(/payment setup/i);
  } else {
    expect(pay.ok(), `unexpected: ${JSON.stringify(body).slice(0, 200)}`).toBe(true);
    expect(body.provider ?? 'stripe').toBe('stripe');
    expect(body.clientActionUrl ?? '').toContain('checkout.stripe.com');
  }
});

test('an INR booking still goes to Razorpay, untouched by any of this', async ({ request }) => {
  // The regression that matters: making USD work must not move the market that already does.
  const list = await (await request.get(`${API}/public/events?country=IN&pageSize=50`)).json();
  const paid = (list.data ?? []).find(
    (e: { fromPriceMinor?: number }) => (e.fromPriceMinor ?? 0) > 0,
  );
  expect(paid, 'QA needs a paid INR event').toBeTruthy();
  const detail = await (await request.get(`${API}/public/events/${paid.slug}`)).json();
  const session = detail.sessions.find(
    (s: { seatBased?: boolean; ticketTypes: unknown[] }) => !s.seatBased && s.ticketTypes.length,
  );
  const auth = { Authorization: `Bearer ${customer.accessToken}` };
  const booking = await (
    await request.post(`${API}/bookings`, {
      headers: auth,
      data: {
        eventSessionId: session.id,
        items: [{ ticketTypeId: session.ticketTypes[0].id, quantity: 1 }],
        buyerName: 'INR Regression',
        buyerEmail: 'customer1@eticketsgo.test',
      },
    })
  ).json();
  expect(booking.currency).toBe('INR');

  const pay = await (
    await request.post(`${API}/bookings/${booking.id}/pay`, { headers: auth, data: {} })
  ).json();
  expect(pay.provider).toBe('razorpay');
  expect(pay.razorpay.callbackUrl).not.toContain('localhost');
});
