import { test, expect, type APIRequestContext } from '@playwright/test';
import { ORGANIZER, API, apiLogin, seedBrowserAuth } from './helpers';

const OWNER = 'owner@eticketsgo.test';
const ADMIN_USER = 'admin@eticketsgo.test';
const CUSTOMER = 'customer1@eticketsgo.test';

const authed = (t: string) => ({ authorization: `Bearer ${t}` });

interface Entry {
  ticketId: string;
  nonce: string;
  version: number;
  status: string;
  eligible: boolean;
}
async function activeEntries(request: APIRequestContext, token: string, sessionId: string) {
  const man = await (
    await request.get(`${API}/checkin/manifest?eventSessionId=${sessionId}`, {
      headers: authed(token),
    })
  ).json();
  return (man.entries ?? []).filter((e: Entry) => e.status === 'ACTIVE' && e.eligible) as Entry[];
}
function reconcile(
  request: APIRequestContext,
  token: string,
  deviceId: string,
  item: Record<string, unknown>,
) {
  return request.post(`${API}/checkin/reconcile`, {
    headers: authed(token),
    data: { deviceId, checkIns: [item] },
  });
}

/**
 * Reconciliation Console drill (ADR-035, Sprint 12). Seeds records of every category
 * through the real reconcile engine, then drives the console UI (filter + resolve) and
 * asserts the API safeguards: unauthorized users cannot view or resolve, resolution is
 * audit-only (a non-review record cannot be resolved), and resolutions are audited.
 * Skips when the flag is off.
 */
test('reconciliation console: categories, filter, safe resolve, authz', async ({
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

  // Find an event/session with an active ticket. One ticket seeds every category: the
  // non-consuming cases run while it is ACTIVE, then it is accepted + replayed.
  const events = await (
    await request.get(`${API}/events?organizationId=${org.id}`, { headers: authed(token) })
  ).json();
  let target: { eventId: string; sessionId: string; a: Entry } | null = null;
  for (const e of events.slice(0, 25)) {
    const det = await (
      await request.get(`${API}/events/${e.id}`, { headers: authed(token) })
    ).json();
    for (const s of det.sessions ?? []) {
      const active = await activeEntries(request, token, s.id);
      if (active.length >= 1) {
        target = { eventId: e.id, sessionId: s.id, a: active[0] };
        break;
      }
    }
    if (target) break;
  }
  expect(target, 'a session with an active ticket').not.toBeNull();
  const t = target!;

  const device = await (
    await request.post(`${API}/checkin/devices`, {
      headers: authed(token),
      data: { organizationId: org.id, eventId: t.eventId, name: 'Console gate' },
    })
  ).json();
  await request.post(`${API}/checkin/devices/${device.id}/approve`, { headers: authed(token) });
  const dev = device.id;
  const base = (ticketId: string, over: Record<string, unknown> = {}) => ({
    deviceId: dev,
    ticketId,
    nonce: 'x',
    version: 1,
    eventSessionId: t.sessionId,
    checkedInAt: Date.now(),
    wasOverride: false,
    ...over,
  });

  // Seed one record of each category through the real reconcile engine, using ONE
  // ticket: the non-consuming cases first (while ACTIVE), then accept + duplicate.
  await reconcile(
    request,
    token,
    dev,
    base(t.a.ticketId, { nonce: t.a.nonce, version: t.a.version, eventSessionId: 'other-session' }),
  ); // WRONG_SESSION
  await reconcile(
    request,
    token,
    dev,
    base(t.a.ticketId, { nonce: `rot-${t.a.nonce}`, version: t.a.version }),
  ); // TRANSFERRED_AFTER_DOWNLOAD
  await reconcile(request, token, dev, base('ckvanished0000000000000000')); // SUPERVISOR_REVIEW_REQUIRED
  await reconcile(
    request,
    token,
    dev,
    base(t.a.ticketId, { nonce: t.a.nonce, version: t.a.version }),
  ); // ACCEPTED
  await reconcile(
    request,
    token,
    dev,
    base(t.a.ticketId, { nonce: t.a.nonce, version: t.a.version }),
  ); // DUPLICATE_SAME_DEVICE

  // ── API safeguards ──
  // Unauthorized: a customer can neither view nor resolve.
  const custToken = (await apiLogin(request, CUSTOMER)).accessToken;
  const custView = await request.get(`${API}/checkin/reconciliation?organizationId=${org.id}`, {
    headers: authed(custToken),
  });
  expect(custView.status(), 'customer cannot view').toBe(403);

  // Pagination caps + filtering.
  const review = await (
    await request.get(
      `${API}/checkin/reconciliation?organizationId=${org.id}&outcome=SUPERVISOR_REVIEW_REQUIRED&pageSize=1`,
      { headers: authed(token) },
    )
  ).json();
  expect(review.meta.pageSize).toBe(1);
  expect(review.data[0].reviewState).toBe('PENDING');
  const reviewId = review.data[0].id as string;

  const wrong = await (
    await request.get(
      `${API}/checkin/reconciliation?organizationId=${org.id}&outcome=WRONG_SESSION`,
      { headers: authed(token) },
    )
  ).json();
  const wrongId = wrong.data[0].id as string;

  // Invalid transition: a non-review record cannot be resolved (never admits).
  const badResolve = await request.post(`${API}/checkin/reconciliation/${wrongId}/resolve`, {
    headers: authed(token),
    data: { action: 'ACKNOWLEDGED', reason: 'should fail' },
  });
  expect(badResolve.status(), 'non-review record not resolvable').toBe(409);

  // Customer cannot resolve even a pending case.
  const custResolve = await request.post(`${API}/checkin/reconciliation/${reviewId}/resolve`, {
    headers: authed(custToken),
    data: { action: 'ACKNOWLEDGED', reason: 'nope' },
  });
  expect(custResolve.status(), 'customer cannot resolve').toBe(403);

  // ── Browser: drive the console UI ──
  await seedBrowserAuth(page.context(), ownerTokens);
  await page.goto(`${ORGANIZER}/organizer/events/${t.eventId}/reconciliation`);
  await expect(page.getByRole('heading', { name: 'Reconciliation console' })).toBeVisible({
    timeout: 20_000,
  });

  const table = page.locator('table');

  // Accepted category is visible in the ledger.
  await page.getByLabel('Outcome').selectOption('ACCEPTED');
  await expect(table.getByText('Accepted', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });

  // Filter to the supervisor-review case and resolve it (audit-only).
  await page.getByLabel('Outcome').selectOption('SUPERVISOR_REVIEW_REQUIRED');
  await expect(table.getByText('Supervisor review required').first()).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Resolve' }).first().click();
  await expect(page.getByRole('heading', { name: 'Resolve reconciliation case' })).toBeVisible();
  await page.getByLabel('Reason (required)').fill('Verified attendee at the gate in person.');
  await page.getByRole('button', { name: 'Record resolution' }).click();
  await expect(page.getByText('Case resolved.')).toBeVisible({ timeout: 20_000 });

  // Server truth: the case is RESOLVED and the resolution is audited.
  const afterResolve = await (
    await request.get(
      `${API}/checkin/reconciliation?organizationId=${org.id}&reviewState=RESOLVED`,
      { headers: authed(token) },
    )
  ).json();
  expect(afterResolve.data.some((r: { id: string }) => r.id === reviewId)).toBe(true);

  const adminToken = (await apiLogin(request, ADMIN_USER)).accessToken;
  const audit = await (
    await request.get(`${API}/admin/audit?action=OFFLINE_RECONCILIATION_RESOLVED&pageSize=5`, {
      headers: authed(adminToken),
    })
  ).json();
  expect(audit.meta?.total, 'resolution is audited').toBeGreaterThan(0);
});
