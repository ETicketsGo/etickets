import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, CUSTOMER, apiLogin, seedBrowserAuth, SEED_PASSWORD, uniqueEmail } from './helpers';

/**
 * A free event, end to end, with the payment system never involved.
 *
 * ── WHAT WAS ASKED FOR ─────────────────────────────────────────────────────────────
 * "Free event should not even call payments api and should not collect payment fee or
 * platform fee, it is just free event." And: tickets, QR codes and cancellation still work.
 *
 * The unit tests prove each guard in isolation. This proves the shape of the whole thing
 * against a running stack, because the failure that actually reaches a customer is not "the
 * guard was wrong" — it is "the buyer was sent to a checkout for ₹0.00 and it wouldn't load".
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

interface Fixture {
  slug: string;
  sessionId: string;
  ticketTypeId: string;
  eventId: string;
}

/** A published free event of its own, so repeated runs never collide. */
async function freeEvent(request: APIRequestContext): Promise<Fixture> {
  const { accessToken } = await apiLogin(request, ORGANIZER_EMAIL);
  const auth = { Authorization: `Bearer ${accessToken}` };
  const stamp = Date.now();

  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  const venues = await (
    await request.get(`${API}/venues?organizationId=${organizationId}`, { headers: auth })
  ).json();
  const venueId = (Array.isArray(venues) ? venues : venues.data)[0].id;

  const created = await request.post(`${API}/events?organizationId=${organizationId}`, {
    headers: auth,
    data: {
      title: `Free Talk ${stamp}`,
      category: 'Community',
      venueId,
      feeMode: 'CUSTOMER_PAYS',
      isFree: true,
    },
  });
  const event = await created.json();
  expect(event.id, `event creation failed: ${JSON.stringify(event)}`).toBeTruthy();
  expect(event.isFree).toBe(true);

  const session = await (
    await request.post(`${API}/events/${event.id}/sessions`, {
      headers: auth,
      data: {
        startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 30 * 86_400_000 + 2 * 3_600_000).toISOString(),
      },
    })
  ).json();

  const ticketType = await (
    await request.post(`${API}/events/ticket-types`, {
      headers: auth,
      data: {
        eventSessionId: session.id,
        name: 'Free entry',
        priceMinor: 0,
        quantityTotal: 50,
        maxPerOrder: 4,
      },
    })
  ).json();

  await request.post(`${API}/events/${event.id}/submit`, { headers: auth });
  // Straight to PUBLISHED via platform review; the approval flow has its own suite.
  const admin = await apiLogin(request, 'admin@eticketsgo.test');
  await request.post(`${API}/admin/events/${event.id}/review`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
    data: { decision: 'APPROVE' },
  });

  return {
    slug: event.slug,
    sessionId: session.id,
    ticketTypeId: ticketType.id,
    eventId: event.id,
  };
}

test.describe('a free event', () => {
  let fx: Fixture;

  test.beforeAll(async ({ request }) => {
    fx = await freeEvent(request);
  });

  test('1: the API refuses to put a price on it', async ({ request }) => {
    /*
      The flag and the prices must agree, because the booking path skips the payment provider
      on the strength of the flag alone. A free event with a ₹500 ticket would give those
      tickets away, and the discrepancy would only ever surface in the takings.
    */
    const { accessToken } = await apiLogin(request, ORGANIZER_EMAIL);
    const res = await request.post(`${API}/events/ticket-types`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: {
        eventSessionId: fx.sessionId,
        name: 'Sneaky VIP',
        priceMinor: 50_000,
        quantityTotal: 10,
        maxPerOrder: 2,
      },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).message).toMatch(/free event/i);
  });

  test('2: booking it confirms immediately, with no payment attached', async ({ request }) => {
    const buyer = uniqueEmail('free_buyer');
    await request.post(`${API}/auth/register`, {
      data: { email: buyer, password: SEED_PASSWORD, fullName: 'Free Buyer' },
    });
    const { accessToken } = await apiLogin(request, buyer);
    const auth = { Authorization: `Bearer ${accessToken}` };

    const res = await request.post(`${API}/bookings`, {
      headers: auth,
      data: {
        eventSessionId: fx.sessionId,
        items: [{ ticketTypeId: fx.ticketTypeId, quantity: 2 }],
        buyerName: 'Free Buyer',
        buyerEmail: buyer,
      },
    });
    const booking = await res.json();
    expect(res.ok(), `booking failed: ${JSON.stringify(booking)}`).toBe(true);

    // Confirmed on the spot: there is no webhook coming, so waiting for one would let the
    // hold expire and the attendee would never receive the free ticket they were promised.
    expect(booking.status).toBe('CONFIRMED');
    expect(booking.payment).toBeNull();
    // No fee of any kind — the literal request.
    expect(booking.fees.totalMinor).toBe(0);
    expect(booking.fees.bookingFeeMinor).toBe(0);
    expect(booking.fees.paymentFeeMinor).toBe(0);

    // The tickets and their QR codes exist, which is the point of booking at all.
    const detail = await (
      await request.get(`${API}/bookings/${booking.id}`, { headers: auth })
    ).json();
    expect(detail.tickets).toHaveLength(2);
    expect(detail.tickets[0].qrToken ?? detail.tickets[0].qrCodeDataUrl).toBeTruthy();

    // And the payment endpoint refuses rather than opening a zero-amount order anywhere.
    const pay = await request.post(`${API}/bookings/${booking.id}/pay`, { headers: auth });
    expect(pay.status()).toBe(409);
    expect((await pay.json()).message).toMatch(/free/i);
  });

  test('3: the customer sees "Free", not ₹0.00, and never reaches a checkout', async ({
    page,
    context,
    request,
  }) => {
    /*
      A zero with a currency symbol reads as a price that failed to load. And a buyer sent to
      the payment screen for a free ticket sees a bill for nothing above a pay button that can
      only fail — the booking is already complete.
    */
    const buyer = uniqueEmail('free_ui');
    await request.post(`${API}/auth/register`, {
      data: { email: buyer, password: SEED_PASSWORD, fullName: 'Free UI' },
    });
    await seedBrowserAuth(context, await apiLogin(request, buyer));

    await page.goto(`${CUSTOMER}/events/${fx.slug}`, { waitUntil: 'networkidle' });
    await expect(page.getByText('Free entry')).toBeVisible({ timeout: 30_000 });
    // The ticket line and the summary both say Free.
    await expect(page.getByText(/^Free ·/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Get my tickets' })).toBeVisible();

    await page.getByLabel('Quantity of Free entry').selectOption('1');
    await expect(page.getByText('No payment needed')).toBeVisible();
    await page.getByRole('button', { name: 'Get my tickets' }).click();

    // Straight to the confirmation. Never /payment.
    await expect(page).toHaveURL(/\/booking\/[^/]+\/confirmation/, { timeout: 30_000 });
  });

  test('4: a free ticket can still be cancelled', async ({ request }) => {
    // "Cancel options everything" — the half of the promise that touches the money path.
    const buyer = uniqueEmail('free_cancel');
    await request.post(`${API}/auth/register`, {
      data: { email: buyer, password: SEED_PASSWORD, fullName: 'Free Cancel' },
    });
    const { accessToken } = await apiLogin(request, buyer);
    const auth = { Authorization: `Bearer ${accessToken}` };

    const booking = await (
      await request.post(`${API}/bookings`, {
        headers: auth,
        data: {
          eventSessionId: fx.sessionId,
          items: [{ ticketTypeId: fx.ticketTypeId, quantity: 1 }],
          buyerName: 'Free Cancel',
          buyerEmail: buyer,
        },
      })
    ).json();
    expect(booking.status).toBe('CONFIRMED');

    const refund = await request.post(`${API}/refunds`, {
      headers: auth,
      data: { bookingId: booking.id, reason: 'cannot make it' },
    });
    const body = await refund.json();
    expect(refund.ok(), `refund request failed: ${JSON.stringify(body)}`).toBe(true);
    // Zero owed, and the request is accepted rather than rejected as ineligible.
    expect(body.amountMinor).toBe(0);
  });
});
