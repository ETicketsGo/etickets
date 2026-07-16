import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { ORGANIZER, API, apiLogin, seedBrowserAuth } from './helpers';

const OWNER = 'owner@eticketsgo.test';
const ADMIN_USER = 'admin@eticketsgo.test';
const CUSTOMER = 'customer1@eticketsgo.test';

const authed = (t: string) => ({ authorization: `Bearer ${t}` });

async function confirmDialog(page: Page, reason?: string) {
  const dialog = page.getByRole('dialog');
  if (reason) await dialog.getByLabel('Reason (required)').fill(reason);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  // The dialog closes on success — more robust than a stacking toast.
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20_000 });
}

/**
 * Device lifecycle management drill (ADR-035, Sprint 12). Drives the organizer device
 * UI through the full lifecycle (register → approve → suspend → resume → revoke) and
 * report-lost, then asserts: audits exist, an unauthorized user is blocked, and a
 * lifecycle change on a device in an active activation downgrades that scope to NO_GO
 * (rules enforced, not bypassed). Skips when the flag is off.
 */
test('device lifecycle: register→approve→suspend→resume→revoke, impact, authz, audit', async ({
  page,
  request,
}) => {
  const ownerTokens = await apiLogin(request, OWNER);
  const token = ownerTokens.accessToken;
  const org = (
    await (await request.get(`${API}/organizations`, { headers: authed(token) })).json()
  )[0];
  const readiness = await (
    await request.get(`${API}/checkin/offline-readiness?organizationId=${org.id}`, {
      headers: authed(token),
    })
  ).json();
  const flagOn = readiness.checks?.find((c: { key: string }) => c.key === 'flag')?.passed === true;
  test.skip(!flagOn, 'Offline check-in feature flag is disabled — drill not applicable.');

  // An event + session (for the activation-impact leg).
  const events = await (
    await request.get(`${API}/events?organizationId=${org.id}`, { headers: authed(token) })
  ).json();
  let target: { eventId: string; sessionId: string } | null = null;
  for (const e of events.slice(0, 25)) {
    const det = await (
      await request.get(`${API}/events/${e.id}`, { headers: authed(token) })
    ).json();
    if (det.sessions?.length) {
      target = { eventId: e.id, sessionId: det.sessions[0].id };
      break;
    }
  }
  expect(target).not.toBeNull();
  const t = target!;
  const stamp = `${Date.now()}`;
  const devName = `Drill Device ${stamp}`;
  const lostName = `Lost Device ${stamp}`;

  // A second device (created via API) to exercise report-lost through the UI.
  const lost = await (
    await request.post(`${API}/checkin/devices`, {
      headers: authed(token),
      data: { organizationId: org.id, eventId: t.eventId, name: lostName },
    })
  ).json();
  await request.post(`${API}/checkin/devices/${lost.id}/approve`, { headers: authed(token) });

  // ── UI: register → approve → suspend → resume ──
  await seedBrowserAuth(page.context(), ownerTokens);
  await page.goto(`${ORGANIZER}/organizer/events/${t.eventId}/devices`);
  await expect(page.getByRole('heading', { name: 'Offline devices' })).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole('button', { name: 'Register device' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill(devName);
  await page.getByRole('dialog').getByRole('button', { name: 'Register' }).click();
  await expect(page.getByText('Device registered (pending approval).')).toBeVisible({
    timeout: 20_000,
  });

  await page.getByLabel('Search').fill(devName); // isolate this device in the paginated fleet
  const row = page.getByRole('row').filter({ hasText: devName });
  await expect(row.getByText('PENDING')).toBeVisible({ timeout: 20_000 });

  await row.getByRole('button', { name: 'Approve' }).click();
  await confirmDialog(page);
  await expect(row.getByText('ACTIVE')).toBeVisible({ timeout: 20_000 });

  await row.getByRole('button', { name: 'Suspend' }).click();
  await confirmDialog(page);
  await expect(row.getByText('SUSPENDED')).toBeVisible({ timeout: 20_000 });

  await row.getByRole('button', { name: 'Approve' }).click(); // resume
  await confirmDialog(page);
  await expect(row.getByText('ACTIVE')).toBeVisible({ timeout: 20_000 });

  // ── Activation impact: certify + activate a scope using THIS device ──
  const devices = await (
    await request.get(`${API}/checkin/devices?organizationId=${org.id}&eventId=${t.eventId}`, {
      headers: authed(token),
    })
  ).json();
  const dev = devices.find((d: { name: string }) => d.name === devName);
  expect(dev).toBeTruthy();

  for (const drillKey of ['TWO_DEVICE_CONFLICT', 'DEVICE_LOSS', 'RECONCILIATION']) {
    await request.post(`${API}/checkin/drills`, {
      headers: authed(token),
      data: {
        organizationId: org.id,
        eventId: t.eventId,
        eventSessionId: t.sessionId,
        drillKey,
        outcome: 'PASS',
        summary: 'x',
      },
    });
  }
  await request.get(`${API}/checkin/manifest?eventSessionId=${t.sessionId}`, {
    headers: authed(token),
  });
  const rec = await request.post(`${API}/checkin/activation/record`, {
    headers: authed(token),
    data: {
      organizationId: org.id,
      eventSessionId: t.sessionId,
      deviceIds: [dev.id],
      reason: 'device lifecycle drill',
    },
  });
  expect(rec.ok()).toBeTruthy();
  const activationOf = async () =>
    (
      await (
        await request.get(
          `${API}/checkin/activation?organizationId=${org.id}&eventSessionId=${t.sessionId}`,
          { headers: authed(token) },
        )
      ).json()
    ).verdict;
  expect(await activationOf()).toBe('GO');

  // ── UI: revoke the in-scope device — impact warning shown, reason required ──
  await page.reload();
  await page.getByLabel('Search').fill(devName); // isolate this device (fleet is paginated)
  const row2 = page.getByRole('row').filter({ hasText: devName });
  await expect(row2).toBeVisible({ timeout: 20_000 });
  await row2.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText(/Activation impact/)).toBeVisible();
  // Confirm is disabled until a reason is given.
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await confirmDialog(page, 'Reassigning hardware after the pilot.');
  await expect(row2.getByText('REVOKED')).toBeVisible({ timeout: 20_000 });

  // Server enforces the rule: the scope downgrades to NO_GO (mustDowngrade).
  expect(await activationOf(), 'revoking an in-scope device downgrades activation').toBe('NO_GO');

  // ── UI: report lost the second device ──
  await page.getByLabel('Search').fill(lostName); // isolate it in the paginated fleet
  const lostRow = page.getByRole('row').filter({ hasText: lostName });
  await expect(lostRow).toBeVisible({ timeout: 20_000 });
  await lostRow.getByRole('button', { name: 'Lost', exact: true }).click();
  await confirmDialog(page, 'Device reported stolen at the venue.');
  await expect(lostRow.getByText('REVOKED')).toBeVisible({ timeout: 20_000 });

  // ── Authorization: a customer cannot perform lifecycle actions ──
  const custToken = (await apiLogin(request, CUSTOMER)).accessToken;
  const custRevoke = await request.post(`${API}/checkin/devices/${dev.id}/revoke`, {
    headers: authed(custToken),
    data: { reason: 'nope' },
  });
  expect(custRevoke.status(), 'customer cannot revoke').toBe(403);
  const custSuspend = await request.post(`${API}/checkin/devices/${dev.id}/suspend`, {
    headers: authed(custToken),
    data: {},
  });
  expect(custSuspend.status(), 'customer cannot suspend').toBe(403);

  // ── Audit: each lifecycle action is recorded ──
  const adminToken = (await apiLogin(request, ADMIN_USER)).accessToken;
  for (const action of [
    'CHECKIN_DEVICE_SUSPENDED',
    'CHECKIN_DEVICE_REVOKED',
    'CHECKIN_DEVICE_REPORTED_LOST',
  ]) {
    const audit = await (
      await request.get(`${API}/admin/audit?action=${action}&pageSize=5`, {
        headers: authed(adminToken),
      })
    ).json();
    expect(audit.meta?.total, `${action} audited`).toBeGreaterThan(0);
  }
});
