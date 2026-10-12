import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, CUSTOMER, apiLogin } from './helpers';

/**
 * Two things the customer-journey review found a buyer could not trust (QA, 2026-10-12):
 *
 *  1. A ticket tier whose sales window had ended was offered with "10 left"; the buyer chose it,
 *     typed their details and was refused at the last step with "is not currently on sale".
 *  2. The payment screen said "Refundable per policy" and nothing else, even for an event with
 *     refunds switched off, and never showed the organizer's own terms.
 */
const ORGANIZER_EMAIL = 'owner@eticketsgo.test';

async function publishedEvent(request: APIRequestContext) {
  const { accessToken } = await apiLogin(request, ORGANIZER_EMAIL);
  const auth = { Authorization: `Bearer ${accessToken}` };
  const orgs = await (await request.get(`${API}/organizations`, { headers: auth })).json();
  const organizationId = (Array.isArray(orgs) ? orgs : orgs.data)[0].id;
  const venues = await (
    await request.get(`${API}/venues?organizationId=${organizationId}`, { headers: auth })
  ).json();
  const venueId = (Array.isArray(venues) ? venues : venues.data)[0].id;
  const created = await (
    await request.post(`${API}/events`, {
      headers: auth,
      data: {
        organizationId,
        venueId,
        title: `Journey Honesty ${Date.now()}`,
        category: 'Music',
        refundsEnabled: false,
        refundPolicy: 'All sales are final.',
      },
    })
  ).json();
  const start = Date.now() + 20 * 86_400_000;
  const session = await (
    await request.post(`${API}/events/${created.id}/sessions`, {
      headers: auth,
      data: {
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 2 * 3_600_000).toISOString(),
      },
    })
  ).json();
  const tier = (name: string, extra: Record<string, unknown>) =>
    request.post(`${API}/events/ticket-types`, {
      headers: auth,
      data: { eventSessionId: session.id, name, priceMinor: 20_000, quantityTotal: 10, ...extra },
    });
  await tier('Open tier', {});
  await tier('Closed tier', { salesEndAt: new Date(Date.now() - 3_600_000).toISOString() });
  await request.post(`${API}/events/${created.id}/submit`, { headers: auth });
  const admin = await apiLogin(request, 'admin@eticketsgo.test');
  await request.post(`${API}/admin/events/${created.id}/review`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
    data: { decision: 'APPROVE' },
  });
  return { slug: created.slug as string };
}

test('a closed ticket tier cannot be picked, and the refund terms show before paying', async ({
  page,
  request,
}) => {
  const fx = await publishedEvent(request);
  await page.goto(`${CUSTOMER}/events/${fx.slug}`);

  await expect(page.getByText('Sales closed')).toBeVisible();
  await expect(page.getByLabel(/Quantity of Closed tier/)).toBeDisabled();

  await page.getByLabel(/Quantity of Open tier/).selectOption('1');
  await page.getByLabel('Your name').fill('Journey Buyer');
  await page.getByLabel('Email', { exact: true }).fill(`journey_${Date.now()}@e2e.test`);
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await expect(page).toHaveURL(/\/booking\/.+\/payment/);

  const terms = page.getByTestId('refund-terms');
  await expect(terms).toContainText('No refunds are offered for this event.');
  await expect(terms).toContainText('All sales are final.');
});
