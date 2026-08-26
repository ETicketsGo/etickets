import { test, expect } from '@playwright/test';
import { ORGANIZER, login, futureLocal } from './helpers';

test('organizer logs in and creates + submits an event via the wizard', async ({ page }) => {
  await login(page, ORGANIZER, 'owner@eticketsgo.test');
  await expect(page).toHaveURL(/\/organizer/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();

  const title = `E2E Event ${Date.now()}`;
  await page.goto(`${ORGANIZER}/organizer/events/new`);

  // Step 1 — basic details
  await page.getByLabel('Event title').fill(title);
  await page.getByLabel('Category').fill('Music');
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 2 — venue (pick the first existing venue)
  await page.getByLabel('Venue').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Next' }).click();

  /*
    Step 3 — sessions.

    Date and time are now two controls under one "Starts at" legend, not a single
    datetime-local. Driven by id rather than by label because both fieldsets contain a
    control labelled "Date": inside a group that is unambiguous to a screen reader, and
    ambiguous to a page-wide query. The ids are the wizard's own and are stable.
  */
  const [startDate, startTime] = futureLocal(30, 18).split('T');
  const [endDate, endTime] = futureLocal(30, 22).split('T');
  await page.locator('#ss0').fill(startDate);
  await page.locator('#se0').fill(endDate);
  // The half-hour select, which is what an organizer actually clicks. Targeted by id
  // because both fieldsets contain a control labelled "Time" — unambiguous inside its
  // group to a screen reader, ambiguous to a page-wide query.
  await page.locator('#ss0-time').selectOption(startTime);
  await page.locator('#se0-time').selectOption(endTime);

  /*
    The readback is the whole reason the field exists: it is what catches a mistyped year
    before an audience does.

    Asserted on the paragraph inside the group, not on the text anywhere on the page — the
    select's own <option> also reads "6:00 PM" and is hidden, so a looser query passes
    against a closed dropdown while the readback is missing entirely.
  */
  await expect(
    page.getByRole('group', { name: 'Starts at' }).getByRole('paragraph').filter({
      hasText: '6:00 PM',
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 4 — ticket types (defaults are prefilled)
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 5 — fee handling
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 6 — review & submit
  await expect(page.getByText(title)).toBeVisible();
  await page.getByRole('button', { name: 'Submit for approval' }).click();

  // Redirected to the event overview, now under review
  await expect(page).toHaveURL(/\/organizer\/events\/.+/, { timeout: 20_000 });
  await expect(page.getByText('Under Review').first()).toBeVisible({ timeout: 20_000 });

  // It shows up in the events list
  await page.goto(`${ORGANIZER}/organizer/events`);
  await expect(page.getByText(title)).toBeVisible();
});
