import { test, expect, type APIRequestContext, type BrowserContext } from '@playwright/test';
import {
  API,
  CUSTOMER,
  NEW_ACCOUNT_PASSWORD,
  apiLogin,
  seedBrowserAuth,
  uniqueEmail,
} from './helpers';

type DemoEvent = {
  venue: { country: string; timezone: string };
  sessions: Array<{
    id: string;
    ticketTypes: Array<{
      id: string;
      name: string;
      currency: string;
      available: number;
      inventoryKind?: 'SEAT' | 'ZONE';
    }>;
  }>;
};

async function demo(request: APIRequestContext, slug: string): Promise<DemoEvent> {
  const response = await request.get(`${API}/public/events/${slug}`);
  const body = await response.json();
  expect(response.ok(), `${slug} demo fixture is missing: ${JSON.stringify(body)}`).toBe(true);
  return body;
}

async function signedInBuyer(request: APIRequestContext, context: BrowserContext, label: string) {
  const email = uniqueEmail(label);
  await request.post(`${API}/auth/register`, {
    data: { email, password: NEW_ACCOUNT_PASSWORD, fullName: label },
  });
  const tokens = await apiLogin(request, email, NEW_ACCOUNT_PASSWORD);
  await seedBrowserAuth(context, tokens);
  return { email, tokens };
}

test.describe('intentional demo venue buyer paths', () => {
  test.describe.configure({ mode: 'serial' });

  test('GA and VIP quantities use mapped zone capacity and reach checkout', async ({
    page,
    context,
    request,
  }) => {
    const event = await demo(request, 'riverbend-ga-vip');
    expect(event.sessions[0].ticketTypes.every((type) => type.inventoryKind === 'ZONE')).toBe(true);
    const before = new Map(
      event.sessions[0].ticketTypes.map((type) => [type.name, type.available]),
    );
    await signedInBuyer(request, context, 'zone_buyer');

    await page.goto(`${CUSTOMER}/events/riverbend-ga-vip`, { waitUntil: 'networkidle' });
    const ga = page.getByLabel('Quantity of General Admission');
    const vip = page.getByLabel('Quantity of VIP Pit');
    await expect(ga).toBeVisible();
    await expect(vip).toBeVisible();
    await ga.selectOption('2');
    await vip.selectOption('1');
    await expect(page.getByText(/\$280\.00/)).toBeVisible();
    await page.getByRole('button', { name: /Continue to payment/i }).click();
    await expect(page).toHaveURL(/\/booking\/[^/]+\/payment/, { timeout: 30_000 });
    await page.getByRole('button', { name: /^Pay/ }).click();
    await expect(page).toHaveURL(/\/booking\/[^/]+\/confirmation/, { timeout: 30_000 });

    const after = await demo(request, 'riverbend-ga-vip');
    const availability = new Map(
      after.sessions[0].ticketTypes.map((type) => [type.name, type.available]),
    );
    expect(availability.get('General Admission')).toBe(before.get('General Admission')! - 2);
    expect(availability.get('VIP Pit')).toBe(before.get('VIP Pit')! - 1);
  });

  test('Hyderabad auditorium sells three irregular-map seats in INR', async ({
    page,
    context,
    request,
  }) => {
    const event = await demo(request, 'hyderabad-reserved-auditorium');
    expect(event.venue).toMatchObject({ country: 'India', timezone: 'Asia/Kolkata' });
    expect(event.sessions[0].ticketTypes.every((type) => type.currency === 'INR')).toBe(true);
    await signedInBuyer(request, context, 'auditorium_buyer');

    await page.goto(`${CUSTOMER}/events/hyderabad-reserved-auditorium`, {
      waitUntil: 'networkidle',
    });
    await page.getByRole('link', { name: 'Choose seats' }).click();
    await expect(page.getByText('STAGE', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Platinum Centre/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Gold Left/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Silver Balcony/ })).toBeVisible();
    await page.getByRole('button', { name: /Platinum Centre/ }).click();
    const seats = page.getByRole('button', { name: /^Seat / }).and(page.locator(':enabled'));
    await seats.nth(0).click();
    await seats.nth(1).click();
    await seats.nth(2).click();
    await expect(page.getByText('Total (3 seats)')).toBeVisible();
    await expect(page.getByText(/₹|INR/).first()).toBeVisible();
    await page
      .getByRole('button', { name: /Proceed to pay/i })
      .last()
      .click();
    await expect(page).toHaveURL(/\/booking\/[^/]+\/payment/, { timeout: 30_000 });
  });

  test('theater uses the same reserved-seat buyer engine', async ({ page, context, request }) => {
    await demo(request, 'old-mill-reserved-theater');
    await signedInBuyer(request, context, 'theater_buyer');
    await page.goto(`${CUSTOMER}/events/old-mill-reserved-theater`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Choose seats' }).click();
    await expect(page.getByText('STAGE', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Stalls/ }).click();
    const seat = page
      .getByRole('button', { name: /^Seat / })
      .and(page.locator(':enabled'))
      .first();
    await seat.click();
    await expect(seat).toHaveAttribute('aria-pressed', 'true');
    await page
      .getByRole('button', { name: /Proceed to pay/i })
      .last()
      .click();
    await expect(page).toHaveURL(/\/booking\/[^/]+\/payment/, { timeout: 30_000 });
  });

  for (const width of [320, 390, 412]) {
    for (const fixture of [
      { slug: 'demo-arena-basketball', section: /1(?:01|02)/ },
      { slug: 'hyderabad-reserved-auditorium', section: /Platinum Centre/ },
    ]) {
      test(`${fixture.slug} is operable at ${width}px`, async ({ page, request }) => {
        const event = await demo(request, fixture.slug);
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${CUSTOMER}/shows/${event.sessions[0].id}`);
        await expect(page.getByText(/COURT|STAGE/, { exact: true })).toBeVisible();
        await page.getByRole('button', { name: fixture.section }).first().click();
        const seat = page
          .getByRole('button', { name: /^Seat / })
          .and(page.locator(':enabled'))
          .first();
        await seat.click();
        await expect(seat).toHaveAttribute('aria-pressed', 'true');
        await seat.click();
        await expect(seat).toHaveAttribute('aria-pressed', 'false');
        await page.getByRole('button', { name: 'Zoom in' }).click();
        const pan = await page.getByTestId('seat-map-scroll').evaluate((element) => {
          element.scrollLeft = 40;
          return {
            scrollLeft: element.scrollLeft,
            overflow: element.scrollWidth - element.clientWidth,
          };
        });
        expect(pan.overflow).toBeGreaterThan(0);
        expect(pan.scrollLeft).toBeGreaterThan(0);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      });
    }
  }
});
