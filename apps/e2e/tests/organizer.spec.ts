import { test, expect } from '@playwright/test';
import { ORGANIZER, login, futureLocal } from './helpers';

test('organizer logs in and creates + submits an event via the wizard', async ({ page }) => {
  await login(page, ORGANIZER, 'owner@eticketsgo.test');
  await expect(page).toHaveURL(/\/organizer/, { timeout: 20_000 });
  // The Overview's heading is the organization's name; the welcome is the line under it.
  await expect(page.getByText(/^Welcome back/)).toBeVisible();

  const title = `E2E Event ${Date.now()}`;
  await page.goto(`${ORGANIZER}/organizer/events/new`);

  // First the kind of event, then step 1 - the basics. Music is a concert's first category.
  await page.getByRole('radio', { name: 'Concert or live music' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Event title').fill(title);
  await expect(
    page.getByRole('group', { name: 'Category' }).getByRole('radio', { name: 'Music' }),
  ).toBeChecked();
  /*
    Images, as an organizer adds them - two at once, on the first step beside the title. The
    picker resizes each in the browser before it is ever sent, so a one-pixel PNG goes up as a
    JPEG, which is what the API is asserted to store. The first is the cover.
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
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 2 - where and when: the venue (the first saved one) and the performances, together
  await page.getByRole('group', { name: 'Venue' }).getByRole('radio').first().check();

  /*
    Date and time are two controls under one "Starts at" legend, inside the "Performance 1"
    group - so they are reached by label, scoped by the groups a screen reader announces.
  */
  const [startDate, startTime] = futureLocal(30, 18).split('T');
  const [endDate, endTime] = futureLocal(30, 22).split('T');
  const performance = page.getByRole('group', { name: 'Performance 1' });
  const starts = performance.getByRole('group', { name: 'Starts at' });
  const ends = performance.getByRole('group', { name: 'Ends at' });
  await starts.getByLabel('Date').fill(startDate);
  await ends.getByLabel('Date').fill(endDate);
  await starts.getByLabel('Time').selectOption(startTime);
  await ends.getByLabel('Time').selectOption(endTime);

  /*
    The readback is the whole reason the field exists: it is what catches a mistyped year
    before an audience does.

    Asserted on the paragraph inside the group, not on the text anywhere on the page - the
    select's own <option> also reads "6:00 PM" and is hidden, so a looser query passes
    against a closed dropdown while the readback is missing entirely.
  */
  await expect(starts.getByRole('paragraph').filter({ hasText: '6:00 PM' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  /*
    Step 3 - tickets. How people get in is asked first, and a paid event's price is typed by
    the organizer: the first row arrives named "General" with 100 on sale, but no price is
    ever chosen for them in a currency they have not seen yet.
  */
  await page.getByRole('radio', { name: 'Paid - general admission' }).check();
  await page
    .getByRole('group', { name: 'Ticket type 1' })
    .getByLabel(/^Price/)
    .fill('499');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 4 - details: nothing required.
  await page.getByRole('button', { name: 'Continue' }).click();

  /*
    Step 5 - review.

    There is no longer a "Fee handling" step. It was one dropdown with the right default
    already selected, standing between an organizer and their first published event; the
    control now lives on Review, answered and changeable.
  */
  // The title as the buyer's card shows it, in the live preview of that card.
  await expect(
    page.getByRole('group', { name: 'Preview of your event card' }).getByRole('heading', {
      name: title,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Submit for approval' }).click();

  /*
    Redirected to the event overview, now under review.

    The URL must be the EVENT's, not the wizard's: `/organizer/events/new` also matches
    `/organizer/events/.+`, and the wizard's review step itself says "In review" ("Its status
    is In review until then"). With the loose pattern both checks passed while the wizard was
    still uploading the images, and the next navigation cancelled the upload. The status is
    read from the event header - its title as the page heading, and its stage badge - which
    only the event's own pages draw.
  */
  await expect(page).toHaveURL(/\/organizer\/events\/(?!new(?:[/?#]|$))[^/?#]+$/, {
    timeout: 20_000,
  });
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('Stage: In review').first()).toBeVisible();
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
  // The original URL now serves the upright, metadata-free WebP copy of the upload.
  expect(served.headers()['content-type']).toBe('image/webp');
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
    A new wizard after a submitted one starts empty: on the first question, nothing chosen.
  */
  await page.goto(`${ORGANIZER}/organizer/events/new`);
  await expect(page.getByRole('radio', { name: 'Concert or live music' })).not.toBeChecked({
    timeout: 20_000,
  });
  await expect(page.getByLabel('Event title')).toHaveCount(0);
  await expect(page.getByText(/Picked up where you left off/)).toHaveCount(0);
});
