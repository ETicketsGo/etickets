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
function snapshot(request: APIRequestContext, token: string, org: string, session: string) {
  return request
    .get(`${API}/checkin/command-center?organizationId=${org}&eventSessionId=${session}`, {
      headers: authed(token),
    })
    .then((r) => r.json());
}

/**
 * Live Event Command Center drill (ADR-035, Sprint 12). Seeds real reconciliation +
 * device data, produces one critical condition (a revoked device that has activity),
 * then: loads the console UI, verifies metrics + the single alert, proves polling does
 * not duplicate it, acknowledges it (audited), and confirms the underlying condition
 * stays visible. Also asserts authorization + scope isolation via the API. Skips when
 * the flag is off.
 */
test('command center: metrics, one alert, no dup on poll, audited ack, condition persists', async ({
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

  // Find an event/session with an active ticket; note a second session for scope isolation.
  const events = await (
    await request.get(`${API}/events?organizationId=${org.id}`, { headers: authed(token) })
  ).json();
  let target: { eventId: string; sessionId: string; other: string | null; a: Entry } | null = null;
  for (const e of events.slice(0, 25)) {
    const det = await (
      await request.get(`${API}/events/${e.id}`, { headers: authed(token) })
    ).json();
    for (const s of det.sessions ?? []) {
      const man = await (
        await request.get(`${API}/checkin/manifest?eventSessionId=${s.id}`, {
          headers: authed(token),
        })
      ).json();
      const active = (man.entries ?? []).find((x: Entry) => x.status === 'ACTIVE' && x.eligible);
      if (active) {
        const other =
          (det.sessions ?? []).map((x: { id: string }) => x.id).find((x: string) => x !== s.id) ??
          null;
        target = { eventId: e.id, sessionId: s.id, other, a: active };
        break;
      }
    }
    if (target) break;
  }
  expect(target, 'a session with an active ticket').not.toBeNull();
  const t = target!;

  // Approve a device, seed real reconciliation activity, then REVOKE it → the records
  // are now from an inactive device: a critical REVOKED_DEVICE_ACTIVITY condition.
  const device = await (
    await request.post(`${API}/checkin/devices`, {
      headers: authed(token),
      data: { organizationId: org.id, eventId: t.eventId, name: 'CC gate' },
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
  await reconcile(
    request,
    token,
    dev,
    base(t.a.ticketId, { nonce: t.a.nonce, version: t.a.version }),
  ); // ACCEPTED
  await reconcile(request, token, dev, base('ckvanished0000000000000000')); // SUPERVISOR_REVIEW_REQUIRED
  await request.post(`${API}/checkin/devices/${dev}/revoke`, { headers: authed(token) });

  // ── API: authorization + scope isolation + no-dup on repeated evaluation ──
  const custToken = (await apiLogin(request, CUSTOMER)).accessToken;
  const custView = await request.get(
    `${API}/checkin/command-center?organizationId=${org.id}&eventSessionId=${t.sessionId}`,
    { headers: authed(custToken) },
  );
  expect(custView.status(), 'customer cannot view').toBe(403);

  const s1 = await snapshot(request, token, org.id, t.sessionId);
  const s2 = await snapshot(request, token, org.id, t.sessionId); // repeated poll
  const revoked1 = s1.alerts.filter((a: { type: string }) => a.type === 'REVOKED_DEVICE_ACTIVITY');
  const revoked2 = s2.alerts.filter((a: { type: string }) => a.type === 'REVOKED_DEVICE_ACTIVITY');
  expect(revoked1.length, 'exactly one critical alert').toBe(1);
  expect(revoked2.length, 'polling does not duplicate it').toBe(1);
  expect(revoked1[0].severity).toBe('critical');
  expect(
    s1.reconciliation.totalScans,
    'metrics reflect real reconciliation data',
  ).toBeGreaterThanOrEqual(2);

  // Scope isolation: a different session does not surface this session's alert.
  if (t.other) {
    const otherSnap = await snapshot(request, token, org.id, t.other);
    expect(
      otherSnap.alerts.some((a: { key: string }) => a.key === revoked1[0].key),
      'alert is scoped to its session',
    ).toBe(false);
  }

  // Acknowledgement requires a reason; a customer cannot acknowledge.
  const noReason = await request.post(`${API}/checkin/command-center/alerts/ack`, {
    headers: authed(token),
    data: {
      organizationId: org.id,
      eventSessionId: t.sessionId,
      alertKey: revoked1[0].key,
      severity: 'critical',
      reason: '',
    },
  });
  expect(noReason.status(), 'reason required').toBe(400);
  const custAck = await request.post(`${API}/checkin/command-center/alerts/ack`, {
    headers: authed(custToken),
    data: {
      organizationId: org.id,
      eventSessionId: t.sessionId,
      alertKey: revoked1[0].key,
      severity: 'critical',
      reason: 'x',
    },
  });
  expect(custAck.status(), 'customer cannot acknowledge').toBe(403);

  // ── Browser: load the console, verify metric + alert, acknowledge, condition persists ──
  await seedBrowserAuth(page.context(), ownerTokens);
  await page.goto(`${ORGANIZER}/organizer/events/${t.eventId}/command-center`);
  await expect(page.getByRole('heading', { name: 'Live Event Command Center' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByLabel('Session').selectOption(t.sessionId);

  const alerts = page.getByRole('list', { name: 'Operational alerts' });
  await expect(alerts.getByText('Revoked/expired device activity')).toBeVisible({
    timeout: 20_000,
  });
  await expect(alerts.getByText('CRITICAL').first()).toBeVisible();

  await page.getByRole('button', { name: 'Acknowledge' }).first().click();
  await expect(page.getByRole('heading', { name: 'Acknowledge alert' })).toBeVisible();
  await page.getByLabel('Reason (required)').fill('Investigating the lost device now.');
  await page.getByRole('dialog').getByRole('button', { name: 'Acknowledge' }).click();
  await expect(page.getByText('Alert acknowledged.')).toBeVisible({ timeout: 20_000 });

  // The underlying condition remains visible (acknowledgement does not suppress it).
  await expect(alerts.getByText('Revoked/expired device activity')).toBeVisible();

  // Server truth: the ack is audited and the alert is still derived (acknowledged=true).
  const afterAck = await snapshot(request, token, org.id, t.sessionId);
  const stillThere = afterAck.alerts.find((a: { key: string }) => a.key === revoked1[0].key);
  expect(stillThere, 'condition still derived after ack').toBeTruthy();
  expect(stillThere.acknowledged).toBe(true);

  const adminToken = (await apiLogin(request, ADMIN_USER)).accessToken;
  const audit = await (
    await request.get(`${API}/admin/audit?action=OFFLINE_ALERT_ACKNOWLEDGED&pageSize=5`, {
      headers: authed(adminToken),
    })
  ).json();
  expect(audit.meta?.total, 'acknowledgement is audited').toBeGreaterThan(0);
});
