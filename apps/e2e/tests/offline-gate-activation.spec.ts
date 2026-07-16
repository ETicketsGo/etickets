import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, apiLogin } from './helpers';

const OWNER = 'owner@eticketsgo.test';
const ADMIN_USER = 'admin@eticketsgo.test';
const CUSTOMER = 'customer1@eticketsgo.test';

const authed = (t: string) => ({ authorization: `Bearer ${t}` });

async function verdict(request: APIRequestContext, token: string, org: string, session?: string) {
  const q = session ? `organizationId=${org}&eventSessionId=${session}` : `organizationId=${org}`;
  return (await request.get(`${API}/checkin/activation?${q}`, { headers: authed(token) })).json();
}

/**
 * Controlled activation workflow drill (ADR-035, Sprint 11). Proves the final launch
 * gate end-to-end against the real endpoints: with all readiness/drill evidence green
 * the gate is still NO_GO until a scoped admin decision is recorded; a valid decision
 * flips ONLY the approved scope to GO; unapproved scopes stay NO_GO; and revocation
 * returns the scope to NO_GO. Also asserts authorization, missing-evidence rejection,
 * and the audit trail. Skips when the flag is off.
 */
test('offline gate: controlled activation — NO_GO → scoped GO → revoke → NO_GO', async ({
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

  // Discover an event with a session.
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
  expect(target, 'an event with a session').not.toBeNull();
  const t = target!;

  // Certify: record the three activation-gate drills (green + current evidence).
  for (const drillKey of ['TWO_DEVICE_CONFLICT', 'DEVICE_LOSS', 'RECONCILIATION']) {
    const r = await request.post(`${API}/checkin/drills`, {
      headers: authed(token),
      data: {
        organizationId: org.id,
        eventId: t.eventId,
        eventSessionId: t.sessionId,
        drillKey,
        outcome: 'PASS',
        summary: `${drillKey} certified by the activation drill.`,
      },
    });
    expect(r.ok()).toBeTruthy();
  }

  // Approve a device scoped to the event; register a second, LEFT UNAPPROVED.
  const device = await (
    await request.post(`${API}/checkin/devices`, {
      headers: authed(token),
      data: { organizationId: org.id, eventId: t.eventId, name: 'Activation gate' },
    })
  ).json();
  await request.post(`${API}/checkin/devices/${device.id}/approve`, { headers: authed(token) });
  const pendingDevice = await (
    await request.post(`${API}/checkin/devices`, {
      headers: authed(token),
      data: { organizationId: org.id, eventId: t.eventId, name: 'Unapproved gate' },
    })
  ).json();

  // Build a fresh manifest for the session.
  await request.get(`${API}/checkin/manifest?eventSessionId=${t.sessionId}`, {
    headers: authed(token),
  });

  // Idempotent reset: revoke any ACTIVE decision a prior interrupted run may have left.
  const existing = await (
    await request.get(`${API}/checkin/activation/decisions?organizationId=${org.id}`, {
      headers: authed(token),
    })
  ).json();
  for (const d of existing) {
    if (d.state === 'ACTIVE' && d.eventSessionId === t.sessionId) {
      await request.post(`${API}/checkin/activation/${d.id}/revoke`, {
        headers: authed(token),
        data: { reason: 'drill reset' },
      });
    }
  }

  // (1) Gate is NO_GO before approval — every other check green, only admin missing.
  const before = await verdict(request, token, org.id, t.sessionId);
  expect(before.verdict).toBe('NO_GO');
  expect(before.checks.find((c: { key: string }) => c.key === 'activation')?.passed).toBe(false);
  for (const key of [
    'drill_two_device',
    'drill_device_loss',
    'drill_reconcile',
    'manifest',
    'device',
  ]) {
    expect(before.checks.find((c: { key: string }) => c.key === key)?.passed, key).toBe(true);
  }

  // Authorization: a customer (non-manager) cannot record an activation.
  const custToken = (await apiLogin(request, CUSTOMER)).accessToken;
  const forbidden = await request.post(`${API}/checkin/activation/record`, {
    headers: authed(custToken),
    data: {
      organizationId: org.id,
      eventSessionId: t.sessionId,
      deviceIds: [device.id],
      reason: 'nope',
    },
  });
  expect(forbidden.status(), 'non-manager forbidden').toBe(403);

  // Scope validation: an unknown device is rejected.
  const badScope = await request.post(`${API}/checkin/activation/record`, {
    headers: authed(token),
    data: {
      organizationId: org.id,
      eventSessionId: t.sessionId,
      deviceIds: ['ckbogus00000000000000000'],
      reason: 'bad',
    },
  });
  expect(badScope.status(), 'unknown device rejected').toBe(400);

  // Missing evidence: a device that is not approved (still PENDING) is rejected.
  const notApproved = await request.post(`${API}/checkin/activation/record`, {
    headers: authed(token),
    data: {
      organizationId: org.id,
      eventSessionId: t.sessionId,
      deviceIds: [pendingDevice.id],
      reason: 'unapproved device',
    },
  });
  expect(notApproved.status(), 'unapproved device rejected').toBe(400);

  // (2) Valid scoped admin approval is recorded.
  const recorded = await request.post(`${API}/checkin/activation/record`, {
    headers: authed(token),
    data: {
      organizationId: org.id,
      eventSessionId: t.sessionId,
      deviceIds: [device.id],
      reason: 'Scoped pilot approved.',
    },
  });
  expect(recorded.ok(), 'activation recorded').toBeTruthy();
  const decision = await recorded.json();
  expect(decision.state).toBe('ACTIVE');
  expect(decision.evidenceSnapshot).toBeTruthy(); // immutable snapshot stored

  // (3) Activation is GO for the approved scope.
  const after = await verdict(request, token, org.id, t.sessionId);
  expect(after.verdict).toBe('GO');
  expect(after.checks.find((c: { key: string }) => c.key === 'activation')?.passed).toBe(true);

  // (4) Unapproved scope (org-wide / no session) stays NO_GO — never global.
  const global = await verdict(request, token, org.id);
  expect(global.verdict).toBe('NO_GO');

  // (5) Revocation returns the scope to NO_GO.
  const revoked = await request.post(`${API}/checkin/activation/${decision.id}/revoke`, {
    headers: authed(token),
    data: { reason: 'Pilot complete.' },
  });
  expect(revoked.ok()).toBeTruthy();
  const afterRevoke = await verdict(request, token, org.id, t.sessionId);
  expect(afterRevoke.verdict).toBe('NO_GO');

  // Audit: the decision + revocation are recorded.
  const adminToken = (await apiLogin(request, ADMIN_USER)).accessToken;
  const audit = await (
    await request.get(`${API}/admin/audit?action=OFFLINE_ACTIVATION_RECORDED&pageSize=5`, {
      headers: authed(adminToken),
    })
  ).json();
  expect(audit.meta?.total, 'activation recorded in audit log').toBeGreaterThan(0);
});
