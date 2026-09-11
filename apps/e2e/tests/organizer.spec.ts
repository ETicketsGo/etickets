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
  // A dropdown now, not a text box: browse builds its category list with `distinct`
  // over this column, so every typo an organizer typed became its own row on the front page.
  await page.getByLabel('Category').selectOption('Music');
  /*
    Images, as an organizer adds them — two at once. The picker resizes each in the browser
    before it is ever sent, so a one-pixel PNG goes up as a JPEG, which is what the API is
    asserted to store. The first is the cover.
  */
  const pixel = (name: string) => ({
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  await page.getByLabel('Event images').setInputFiles([pixel('poster.png'), pixel('venue.png')]);
  await expect(page.getByRole('img', { name: /^Event image \d of 2/ })).toHaveCount(2);
  await expect(page.getByRole('img', { name: 'Event image 1 of 2, the cover' })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 2 — venue (pick the first existing venue)
  await page.getByLabel('Venue').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Next', exact: true }).click();

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
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 4 — ticket types (defaults are prefilled)
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 5 — fee handling
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 6 — review & submit
  await expect(page.getByText(title)).toBeVisible();
  await page.getByRole('button', { name: 'Submit for approval' }).click();

  // Redirected to the event overview, now under review
  await expect(page).toHaveURL(/\/organizer\/events\/.+/, { timeout: 20_000 });
  await expect(page.getByText('Under Review').first()).toBeVisible({ timeout: 20_000 });
  const eventId = new URL(page.url()).pathname.split('/').filter(Boolean).pop()!;

  // It shows up in the events list
  await page.goto(`${ORGANIZER}/organizer/events`);
  await expect(page.getByText(title)).toBeVisible();

  /*
    Both images went up with the event, in order, and the API serves each as an image anyone's
    page can load.
  */
  await page.goto(`${ORGANIZER}/organizer/events/${eventId}/edit`);
  const tiles = page.getByRole('img', { name: /^Event image \d of 2/ });
  await expect(tiles).toHaveCount(2, { timeout: 20_000 });
  const firstSrc = await tiles.nth(0).getAttribute('src');
  const secondSrc = await tiles.nth(1).getAttribute('src');
  expect(firstSrc).toMatch(/\/public\/events\/[^/]+\/images\/[^/?]+\?v=[0-9a-f]{16}$/);
  expect(secondSrc).not.toBe(firstSrc);
  const served = await page.request.get(firstSrc!);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toBe('image/jpeg');
  expect(served.headers()['cross-origin-resource-policy']).toBe('cross-origin');

  // The second becomes the cover, and the order is saved — not just redrawn.
  await page.getByRole('button', { name: 'Make cover: image 2' }).click();
  await expect(page.getByRole('img', { name: 'Event image 1 of 2, the cover' })).toHaveAttribute(
    'src',
    secondSrc!,
  );
  await page.reload();
  await expect(page.getByRole('img', { name: 'Event image 1 of 2, the cover' })).toHaveAttribute(
    'src',
    secondSrc!,
    { timeout: 20_000 },
  );

  /*
    Reported from QA: "I created an event and published it; creating a new event still shows
    the previous event's review page". The draft was cleared and then written straight back.
    A new wizard after a submitted one starts empty.
  */
  await page.goto(`${ORGANIZER}/organizer/events/new`);
  await expect(page.getByLabel('Event title')).toHaveValue('');
  await expect(page.getByText(/Picked up where you left off/)).toHaveCount(0);
});
