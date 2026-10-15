import { test, expect } from '@playwright/test';
import {
  API,
  ORGANIZER,
  apiLogin,
  seedBrowserAuth,
  uniqueEmail,
  NEW_ACCOUNT_PASSWORD,
} from './helpers';

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
  // Named "Space": organizer-space-inherits-venue asserts the Venues page never says "room", and this fixture
  // shares the database with it, so a "Room" here failed that guard whenever this spec ran first.
  const roomName = `Discovery Space ${stamp}`;

  test.beforeAll(async ({ request }) => {
    const email = uniqueEmail('discovery');
    await request.post(`${API}/auth/register`, {
      data: { email, password: NEW_ACCOUNT_PASSWORD, fullName: 'Discovery Organizer' },
    });
    const first = await apiLogin(request, email, NEW_ACCOUNT_PASSWORD);
    const org = await (
      await request.post(`${API}/organizations`, {
        headers: { Authorization: `Bearer ${first.accessToken}` },
        data: { name: `Discovery Org ${stamp}`, supportEmail: email },
      })
    ).json();
    organizationId = org.id;
    // Re-issued: the first token predates the organizer role the organization grants.
    tokens = await apiLogin(request, email, NEW_ACCOUNT_PASSWORD);
  });

  test.beforeEach(async ({ context }) => {
    await seedBrowserAuth(context, tokens);
  });

  test('1: the sidebar names what the section is for, not what the rows are called', async ({
    page,
  }) => {
    await page.goto(`${ORGANIZER}/organizer`, { waitUntil: 'networkidle' });

    /*
      "Cinemas" was the original problem. The rows underneath really are cinema records — a
      Cinema owns a Screen and a Screen owns the seat map — but the label has to answer
      "would I click this to draw a seating plan for my concert?", and that one did not.

      Renaming it to "Rooms & seat maps" fixed the word and left the real fault: it was a
      SECOND places section beside "Venues", so setting up one site meant crossing between
      them. They are now one entry, labelled with the platform's word for the thing, because that is the
      word that made seat maps findable at all.
    */
    const rooms = page.getByRole('link', { name: 'Venues & seating' });
    await expect(rooms).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: 'Cinemas', exact: true })).toHaveCount(0);
    // The split itself is what regressed last time; assert there is exactly one way in.
    await expect(page.getByRole('link', { name: 'Venues', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Rooms & seat maps' })).toHaveCount(0);
  });

  test('2: the cinema list says what it is, and sends everybody else to a hall or arena', async ({
    page,
  }) => {
    await page.goto(`${ORGANIZER}/organizer/cinemas`, { waitUntil: 'networkidle' });

    /*
      This list was titled "Spaces" while every row was a CINEMA, and its "New space" button
      created a cinema named after the space. It is called what it is now, and somebody
      running gigs is pointed at the hall or arena they actually want.
    */
    await expect(page.getByText(/No cinemas yet/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/add a hall or an arena/i)).toBeVisible();
    await expect(page.getByText(/scheduling screenings/)).toHaveCount(0);
  });

  test('3: the setup checklist mentions seating, and does not nag about it', async ({ page }) => {
    await page.goto(`${ORGANIZER}/organizer/onboarding`, { waitUntil: 'networkidle' });

    await expect(page.getByText('Set up a space with a seat map').first()).toBeVisible({
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
    /*
      One form: where it is (this organization has no venue yet, so it is asked once), what the
      space is called and what kind of place it is. It used to create a CINEMA here and land on
      it, so a hall had to be added as a "screen" inside a cinema named after the hall.
    */
    await page.goto(`${ORGANIZER}/organizer/spaces/new`, { waitUntil: 'networkidle' });
    await page.locator('#venue-name').fill(locationName);
    await page.locator('#venue-city').fill('Hyderabad');
    await page.getByTestId('kind-SEATED_HALL').click();
    await page.locator('#space-name').fill(roomName);
    await page.locator('#space-capacity').fill('18');
    await page.getByRole('button', { name: 'Create space' }).click();
    await expect(page).toHaveURL(/\/organizer\/spaces\/(?!new$)[^/]+$/, { timeout: 30_000 });
    // It lands on the space it made, not on a page with a list of spaces inside it.
    await expect(page.getByRole('heading', { level: 1, name: roomName })).toBeVisible();

    const spaceId = page.url().split('/').filter(Boolean).pop()!;
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const space = await (
      await request.get(`${API}/venues/spaces/${spaceId}`, { headers: auth })
    ).json();
    expect(space.kind).toBe('SEATED_HALL');
    expect(space.cinemaId, 'a hall is not a cinema').toBeNull();

    await page.getByRole('link', { name: 'Draw the rows yourself' }).first().click();
    await expect(page).toHaveURL(/\/seatmap$/, { timeout: 30_000 });
    await page.locator('#sec-0-name').fill('Stalls');
    await page.locator('#sec-0-cat').fill('Stalls');
    await page.locator('#sec-0-price').fill('500');
    /*
      Described by capacity, which is the primary path the console offers — "about how many
      seats?" plus a room shape, with rows and seats-per-row derived. The exact row/seat boxes
      still exist behind a "Set it exactly" panel, and the first version of this test drove
      those: it filled controls nobody has to open, so it was testing a fallback rather than
      the journey an organizer actually takes.
    */
    await page.locator('#room-capacity').fill('18');
    // Whole rows rarely land on exactly the number asked for; when they do not, the organizer
    // confirms the real number before the room is created.
    await expect(page.getByTestId('bookable-count')).toBeVisible();
    const confirm = page.getByRole('checkbox', { name: /confirm that \d+ seats/ });
    if (await confirm.isVisible()) await confirm.check();
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
