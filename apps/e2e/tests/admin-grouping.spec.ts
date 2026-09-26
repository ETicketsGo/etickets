import { test, expect, type Page } from '@playwright/test';
import { ADMIN, login } from './helpers';

/**
 * The grouped summary above each admin queue.
 *
 * ── WHY THIS IS AN E2E TEST AND NOT ONLY A UNIT ONE ────────────────────────────────
 * The API side of this is covered by unit and real-Postgres specs, and both were green while the
 * feature was broken in two ways that only a browser could see.
 *
 * The first: the API required a `groupKey` whenever a `groupBy` was sent, treating "a grouping is
 * chosen but no group has been clicked" as a caller's mistake. That is the state the screen is in
 * most of the time, so the moment an operator picked "Country" from the dropdown, the list under
 * it answered 400 and emptied.
 *
 * The second: the summary counted every row of the resource while the list under it was filtered.
 * The refund queue opens on REQUESTED, so it read "India - 1 row" above an empty table. Both
 * numbers were right on their own and the pair was useless.
 *
 * Neither is visible from a unit test, because neither is a wrong answer to the question that
 * test asks. So the checks here are about the two things TOGETHER: choosing a grouping must not
 * change the list, and choosing a group must narrow it.
 */

/** Row count of the queue's table. A queue with nothing in it renders no table at all. */
async function rowCount(page: Page): Promise<number> {
  return page.locator('table tbody tr').count();
}

/**
 * Waits for the list to have rendered something, whichever way it rendered.
 *
 * Not a wait for a table: an empty queue shows an empty state instead, and a hard wait for a
 * table hangs there for the full timeout. Not `networkidle` either - that never falls quiet
 * against a dev server, which keeps a hot-reload socket open for the life of the page.
 */
async function listSettled(page: Page): Promise<void> {
  await page
    .locator('table, [role="status"]')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => {});
}

/**
 * Does something that refetches a queue, and waits for THAT request.
 *
 * The wait is armed before the action, not after it: a response that has already arrived is never
 * seen by a wait registered afterwards. Every count taken after this is still polled rather than
 * read once, because the response landing and React committing the rows are two different moments.
 */
async function refetching(page: Page, path: string, action: () => Promise<void>): Promise<void> {
  const settled = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === 'GET',
    { timeout: 20_000 },
  );
  await action();
  await settled;
  await listSettled(page);
}

/** A row count that tolerates the render lag but not a wrong answer. */
async function expectRows(page: Page, expected: number, message: string): Promise<void> {
  await expect.poll(() => rowCount(page), { message, timeout: 20_000 }).toBe(expected);
}

const QUEUES: { queue: string; heading: string; grouping: string }[] = [
  { queue: 'bookings', heading: 'Bookings', grouping: 'Country' },
  { queue: 'payments', heading: 'Payments', grouping: 'Country' },
  { queue: 'refunds', heading: 'Refunds', grouping: 'Country' },
  { queue: 'events', heading: 'Events', grouping: 'Organizer' },
  { queue: 'organizers', heading: 'Organizers', grouping: 'Country' },
  { queue: 'settlements', heading: 'Settlements', grouping: 'Currency' },
];

/*
  One test per queue, not one loop inside one test.

  Six queues, each with a page load, a summary fetch, a scoped refetch and a restore, does not fit
  in the 60-second budget - the run died two queues from the end with "target page has been
  closed", which reads like a crash and was a timeout. Separately, a failure now names the queue
  in its title instead of being the fifth assertion of one long test.
*/
for (const { queue, heading, grouping } of QUEUES) {
  test(`${queue}: the grouped summary agrees with the list`, async ({ page }) => {
    const failures: string[] = [];
    page.on('response', (r) => {
      if (!r.url().includes('/api/admin/') || r.ok()) return;
      const u = new URL(r.url());
      failures.push(`${r.status()} ${u.pathname}${u.search}`);
    });

    await login(page, ADMIN, 'admin@eticketsgo.test');
    await expect(page).toHaveURL(/\/admin/, { timeout: 20_000 });

    await page.goto(`${ADMIN}/admin/${queue}`);
    // `level: 1` because several of these pages name their results card after the page too, and
    // an unlevelled heading match resolves to both and fails strict mode.
    await expect(page.getByRole('heading', { name: heading, exact: true, level: 1 })).toBeVisible();

    const groupBy = page.getByLabel('Group by');
    await expect(groupBy).toBeVisible({ timeout: 20_000 });

    await listSettled(page);
    // Settled once and read once: this is the baseline, and there is nothing to compare it to yet.
    await page.waitForTimeout(500);
    const plain = await rowCount(page);

    await refetching(page, `/api/admin/grouped/${queue}`, () =>
      groupBy.selectOption({ label: grouping }),
    );

    // A grouping on its own narrows nothing. This is the 400 described at the top of the file.
    await expectRows(page, plain, `${queue}: choosing a grouping changed the unscoped list`);

    const chips = page.locator('button[aria-pressed]');
    if ((await chips.count()) === 0) {
      /*
        No groups means no rows, because every row belongs to exactly one group. An empty summary
        over a list with rows in it is the disagreement this test exists to catch, so it is an
        assertion rather than a skip.
      */
      expect(plain, `${queue}: summary found no groups but the list has rows`).toBe(0);
      expect(failures, 'admin requests that failed while grouping').toEqual([]);
      return;
    }

    const first = chips.first();
    // The count the chip claims, read off the chip itself: "India / 4 rows / 7,043.01".
    const claimed = Number(
      (await first.innerText()).match(/([\d,]+) rows?/)?.[1]?.replace(/,/g, '') ?? '0',
    );
    expect(claimed, `${queue}: a group with no rows should not be shown`).toBeGreaterThan(0);

    await refetching(page, `/api/admin/${queue}`, () => first.click());
    await expect(first).toHaveAttribute('aria-pressed', 'true');

    /*
      The group's own claim, checked against the rows the list then shows. Only up to the page
      size: beyond fifteen the list is showing page one of the group, not the group.
    */
    if (claimed <= 15) {
      await expectRows(page, claimed, `${queue}: the group claims ${claimed} rows`);
    } else {
      await expect.poll(() => rowCount(page), { timeout: 20_000 }).toBeLessThanOrEqual(plain);
    }

    /*
      And back: clearing the group restores the whole list without clearing the grouping.

      Waited for in the DOM, NOT as a request. Going back to the unscoped list returns to a query
      key React Query has already cached, so it answers from memory and no request is made at all
      - a wait for one sits there until it times out.
    */
    await page.getByRole('button', { name: 'Show all groups' }).click();
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await expectRows(page, plain, `${queue}: clearing the group did not restore the list`);
    await expect(groupBy).toHaveValue(grouping.toLowerCase());

    expect(failures, 'admin requests that failed while grouping').toEqual([]);
  });
}

test('the grouped summary fits a phone', async ({ page }) => {
  /*
    Four admin tables have already shipped wider than their box. The summary is a wrapping row of
    chips rather than a table of counts precisely so it cannot join them, and this is the check
    that says so.
  */
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, ADMIN, 'admin@eticketsgo.test');
  await page.goto(`${ADMIN}/admin/bookings`);

  const groupBy = page.getByLabel('Group by');
  await expect(groupBy).toBeVisible({ timeout: 20_000 });
  await refetching(page, '/api/admin/grouped/bookings', () =>
    groupBy.selectOption({ label: 'Country' }),
  );

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page scrolls sideways at phone width').toBeLessThanOrEqual(2);
});
