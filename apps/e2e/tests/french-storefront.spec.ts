import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, CUSTOMER, apiLogin, seedBrowserAuth, SEED_PASSWORD, uniqueEmail } from './helpers';

/**
 * Buying a ticket in French, from the storefront to the receipt.
 *
 * ── WHY THE WHOLE PATH AND NOT A PAGE ──────────────────────────────────────────────
 * Quebec's Charter of the French Language covers consumer commerce as a whole. A French
 * storefront that hands over an English checkout, or an English confirmation, or an English
 * receipt, is not partial compliance — it is the same exposure as no French at all, plus the
 * cost of having built half of it. So this walks the whole path and asserts the language at
 * every step, including the two documents the customer keeps.
 *
 * The catalogue test in `@eticketsgo/i18n` proves no message is MISSING. This proves the
 * pages actually reach for them: a component that renders a hardcoded string passes a
 * completeness check and still shows English to a French reader.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

interface Fixture {
  slug: string;
  sessionId: string;
  ticketTypeId: string;
}

/** A free event of its own, so the whole path can run without a payment provider. */
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

  const event = await (
    await request.post(`${API}/events`, {
      headers: auth,
      data: {
        organizationId,
        title: `Soirée Jazz ${stamp}`,
        category: 'Music',
        venueId,
        feeMode: 'CUSTOMER_PAYS',
        isFree: true,
      },
    })
  ).json();
  expect(event.id, `event creation failed: ${JSON.stringify(event)}`).toBeTruthy();

  const session = await (
    await request.post(`${API}/events/${event.id}/sessions`, {
      headers: auth,
      data: {
        startsAt: new Date(Date.now() + 45 * 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 45 * 86_400_000 + 2 * 3_600_000).toISOString(),
      },
    })
  ).json();

  const ticketType = await (
    await request.post(`${API}/events/ticket-types`, {
      headers: auth,
      data: {
        eventSessionId: session.id,
        name: 'Admission générale',
        priceMinor: 0,
        quantityTotal: 40,
        maxPerOrder: 4,
      },
    })
  ).json();

  await request.post(`${API}/events/${event.id}/submit`, { headers: auth });
  const admin = await apiLogin(request, 'admin@eticketsgo.test');
  await request.post(`${API}/admin/events/${event.id}/review`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
    data: { decision: 'APPROVE' },
  });

  return { slug: event.slug, sessionId: session.id, ticketTypeId: ticketType.id };
}

/** A published PAID event, so the checkout screen is actually reachable. */
async function paidEvent(request: APIRequestContext): Promise<{ slug: string }> {
  const { accessToken } = await apiLogin(request, ORGANIZER_EMAIL);
  const auth = { Authorization: `Bearer ${accessToken}` };
  const stamp = Date.now();

  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  const venues = await (
    await request.get(`${API}/venues?organizationId=${organizationId}`, { headers: auth })
  ).json();
  const venueId = (Array.isArray(venues) ? venues : venues.data)[0].id;

  const event = await (
    await request.post(`${API}/events`, {
      headers: auth,
      data: {
        organizationId,
        title: `Concert Payant ${stamp}`,
        category: 'Music',
        venueId,
        feeMode: 'CUSTOMER_PAYS',
      },
    })
  ).json();
  const session = await (
    await request.post(`${API}/events/${event.id}/sessions`, {
      headers: auth,
      data: {
        startsAt: new Date(Date.now() + 50 * 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 50 * 86_400_000 + 2 * 3_600_000).toISOString(),
      },
    })
  ).json();
  await request.post(`${API}/events/ticket-types`, {
    headers: auth,
    data: {
      eventSessionId: session.id,
      name: 'Admission générale',
      priceMinor: 5000,
      quantityTotal: 40,
      maxPerOrder: 4,
    },
  });
  await request.post(`${API}/events/${event.id}/submit`, { headers: auth });
  const admin = await apiLogin(request, 'admin@eticketsgo.test');
  await request.post(`${API}/admin/events/${event.id}/review`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
    data: { decision: 'APPROVE' },
  });
  return { slug: event.slug };
}

test.describe('the storefront in French', () => {
  test.describe.configure({ mode: 'serial' });

  let fx: Fixture;
  let tokens: Awaited<ReturnType<typeof apiLogin>>;
  let buyerEmail: string;

  test.beforeAll(async ({ request }) => {
    fx = await freeEvent(request);
    buyerEmail = uniqueEmail('fr_buyer');
    await request.post(`${API}/auth/register`, {
      data: { email: buyerEmail, password: SEED_PASSWORD, fullName: 'Marie Tremblay' },
    });
    tokens = await apiLogin(request, buyerEmail);
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  test('1: the page declares its language, so a screen reader speaks French', async ({
    browser,
  }) => {
    /*
      WCAG 3.1.1, and the reason the `lang` attribute moved out of the root layout: it is a
      property of the CONTENT, and the content's language is only known once the locale
      segment has resolved. French text under `lang="en"` is read aloud by an English
      synthesiser and is genuinely unintelligible.

      Two FRESH contexts, because visiting the French page stores the choice — and that is
      correct: somebody who has switched to French should not be put back into English by
      opening the bare `/`. Asserting both in one browser would be asserting that the
      preference does not stick.
    */
    for (const [path, lang] of [
      ['/fr-CA', 'fr-CA'],
      ['/', 'en'],
    ] as const) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${CUSTOMER}${path}`, { waitUntil: 'networkidle' });
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await context.close();
    }
  });

  test('2: switching language stays on the same page', async ({ browser }) => {
    /*
      Somebody two thirds of the way through picking tickets who realises the page is in the
      wrong language must not lose the page. Sending them to the home page is the single most
      common way a language switcher is built wrong.

      A FRESH, SIGNED-OUT context on purpose, and both halves of that matter.

      Fresh, because the shared context has an `ETG_LOCALE` cookie by this point. A stored
      preference correctly outranks the URL, so the page would already have resolved to a
      language and the switch under test would have nothing left to do.

      Signed out, because that is who uses this control. Somebody who cannot read the page has
      not created an account yet, and the switcher has to work before they do.
    */
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${CUSTOMER}/events/${fx.slug}`, { waitUntil: 'networkidle' });
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');

      await page.getByLabel('Language').selectOption('fr-CA');

      await page.waitForURL(new RegExp(`/fr-CA/events/${fx.slug}$`), { timeout: 30_000 });
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr-CA');
    } finally {
      await context.close();
    }
  });

  test('3: an internal link keeps the reader in French', async ({ page }) => {
    /*
      The failure this is really about: `<Link href="/help">` from `next/link` renders that
      exact path, so on a French page it navigates to the ENGLISH help centre and silently
      puts the reader back into English with nothing to explain why. One such link anywhere
      in the shared chrome undoes the whole feature, which is why every internal link in this
      app comes from `@/i18n/navigation`.
    */
    await page.goto(`${CUSTOMER}/fr-CA`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Aide' }).click();

    await expect(page).toHaveURL(/\/fr-CA\/help/, { timeout: 30_000 });
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr-CA');
  });

  test('4: booking in French stays French all the way to the confirmation', async ({ page }) => {
    await page.goto(`${CUSTOMER}/fr-CA/events/${fx.slug}`, { waitUntil: 'networkidle' });

    // The storefront: French labels, and "Gratuit" rather than a currency-formatted zero.
    await expect(page.getByText('Gratuit').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Sous-total')).toBeVisible();
    await expect(page.getByText('Aucun paiement requis')).toBeVisible();

    await page.getByLabel('Quantité de Admission générale').selectOption('2');
    await page.getByRole('button', { name: 'Obtenir mes billets' }).click();

    // The confirmation, which is the page a customer reads most carefully.
    await expect(page).toHaveURL(/\/fr-CA\/booking\/[^/]+\/confirmation/, { timeout: 30_000 });
    await expect(page.getByText("C'est confirmé!")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Numéro de réservation')).toBeVisible();
    await expect(page.getByText('Coût')).toBeVisible();

    // And no English left behind. These are the words that survive a half-translation.
    const body = await page.locator('main, body').first().innerText();
    expect(body).not.toMatch(/\b(Booking reference|Total paid|You're going|All my tickets)\b/);
  });

  test('5: the receipt the customer keeps is in French too', async ({ request }) => {
    /*
      The document an inspector would ask for. It is rendered by the API, not by this app, so
      it is the surface most likely to be forgotten — and the one where being wrong matters
      most, because the customer keeps it.

      `?locale=` is how the storefront tells the API which language the reader is in. Without
      it the receipt would be rendered from the browser's Accept-Language, which is exactly
      the header a French speaker on an English-configured laptop does not have set.
    */
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const booking = await (
      await request.post(`${API}/bookings`, {
        headers: auth,
        data: {
          eventSessionId: fx.sessionId,
          items: [{ ticketTypeId: fx.ticketTypeId, quantity: 1 }],
          buyerName: 'Marie Tremblay',
          buyerEmail,
        },
      })
    ).json();
    expect(booking.status, `booking failed: ${JSON.stringify(booking)}`).toBe('CONFIRMED');

    const list = await (
      await request.get(`${API}/receipts/booking/${booking.id}`, { headers: auth })
    ).json();
    const receipts = Array.isArray(list) ? list : (list.data ?? []);
    expect(receipts.length, `no document issued for ${booking.id}`).toBeGreaterThan(0);

    const html = await (
      await request.get(`${API}/receipts/${receipts[0].id}/html?locale=fr-CA`, { headers: auth })
    ).text();

    expect(html).toContain('lang="fr-CA"');
    expect(html).toContain('Facturé à');
    expect(html).toContain('Sous-total');
    expect(html).not.toContain('Billed to');
    expect(html).not.toContain('Subtotal');

    // And the same document renders in English for an English reader.
    const english = await (
      await request.get(`${API}/receipts/${receipts[0].id}/html?locale=en`, { headers: auth })
    ).text();
    expect(english).toContain('lang="en"');
    expect(english).toContain('Billed to');
  });

  test('6: the PAID checkout is French too', async ({ page }) => {
    /*
      The surface the first version of this suite missed entirely.

      Every other test here books a FREE event, and a free booking skips the payment screen
      by design — so the suite walked storefront → confirmation and never once loaded the
      checkout. It passed, and the checkout was still in English. "Checkout" is named
      explicitly in the requirement, and it is where the customer commits money.
    */
    const paid = await paidEvent(page.request);
    await page.goto(`${CUSTOMER}/fr-CA/events/${paid.slug}`, { waitUntil: 'networkidle' });

    await page.getByLabel(/Quantité de/).selectOption('1');
    await page.getByRole('button', { name: 'Passer au paiement' }).click();

    await expect(page).toHaveURL(/\/fr-CA\/booking\/[^/]+\/payment/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Vérifier et payer' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByPlaceholder('Code de rabais')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr-CA');

    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/(Review & pay|Discount code|No hidden fees)/);
  });

  test('7: the ticket wallet is French', async ({ page }) => {
    // Where somebody goes to find the ticket they are about to show at a door.
    await page.goto(`${CUSTOMER}/fr-CA/account/tickets`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Mes expériences' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByLabel('Rechercher dans votre portefeuille')).toBeVisible();
  });

  test('6: a locale we do not ship is a 404, not a silent fallback', async ({ page }) => {
    /*
      `/de/events` rendering the English page would tell a search engine that a German URL
      exists and then serve it English content — and it would hide a typo in a link rather
      than surfacing it.
    */
    const res = await page.goto(`${CUSTOMER}/de/events`, { waitUntil: 'domcontentloaded' });
    expect(res?.status()).toBe(404);
  });
});
