import { test, expect } from '@playwright/test';
import { CUSTOMER, API, apiLogin, seedBrowserAuth } from './helpers';

/**
 * A buyer can find their receipt again.
 *
 * ── WHY THIS TEST EXISTS ───────────────────────────────────────────────────────────
 * The Receipts page was empty for everybody, always. The API client declared
 * `/receipts/mine` as `Paged<MyReceiptRow>` - `{ data, meta }` - and the endpoint returns
 * `{ items, total, page, pageSize }`. `request<T>` casts the JSON without checking it, so the
 * wrong type compiled happily, the page read `data.data`, got undefined, and rendered "No
 * receipts yet" over the top of a buyer's real receipts.
 *
 * That page exists for one reason: somebody who closed the confirmation screen without saving
 * their receipt has no other route back to it. It was the one route that could never work.
 *
 * Nothing caught it because nothing tested this page, and a type is not a test when it is
 * asserted rather than checked - which is what every `request<T>` in the client does.
 *
 * ── WHY IT AUTHENTICATES THROUGH THE API ───────────────────────────────────────────
 * The storefront's sign-in is phone-first by design, so the `login()` helper - which fills an
 * Email box - belongs to the organizer and admin consoles, where that box is on screen. Every
 * customer-side spec seeds the tokens instead, and so does this one.
 */
test('a confirmed booking puts a receipt on the buyer’s receipts page', async ({
  page,
  context,
  request,
}) => {
  const tokens = await apiLogin(request, 'customer1@eticketsgo.test');
  await seedBrowserAuth(context, tokens);

  /*
    Asked of the API first, so a failure here says which of two things went wrong: a buyer
    with no receipts at all (a seed problem, and the page is right to say so) versus a buyer
    holding receipts the page refuses to show (the defect). Only the second is asserted below.
  */
  const mine = await request.get(`${API}/receipts/mine?page=1&pageSize=5`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  expect(mine.ok(), 'the receipts endpoint should answer').toBeTruthy();
  const issued = (await mine.json()).items ?? [];
  test.skip(
    issued.length === 0,
    'this customer holds no receipts in the seed, so there is nothing for the page to show',
  );

  await page.goto(`${CUSTOMER}/account/receipts`);
  await expect(page.getByRole('heading', { name: 'Receipts' })).toBeVisible({ timeout: 20_000 });

  // The document number the API returned, on the page. Not "a row exists" - an empty list and
  // a list of the wrong things both survive a looser assertion.
  await expect(page.getByText(issued[0].number)).toBeVisible({ timeout: 20_000 });

  // And the empty state is gone, which is the exact thing that was wrong.
  await expect(page.getByText('No receipts yet')).toHaveCount(0);
});
