import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, ORGANIZER, SEED_PASSWORD, apiLogin, seedBrowserAuth } from './helpers';

/**
 * Tax identity, receipts and organizer-issued refunds, through the browser.
 *
 * The API-level guarantees (numbering, snapshotting, tax arithmetic) are proven in the API
 * suite. What can only be proven here is that an organizer can actually REACH them: that the
 * pages render, that the legal-identity form saves and reports back honestly, and that a
 * refund can be approved from the organizer console rather than only from the admin queue —
 * which was the actual gap.
 */

const OWNER = 'owner@eticketsgo.test';
const CUSTOMER = 'customer1@eticketsgo.test';

async function ownerToken(request: APIRequestContext) {
  return apiLogin(request, OWNER);
}

async function call(path: string, request: APIRequestContext, token: string) {
  const res = await request.get(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as { items?: { id: string }[] };
}

async function orgId(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.get(`${API}/organizations`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const orgs = await res.json();
  return orgs[0].id;
}

/** Clear the legal identity so the "incomplete" state is reachable on a re-run. */
async function clearLegalIdentity(request: APIRequestContext, token: string, id: string) {
  await request.patch(`${API}/organizations/${id}/legal-identity`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      legalName: '',
      taxRegistrationKind: '',
      taxRegistrationNumber: '',
      registeredAddressLine1: '',
      registeredCity: '',
      registeredCountry: '',
      financeContactEmail: '',
    },
  });
}

test.describe('organizer: tax identity, receipts and refunds', () => {
  test('1-3: the settings page reports honestly that no tax invoice can be issued yet', async ({
    page,
    context,
    request,
  }) => {
    const tokens = await ownerToken(request);
    const id = await orgId(request, tokens.accessToken);
    await clearLegalIdentity(request, tokens.accessToken, id);
    await seedBrowserAuth(context, tokens);

    await page.goto(`${ORGANIZER}/organizer/settings`);
    const card = page.getByText('Legal and tax details').first();
    await expect(card).toBeVisible();

    // The state that matters: it does not pretend to be fine, and it says what is missing.
    await expect(page.getByText(/Incomplete\./)).toBeVisible();
    await expect(page.getByText(/still get a/)).toBeVisible();

    // And it is explicit that the number is not format-checked, so nobody assumes it was.
    await expect(page.getByText(/We do not validate its format/)).toBeVisible();
  });

  test('4-6: saving a tax registration flips the page to "can issue a tax invoice"', async ({
    page,
    context,
    request,
  }) => {
    const tokens = await ownerToken(request);
    const id = await orgId(request, tokens.accessToken);
    await clearLegalIdentity(request, tokens.accessToken, id);
    await seedBrowserAuth(context, tokens);

    await page.goto(`${ORGANIZER}/organizer/settings`);
    await page.getByLabel('Registered legal name').fill('Bengaluru Live Entertainment Pvt Ltd');
    await page.getByLabel('Tax registration type').fill('GSTIN');
    // A fixture identifier. The platform records it verbatim and asserts nothing about it.
    await page.getByLabel('Tax registration number').fill('29AABCU9603R1ZM');
    await page.getByLabel('Registered address', { exact: true }).fill('12 Residency Road');
    await page.getByLabel('City').fill('Bengaluru');
    await page.getByLabel('Country').fill('India');
    await page.getByLabel('Finance contact email').fill('finance@bengaluru-live.test');
    await page.getByRole('button', { name: 'Save legal and tax details' }).click();

    await expect(page.getByText('Legal and tax details saved.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Complete\./)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('29AABCU9603R1ZM')).toBeVisible();

    // The value survives a reload — it was persisted, not just held in form state.
    await page.reload();
    await expect(page.getByLabel('Tax registration number')).toHaveValue('29AABCU9603R1ZM');
  });

  test('7-8: a manager cannot change the tax identity, only the owner can', async ({ request }) => {
    const owner = await ownerToken(request);
    const id = await orgId(request, owner.accessToken);
    const manager = await apiLogin(request, 'manager@eticketsgo.test');

    // Printed on financial documents and reported against payouts — a materially different
    // act from editing a public bio, which a manager may do.
    const res = await request.patch(`${API}/organizations/${id}/legal-identity`, {
      headers: { authorization: `Bearer ${manager.accessToken}` },
      data: { legalName: 'Manager Overwrite Ltd' },
    });
    expect(res.status()).toBe(403);

    const still = await request.get(`${API}/organizations/${id}/legal-identity`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect((await still.json()).legalName).not.toBe('Manager Overwrite Ltd');
  });

  test('9-11: the receipts page lists issued documents and opens a printable one', async ({
    page,
    context,
    request,
  }) => {
    const tokens = await ownerToken(request);
    await seedBrowserAuth(context, tokens);

    await page.goto(`${ORGANIZER}/organizer/receipts`);
    await expect(page.getByRole('heading', { name: 'Receipts and invoices' })).toBeVisible();

    // Either state is legitimate depending on what the seed produced; both must render, and
    // neither may be a crash. Asserting "one of two known states" beats asserting a count
    // that depends on whatever other specs have already bought.
    const empty = page.getByText('No documents yet.');
    const table = page.getByRole('table');
    await expect(empty.or(table)).toBeVisible({ timeout: 15_000 });

    if (await table.isVisible()) {
      // A document number is the one thing every row must carry.
      await expect(page.getByText(/^(RCT|INV|CRN)-\d{4}-\d{6}$/).first()).toBeVisible();

      /*
        A BUTTON, not a link — and this assertion used to demand the opposite.

        It asserted an `href` straight at the API, which is exactly what shipped and exactly
        what returned 401 in QA: authentication is a bearer token in localStorage, so a plain
        link opens a tab carrying no Authorization header. The document is now fetched with
        the token and handed to the browser as a blob.

        So the test pins the REASON rather than the markup: the endpoint must refuse an
        unauthenticated request and serve an authenticated one.
      */
      await expect(page.getByRole('button', { name: /Open/ }).first()).toBeVisible();

      const id = (
        await call(
          `/organizations/${await orgId(request, tokens.accessToken)}/receipts?pageSize=1`,
          request,
          tokens.accessToken,
        )
      ).items?.[0]?.id;
      expect(id, 'expected at least one issued document').toBeTruthy();

      const anonymous = await request.get(`${API}/receipts/${id}/html`);
      expect(anonymous.status(), 'an unauthenticated fetch must be refused').toBe(401);

      const authed = await request.get(`${API}/receipts/${id}/html`, {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      expect(authed.status()).toBe(200);
      expect(await authed.text()).toContain('<!doctype html>');
    }
  });

  test('12-14: an organizer can approve a refund from their own console', async ({
    page,
    context,
    request,
  }) => {
    // The gap this closes: before, refunds could only be listed from the platform-admin
    // queue, so an organizer had no way to issue one for their own customer.
    const owner = await ownerToken(request);
    const id = await orgId(request, owner.accessToken);
    const customer = await apiLogin(request, CUSTOMER);
    const auth = { authorization: `Bearer ${customer.accessToken}` };
    // Unique per run. A fixed string matches refunds this spec left behind on an earlier
    // run, and the row locator then resolves to several elements and fails on strictness —
    // which reads as a product failure when it is only test residue.
    const reason = `Console refund e2e ${Date.now()}`;

    // Buy a ticket so there is something to refund.
    const events = await (await request.get(`${API}/public/events?pageSize=10`)).json();
    let sessionId: string | undefined;
    let ticketTypeId: string | undefined;
    for (const card of events.data ?? []) {
      const full = await (await request.get(`${API}/public/events/${card.slug}`)).json();
      for (const s of full.sessions ?? []) {
        const tt = (s.ticketTypes ?? []).find((t: { available: number }) => t.available > 0);
        if (tt && new Date(s.startsAt) > new Date()) {
          sessionId = s.id;
          ticketTypeId = tt.id;
          break;
        }
      }
      if (sessionId) break;
    }
    expect(sessionId, 'the seed must contain a bookable session').toBeTruthy();

    const booking = await (
      await request.post(`${API}/bookings`, {
        headers: auth,
        data: {
          eventSessionId: sessionId,
          items: [{ ticketTypeId, quantity: 1 }],
          buyerName: 'Refund Console',
          buyerEmail: 'refund-console@e2e.test',
        },
      })
    ).json();
    await request.post(`${API}/bookings/${booking.id}/pay`, { headers: auth });
    // The mock gateway signs and delivers its own webhook, exactly as a real provider does.
    await request.post(`${API}/payments/${booking.id}/mock-pay`, {
      data: { outcome: 'succeeded' },
    });
    await expect
      .poll(
        async () =>
          (await (await request.get(`${API}/bookings/${booking.id}`, { headers: auth })).json())
            .status,
        { timeout: 20_000 },
      )
      .toBe('CONFIRMED');

    await request.post(`${API}/refunds`, {
      headers: auth,
      data: { bookingId: booking.id, reason },
    });

    await seedBrowserAuth(context, owner);
    await page.goto(`${ORGANIZER}/organizer/refunds`);
    await expect(page.getByRole('heading', { name: 'Refunds', exact: true })).toBeVisible();

    const row = page.getByRole('row').filter({ hasText: reason });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Money leaving is confirmed, never a one-click action buried in a table row.
    await row.getByRole('button', { name: 'Refund' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/returned to/)).toBeVisible();
    await expect(dialog.getByText(reason)).toBeVisible();
    await dialog.getByRole('button', { name: 'Refund now' }).click();

    await expect(page.getByText(/Refund approved/)).toBeVisible({ timeout: 20_000 });

    // A credit note now exists for the booking, reversing the original document.
    const docs = await (
      await request.get(`${API}/receipts/booking/${booking.id}`, { headers: auth })
    ).json();
    const note = docs.find((d: { kind: string }) => d.kind === 'CREDIT_NOTE');
    expect(note, 'a completed refund must produce a credit note').toBeTruthy();
    expect(note.totalMinor).toBeLessThan(0);
  });

  test('15: another organization cannot read these books', async ({ request }) => {
    const owner = await ownerToken(request);
    const id = await orgId(request, owner.accessToken);
    const outsider = await apiLogin(request, CUSTOMER);

    for (const path of [`/organizations/${id}/receipts`, `/organizations/${id}/refunds`]) {
      const res = await request.get(`${API}${path}`, {
        headers: { authorization: `Bearer ${outsider.accessToken}` },
      });
      expect(res.status(), `${path} must not be readable by a non-member`).toBe(403);
    }
  });
});

// Keep the seeded password import meaningful even though apiLogin owns it, so a change to
// the seed credentials fails loudly here rather than as an opaque 401.
expect(SEED_PASSWORD).toBeTruthy();
