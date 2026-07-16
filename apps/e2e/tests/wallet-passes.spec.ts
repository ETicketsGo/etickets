import { test, expect, type APIRequestContext } from '@playwright/test';
import { CUSTOMER, API, apiLogin, seedBrowserAuth } from './helpers';

const CUSTOMER1 = 'customer1@eticketsgo.test';
const CUSTOMER2 = 'customer2@eticketsgo.test';
const authed = (t: string) => ({ authorization: `Bearer ${t}` });

async function ticketsOf(request: APIRequestContext, token: string) {
  return (await request.get(`${API}/tickets`, { headers: authed(token) })).json();
}
async function providerConfigured(request: APIRequestContext, token: string): Promise<boolean> {
  const res = await (
    await request.get(`${API}/wallet/providers`, { headers: authed(token) })
  ).json();
  return (res.providers ?? []).some((p: { status: string }) => p.status !== 'unavailable');
}

/**
 * Wallet-pass sandbox drill (ADR-035). The two tests are env-exclusive: the first runs
 * when NO provider is configured (default → fail closed, no UI), the second when a
 * sandbox provider IS configured. Both prove no secret leaks and that a pass is a
 * projection of an existing valid ticket.
 */
test('wallet passes: unavailable → fails closed, no wallet UI', async ({ page, request }) => {
  const tokens = await apiLogin(request, CUSTOMER1);
  const token = tokens.accessToken;
  test.skip(
    await providerConfigured(request, token),
    'A wallet provider is configured — see the sandbox test.',
  );

  const tickets = await ticketsOf(request, token);
  const active = tickets.find((t: { status: string }) => t.status === 'ACTIVE');
  expect(active, 'customer1 has an active ticket').toBeTruthy();

  // API fails closed: generation is unavailable, no secret in the response.
  const gen = await request.post(`${API}/wallet/passes`, {
    headers: authed(token),
    data: { ticketId: active.id, provider: 'apple' },
  });
  const body = await gen.json();
  expect(body.available).toBe(false);
  expect(body.status).toBe('unavailable');
  expect(JSON.stringify(body)).not.toContain('secret');

  // Browser: the ticket page shows NO wallet actions (existing behaviour preserved).
  await seedBrowserAuth(page.context(), tokens);
  await page.goto(`${CUSTOMER}/account/tickets/${active.id}`);
  await expect(page.getByText(/Holder:|Add to calendar/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('region', { name: 'Wallet passes' })).toHaveCount(0);
});

test('wallet passes: sandbox → projects a valid ticket, no secrets, ineligible + authz enforced', async ({
  page,
  request,
}) => {
  const tokens = await apiLogin(request, CUSTOMER1);
  const token = tokens.accessToken;
  test.skip(
    !(await providerConfigured(request, token)),
    'No wallet provider configured — sandbox test not applicable.',
  );

  const tickets = await ticketsOf(request, token);
  const active = tickets.find((t: { status: string }) => t.status === 'ACTIVE');
  const refunded = tickets.find((t: { status: string }) => t.status === 'REFUNDED');
  expect(active).toBeTruthy();

  // Sandbox generation projects the ticket — barcode is the SAME signed QR token, and
  // there is NO secret material in the response.
  const gen = await (
    await request.post(`${API}/wallet/passes`, {
      headers: authed(token),
      data: { ticketId: active.id, provider: 'apple' },
    })
  ).json();
  expect(gen).toMatchObject({
    available: true,
    eligible: true,
    provider: 'apple',
    mode: 'sandbox',
  });
  expect(gen.descriptor).toBeTruthy();
  // The barcode is a signed QR token for THIS ticket (a projection, not a new ticket).
  const barcodeMsg = gen.descriptor.barcodes?.[0]?.message as string;
  const decoded = JSON.parse(Buffer.from(barcodeMsg, 'base64url').toString('utf8'));
  expect(decoded.ticketId).toBe(active.id);
  for (const marker of ['secret', 'CERT_REF', 'SERVICE_ACCOUNT', 'privateKey', 'BEGIN ']) {
    expect(JSON.stringify(gen), `no ${marker}`).not.toContain(marker);
  }

  // Ineligible (refunded) ticket cannot generate a valid pass.
  if (refunded) {
    const bad = await (
      await request.post(`${API}/wallet/passes`, {
        headers: authed(token),
        data: { ticketId: refunded.id, provider: 'google' },
      })
    ).json();
    expect(bad).toMatchObject({ eligible: false });
  }

  // Authorization: another customer cannot generate a pass for this ticket.
  const other = (await apiLogin(request, CUSTOMER2)).accessToken;
  const forbidden = await request.post(`${API}/wallet/passes`, {
    headers: authed(other),
    data: { ticketId: active.id, provider: 'apple' },
  });
  expect(forbidden.status()).toBe(403);

  // Browser: the wallet action appears for the eligible ticket and generates a pass.
  await seedBrowserAuth(page.context(), tokens);
  await page.goto(`${CUSTOMER}/account/tickets/${active.id}`);
  await expect(page.getByRole('region', { name: 'Wallet passes' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId('wallet-btn-apple').click();
  await expect(page.getByText(/sandbox pass created/i)).toBeVisible({ timeout: 20_000 });
});
