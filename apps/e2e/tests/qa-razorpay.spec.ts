import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHmac, randomBytes } from 'node:crypto';
import { API, apiLogin } from './helpers';

/**
 * Razorpay against the deployed QA environment.
 *
 * ── WHY THIS IS GATED ──────────────────────────────────────────────────────────────
 * It needs live Razorpay test credentials configured on QA, so it is not part of the normal
 * suite. Run it deliberately:
 *
 *     QA_RAZORPAY=1 RAZORPAY_WEBHOOK_SECRET=… npx playwright test qa-razorpay
 *
 * ── WHERE THE BOUNDARY IS, AND WHY THERE IS NO BROWSER TEST HERE ───────────────────
 * There is deliberately no test that drives Razorpay's hosted Checkout. It was written and
 * then deleted: Checkout loads hCaptcha and bot detection against an automated browser, so
 * the payment-method list never renders. A test built on a third party's markup — markup
 * they actively defend against automation — fails for reasons that have nothing to do with
 * this codebase, and a suite that cries wolf gets ignored.
 *
 * So this covers everything on OUR side of the boundary: routing, order creation, the
 * callback destination, signature verification, and confirmation. The two things it cannot
 * prove are stated in the tests that would otherwise be mistaken for proving them —
 * Razorpay actually capturing a payment, and Razorpay actually delivering the webhook. A
 * human clicking through Checkout and the dashboard's webhook log are the evidence for
 * those, and `docs/guides/RAZORPAY-TEST-WALKTHROUGH.md` is the script for it.
 */
const RUN = process.env.QA_RAZORPAY === '1';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';

test.describe('Razorpay on QA', () => {
  test.skip(!RUN, 'Set QA_RAZORPAY=1 to run against the deployed QA environment.');
  test.describe.configure({ mode: 'serial' });

  let tokens: Awaited<ReturnType<typeof apiLogin>>;

  test.beforeAll(async ({ request }) => {
    tokens = await apiLogin(request, 'customer1@eticketsgo.test');
  });

  /** A fresh INR booking on a paid event, plus the payment intent it produced. */
  async function bookAndInitiate(request: APIRequestContext) {
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const list = await (await request.get(`${API}/public/events?pageSize=30`)).json();
    const paid = (list.data ?? list).find(
      (e: { fromPriceMinor?: number }) => (e.fromPriceMinor ?? 0) > 0,
    );
    expect(paid, 'QA needs at least one paid event').toBeTruthy();

    const detail = await (await request.get(`${API}/public/events/${paid.slug}`)).json();
    const session = detail.sessions.find(
      (s: { ticketTypes: unknown[] }) => s.ticketTypes.length > 0,
    );

    const res = await request.post(`${API}/bookings`, {
      headers: auth,
      data: {
        eventSessionId: session.id,
        items: [{ ticketTypeId: session.ticketTypes[0].id, quantity: 1 }],
        buyerName: 'Razorpay Test',
        buyerEmail: 'customer1@eticketsgo.test',
      },
    });
    expect(res.ok(), `booking failed: ${await res.text()}`).toBe(true);
    const booking = await res.json();

    const pay = await request.post(`${API}/bookings/${booking.id}/pay`, {
      headers: auth,
      data: {},
    });
    expect(pay.ok(), `pay failed: ${await pay.text()}`).toBe(true);
    return { booking, intent: await pay.json(), auth };
  }

  test('1: an INR booking routes to Razorpay and gets a real order', async ({ request }) => {
    const { intent } = await bookAndInitiate(request);

    /*
      Routing comes from the booking's own currency and country, never from anything the
      client sends — so this also confirms QA is no longer falling through to the mock.
    */
    expect(intent.provider).toBe('razorpay');
    expect(intent.razorpay.orderId).toMatch(/^order_/);
    expect(intent.razorpay.keyId).toMatch(/^rzp_test_/);

    /*
      The defect that appeared the moment real keys were added: this was
      `http://localhost:3000/...`, so a paying customer would have been returned to a machine
      that is not theirs — after the money moved. It failed silently, because a default is
      not a missing value.
    */
    expect(intent.razorpay.callbackUrl).not.toContain('localhost');
    expect(intent.razorpay.callbackUrl).toMatch(/^https:\/\//);
  });

  test('2: the booking stays unpaid until a signed webhook says otherwise', async ({ request }) => {
    /*
      The browser redirect is not the authority. A customer who closes the tab, or a crafted
      return URL, must not produce a ticket — only the signed webhook confirms.
    */
    const { booking, auth } = await bookAndInitiate(request);
    const after = await (
      await request.get(`${API}/bookings/${booking.id}`, { headers: auth })
    ).json();
    expect(after.status).toBe('PENDING_PAYMENT');
    expect(after.tickets ?? []).toHaveLength(0);
  });

  test('3: an unsigned or tampered webhook is refused', async ({ request }) => {
    const body = JSON.stringify({ entity: 'event', event: 'payment.captured', payload: {} });
    for (const [label, signature] of [
      ['no signature', ''],
      ['wrong signature', 'deadbeef'.repeat(8)],
    ] as const) {
      const res = await request.post(`${API}/payments/webhooks/razorpay`, {
        headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature },
        data: body,
      });
      expect(res.ok(), `${label} was accepted`).toBe(false);
      expect((await res.json()).code).toBe('PAYMENT_WEBHOOK_INVALID');
    }
  });

  test('4: a captured payment confirms the booking and issues a ticket with a QR', async ({
    request,
  }) => {
    test.skip(!WEBHOOK_SECRET, 'Needs RAZORPAY_WEBHOOK_SECRET to sign the event.');

    /*
      ── READ THIS BEFORE TRUSTING IT ──────────────────────────────────────────────────
      The event below is signed by US, not by Razorpay. What this proves is that OUR
      processor, given a captured payment for a REAL order, confirms the booking and issues
      a ticket. It does NOT prove Razorpay delivers — only their dashboard's webhook log
      shows that, and it is checked by hand.

      Saying so here rather than in a commit message, because this is the test somebody will
      point at when asked "have we tested Razorpay end to end", and the honest answer has a
      boundary in it.
    */
    const { booking, intent, auth } = await bookAndInitiate(request);

    const body = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: `pay_${randomBytes(9).toString('hex')}`,
            order_id: intent.razorpay.orderId,
            amount: intent.razorpay.amountMinor,
            currency: intent.razorpay.currency,
            status: 'captured',
            method: 'upi',
            notes: { bookingId: booking.id },
          },
        },
      },
    });
    const res = await request.post(`${API}/payments/webhooks/razorpay`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Razorpay-Signature': createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex'),
      },
      data: body,
    });
    expect(res.ok(), `webhook refused: ${await res.text()}`).toBe(true);

    // Polled: confirmation is asynchronous, and the webhook returns before it completes.
    await expect
      .poll(
        async () => {
          const b = await (
            await request.get(`${API}/bookings/${booking.id}`, { headers: auth })
          ).json();
          return b.status;
        },
        { timeout: 90_000, intervals: [2000] },
      )
      .toBe('CONFIRMED');

    const confirmed = await (
      await request.get(`${API}/bookings/${booking.id}`, { headers: auth })
    ).json();
    expect(confirmed.reference).toMatch(/^ETG-/);
    expect(confirmed.tickets.length).toBeGreaterThan(0);

    /*
      The QR is fetched from the single-ticket endpoint, not read off the booking. It is a
      signed credential, so it is served deliberately rather than inlined everywhere a
      booking appears — and "confirmed with a ticket" is not the finish line: a ticket
      without a QR admits nobody.
    */
    const ticket = await (
      await request.get(`${API}/tickets/${confirmed.tickets[0].id}`, { headers: auth })
    ).json();
    expect(ticket.qrToken).toBeTruthy();
    expect(ticket.qrDataUrl).toMatch(/^data:image\/png;base64,/);
  });
});
