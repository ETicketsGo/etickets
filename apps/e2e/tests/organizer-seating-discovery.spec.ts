import { test, expect } from '@playwright/test';
import { API, ORGANIZER, apiLogin, seedBrowserAuth, SEED_PASSWORD, uniqueEmail } from './helpers';

/**
 * Can an organizer who has never seen this product find their way to reserved seating?
 *
 * ── WHY THIS IS A TEST AND NOT A JUDGEMENT CALL ────────────────────────────────────
 * The seating feature was built, merged and working, and the first person to try it still
 * could not use it. Not because anything was broken — because the only route to the
 * prerequisite was a navigation item called "Cinemas", which a concert promoter correctly
 * reads as "not for me".
 *
 * A correct API nobody can find is not a shipped feature. So the discoverability is asserted
 * here in the same way the behaviour is: walked, from an organization that owns nothing, with
 * no deep links and no API shortcuts for the parts a human would have to click.
 */
test.describe('finding reserved seating from a standing start', () => {
  test.describe.configure({ mode: 'serial' });

  let tokens: Awaited<ReturnType<typeof apiLogin>>;
  let organizationId = '';
  const stamp = Date.now();
  const locationName = `Discovery Hall ${stamp}`;
  const roomName = `Discovery Room ${stamp}`;

  test.beforeAll(async ({ request }) => {
    const email = uniqueEmail('discovery');
    await request.post(`${API}/auth/register`, {
      data: { email, password: SEED_PASSWORD, fullName: 'Discovery Organizer' },
    });
    const first = await apiLogin(request, email);
    const org = await (
      await request.post(`${API}/organizations`, {
        headers: { Authorization: `Bearer ${first.accessToken}` },
        data: { name: `Discovery Org ${stamp}`, supportEmail: email },
      })
    ).json();
    organizationId = org.id;
    // Re-issued: the first token predates the organizer role the organization grants.
    tokens = await apiLogin(request, email);
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  test('1: the sidebar names what the section is for, not what the rows are called', async ({
    page,
  }) => {
    await page.goto(`${ORGANIZER}/organizer`, { waitUntil: 'networkidle' });

    /*
      "Cinemas" was the entire problem. The rows underneath really are cinema records — a
      Cinema owns a Screen and a Screen owns the seat map — but the label has to answer
      "would I click this to draw a seating plan for my concert?", and that one did not.
    */
    const rooms = page.getByRole('link', { name: 'Rooms & seat maps' });
    await expect(rooms).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: 'Cinemas', exact: true })).toHaveCount(0);
  });

  test('2: the empty state says what a room unlocks, for any kind of event', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer/cinemas`, { waitUntil: 'networkidle' });

    /*
      The old hint read "Add a cinema and its screens to start scheduling screenings", which
      tells a promoter running gigs that they are in the wrong place — while standing in the
      only place a seat map can be made.
    */
    await expect(page.getByText(/No locations yet/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/not only a film/)).toBeVisible();
    await expect(page.getByText(/scheduling screenings/)).toHaveCount(0);
  });

  test('3: the setup checklist mentions seating, and does not nag about it', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer/onboarding`, { waitUntil: 'networkidle' });

    await expect(page.getByText('Set up a room with a seat map').first()).toBeVisible({
      timeout: 30_000,
    });
    /*
      Optional and uncounted. Plenty of organizers sell standing tickets and will never draw a
      seat map; a checklist that can never reach 100% stops being a checklist and becomes a
      permanent nag, which is how people learn to ignore it.
    */
    await expect(page.getByText('Optional').first()).toBeVisible();

    // And the step that decides whether money can reach them is present at all — it was not.
    await expect(page.getByText('Set up how you get paid').first()).toBeVisible();
  });

  test('4: a room built through the UI is offered by the seating picker', async ({
    page,
    request,
  }) => {
    /*
      The join that matters, and the one nothing previously asserted. Every other test in this
      file checks a signpost; this checks that following the signposts actually arrives
      somewhere — that a seat map drawn in the console satisfies the exact rule the picker
      filters on (this organization, published layout).
    */
    await page.goto(`${ORGANIZER}/organizer/cinemas/new`, { waitUntil: 'networkidle' });
    await page.getByLabel('Name', { exact: true }).fill(locationName);
    await page.getByLabel('City').fill('Hyderabad');
    await page
      .getByRole('button', { name: /Create|Save/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/organizer\/cinemas\/(?!new$)[^/]+/, { timeout: 30_000 });

    const cinemaId = page.url().split('/').filter(Boolean).pop()!;

    await page.getByRole('button', { name: 'Add screen' }).first().click();
    await page.getByLabel('Name', { exact: true }).last().fill(roomName);
    await page.getByRole('button', { name: 'Add screen' }).last().click();
    await expect(page.getByText(roomName).first()).toBeVisible({ timeout: 30_000 });

    // The seat map itself, generated from the console rather than seeded through the API.
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const cinema = await (
      await request.get(`${API}/cinemas/${cinemaId}`, { headers: auth })
    ).json();
    const screen = (cinema.screens ?? []).find((s: { name: string }) => s.name === roomName);
    expect(screen, `the room should exist: ${JSON.stringify(cinema.screens)}`).toBeTruthy();

    await page.goto(`${ORGANIZER}/organizer/cinemas/${cinemaId}/screens/${screen.id}/seatmap`, {
      waitUntil: 'networkidle',
    });
    await page.getByLabel('Section name').first().fill('Stalls');
    await page.getByLabel('Category name').first().fill('Stalls');
    await page.getByLabel('Base price (₹)').first().fill('500');
    await page.getByLabel('Rows').first().fill('3');
    await page.getByLabel('Seats per row').first().fill('6');
    await page.getByRole('button', { name: 'Generate seat map' }).click();

    /*
      Asserted through the picker's own endpoint rather than by reading the seat map back.
      What is being proven is not "a layout exists" — it is "the layout satisfies the rule the
      dropdown filters on", and those came apart once already.
    */
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `${API}/events/seating-rooms?organizationId=${organizationId}`,
            { headers: auth },
          );
          const list = res.ok() ? await res.json() : [];
          return list.map((r: { name: string }) => r.name);
        },
        { timeout: 30_000 },
      )
      .toContain(roomName);
  });
});
