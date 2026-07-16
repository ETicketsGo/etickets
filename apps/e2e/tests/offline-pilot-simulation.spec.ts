import { test, expect, type APIRequestContext } from '@playwright/test';
import { ORGANIZER, API, apiLogin, seedBrowserAuth } from './helpers';

const OWNER = 'owner@eticketsgo.test';
const CUSTOMER1 = 'customer1@eticketsgo.test';
const PILOT_SLUG = 'offline-pilot';
const authed = (t: string) => ({ authorization: `Bearer ${t}` });

interface Entry {
  ticketId: string;
  nonce: string;
  version: number;
  status: string;
  eligible: boolean;
}
const reconcile = (
  request: APIRequestContext,
  token: string,
  deviceId: string,
  item: Record<string, unknown>,
) =>
  request.post(`${API}/checkin/reconcile`, {
    headers: authed(token),
    data: { deviceId, checkIns: [item] },
  });
const outcomeOf = async (res: Awaited<ReturnType<typeof reconcile>>) =>
  (await res.json())[0]?.outcome as string;

/**
 * Controlled offline check-in pilot simulation (Sprint 13). Follows the full pilot
 * workflow end to end against an ISOLATED pilot fixture (its own event + ticket pool),
 * so it never competes with the shared seed tickets. It exercises — without weakening
 * any auth/readiness/activation/reconciliation control — device approval, manifest,
 * preflight, scoped activation → GO, online + offline scans, cross-device duplicate,
 * device revocation (fail-closed), reconnect reconciliation, command-center metrics +
 * a critical alert, supervisor-review resolution, activation revoke → NO_GO. Skips when
 * the flag is off. Requires the pilot fixture (`npm run db:pilot`).
 */
test('controlled offline check-in pilot: full workflow READY → GO → operate → NO_GO', async ({
  page,
  request,
}) => {
  const owner = await apiLogin(request, OWNER);
  const token = owner.accessToken;
  const org = (
    await (await request.get(`${API}/organizations`, { headers: authed(token) })).json()
  )[0];
  const readiness = await (
    await request.get(`${API}/checkin/offline-readiness?organizationId=${org.id}`, {
      headers: authed(token),
    })
  ).json();
  const flagOn = readiness.checks?.find((c: { key: string }) => c.key === 'flag')?.passed === true;
  test.skip(
    !flagOn,
    'Offline check-in feature flag is disabled — pilot simulation not applicable.',
  );

  // ── Locate the isolated pilot event + session (dedicated fixture) ──
  const events = await (
    await request.get(`${API}/events?organizationId=${org.id}`, { headers: authed(token) })
  ).json();
  let pilot: { eventId: string; sessionId: string } | null = null;
  for (const e of events) {
    const det = await (
      await request.get(`${API}/events/${e.id}`, { headers: authed(token) })
    ).json();
    if (det.slug === PILOT_SLUG && det.sessions?.length) {
      pilot = { eventId: e.id, sessionId: det.sessions[0].id };
      break;
    }
  }
  expect(pilot, 'pilot fixture present (run: npm run db:pilot)').not.toBeNull();
  const p = pilot!;

  const manifestEntries = async () =>
    (
      (
        await (
          await request.get(`${API}/checkin/manifest?eventSessionId=${p.sessionId}`, {
            headers: authed(token),
          })
        ).json()
      ).entries ?? []
    ).filter((x: Entry) => x.status === 'ACTIVE' && x.eligible) as Entry[];
  const active = await manifestEntries();
  expect(active.length, 'pilot has enough active tickets').toBeGreaterThanOrEqual(6);
  const [t0, t1, t2, t3, t4] = active;
  const payload = (dev: string, e: Entry, over: Record<string, unknown> = {}) => ({
    deviceId: dev,
    ticketId: e.ticketId,
    nonce: e.nonce,
    version: e.version,
    eventSessionId: p.sessionId,
    checkedInAt: Date.now(),
    wasOverride: false,
    ...over,
  });

  // ── Devices: approve device A via the real panel, device B via the API ──
  await seedBrowserAuth(page.context(), owner);
  await page.goto(`${ORGANIZER}/organizer/events/${p.eventId}/checkin`);
  await expect(page.getByRole('heading', { name: 'Offline mode' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByLabel('Session', { exact: true }).selectOption(p.sessionId);
  const [approveResp] = await Promise.all([
    page.waitForResponse(
      (r) => /\/checkin\/devices\/[^/]+\/approve$/.test(r.url()) && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: /Register \+ approve device/ }).click(),
  ]);
  const devA = ((await approveResp.json()) as { id: string }).id;
  await expect(page.getByRole('button', { name: /Device approved/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Download manifest' }).click();
  await expect(page.getByTestId('manifest-status')).toBeVisible({ timeout: 20_000 });

  const devB = (
    await (
      await request.post(`${API}/checkin/devices`, {
        headers: authed(token),
        data: { organizationId: org.id, eventId: p.eventId, name: 'Pilot device B' },
      })
    ).json()
  ).id;
  await request.post(`${API}/checkin/devices/${devB}/approve`, { headers: authed(token) });

  // Record the three certification drills.
  for (const drillKey of ['TWO_DEVICE_CONFLICT', 'DEVICE_LOSS', 'RECONCILIATION']) {
    await request.post(`${API}/checkin/drills`, {
      headers: authed(token),
      data: {
        organizationId: org.id,
        eventId: p.eventId,
        eventSessionId: p.sessionId,
        drillKey,
        outcome: 'PASS',
        summary: 'pilot',
      },
    });
  }
  // Current signed-manifest version, re-read immediately before each preflight so the
  // reported version always matches the server's latest (the counter is monotonic).
  const currentVersion = async () =>
    (
      await (
        await request.get(`${API}/checkin/manifest?eventSessionId=${p.sessionId}`, {
          headers: authed(token),
        })
      ).json()
    ).meta.version as number;
  const preflight = async (clientManifestVersion: number) =>
    await (
      await request.post(`${API}/checkin/preflight`, {
        headers: authed(token),
        data: {
          organizationId: org.id,
          eventSessionId: p.sessionId,
          deviceId: devA,
          clientManifestVersion,
          clientTimeMs: Date.now(),
          queueDepth: 0,
        },
      })
    ).json();

  // ── Preflight BEFORE activation → NOT_READY (activation not yet recorded) ──
  const pre1 = await preflight(await currentVersion());
  expect(pre1.verdict).toBe('NOT_READY');
  expect(pre1.checks.find((c: { key: string }) => c.key === 'activation_go').status).toBe('fail');

  // ── Scoped activation → GO ──
  const rec = await request.post(`${API}/checkin/activation/record`, {
    headers: authed(token),
    data: {
      organizationId: org.id,
      eventSessionId: p.sessionId,
      deviceIds: [devA, devB],
      reason: 'Controlled pilot activation',
    },
  });
  expect(rec.ok(), 'activation recorded').toBeTruthy();
  const activationId = (await rec.json()).id as string;
  const verdict = async () =>
    (
      await (
        await request.get(
          `${API}/checkin/activation?organizationId=${org.id}&eventSessionId=${p.sessionId}`,
          { headers: authed(token) },
        )
      ).json()
    ).verdict;
  expect(await verdict(), 'GO for the approved scope').toBe('GO');

  // A valid scan on device A (recent lastSeenAt) so preflight can be READY.
  expect(await outcomeOf(await reconcile(request, token, devA, payload(devA, t0)))).toBe(
    'ACCEPTED',
  );

  // ── Preflight AFTER activation → no longer blocked; activation_go now passes ──
  const pre2 = await preflight(await currentVersion());
  expect(pre2.verdict, 'device no longer blocked for offline operation').not.toBe('NOT_READY');
  expect(pre2.checks.find((c: { key: string }) => c.key === 'activation_go').status).toBe('pass');

  // ── Online scan then an offline replay → server wins (ALREADY_CHECKED_IN_ONLINE) ──
  const cust = (await apiLogin(request, CUSTOMER1)).accessToken;
  const custTickets = await (await request.get(`${API}/tickets`, { headers: authed(cust) })).json();
  const onlineTicket = custTickets.find(
    (x: { id: string; qrToken: string }) => x.id === t1.ticketId,
  );
  expect(onlineTicket?.qrToken, 'signed QR for the online-scan ticket').toBeTruthy();
  const onlineScan = await request.post(`${API}/checkins`, {
    headers: authed(token),
    data: { token: onlineTicket.qrToken, expectedSessionId: p.sessionId },
  });
  expect((await onlineScan.json()).result).toBe('SUCCESS');
  expect(await outcomeOf(await reconcile(request, token, devA, payload(devA, t1)))).toBe(
    'ALREADY_CHECKED_IN_ONLINE',
  );

  // ── Cross-device duplicate: two devices, one ticket → exactly one ACCEPTED ──
  const cdOutcomes = [
    await outcomeOf(await reconcile(request, token, devA, payload(devA, t2))),
    await outcomeOf(await reconcile(request, token, devB, payload(devB, t2))),
  ].sort();
  expect(cdOutcomes).toEqual(['ACCEPTED', 'DUPLICATE_OTHER_DEVICE']);

  // ── Offline scan through the REAL panel (device A) → queued → reconnect sync ──
  const qr = Buffer.from(
    JSON.stringify({
      ticketId: t3.ticketId,
      eventSessionId: p.sessionId,
      nonce: t3.nonce,
      version: t3.version,
    }),
  ).toString('base64url');
  await page.getByLabel('Ticket QR token').fill(qr);
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByTestId('queue-count')).toContainText('1 queued');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('queue-count')).toContainText('0 queued', { timeout: 20_000 });

  // ── Supervisor review: a vanished ticket → PENDING → resolved (audit-only) ──
  expect(
    await outcomeOf(
      await reconcile(
        request,
        token,
        devA,
        payload(devA, { ticketId: 'ckpilotvanished0000000000', nonce: 'x', version: 1 } as Entry),
      ),
    ),
  ).toBe('SUPERVISOR_REVIEW_REQUIRED');
  const review = await (
    await request.get(
      `${API}/checkin/reconciliation?organizationId=${org.id}&eventSessionId=${p.sessionId}&outcome=SUPERVISOR_REVIEW_REQUIRED`,
      { headers: authed(token) },
    )
  ).json();
  const reviewId = review.data[0].id as string;
  const resolved = await request.post(`${API}/checkin/reconciliation/${reviewId}/resolve`, {
    headers: authed(token),
    data: { action: 'ACKNOWLEDGED', reason: 'Pilot: verified attendee at the gate.' },
  });
  expect(resolved.ok()).toBeTruthy();

  // ── Device loss: revoke device B → its queued scan is rejected (fail-closed) ──
  await request.post(`${API}/checkin/devices/${devB}/revoke`, {
    headers: authed(token),
    data: { reason: 'Pilot: device reported lost' },
  });
  expect((await reconcile(request, token, devB, payload(devB, t4))).status()).toBe(403);

  // ── Command Center: metrics reflect the pilot + a critical alert exists ──
  const snap = await (
    await request.get(
      `${API}/checkin/command-center?organizationId=${org.id}&eventSessionId=${p.sessionId}`,
      { headers: authed(token) },
    )
  ).json();
  expect(snap.reconciliation.totalScans).toBeGreaterThanOrEqual(4);
  expect(snap.reconciliation.accepted).toBeGreaterThanOrEqual(2);
  expect(snap.reconciliation.pendingReviews, 'the review was resolved').toBe(0);
  const critical = snap.alerts.filter((a: { severity: string }) => a.severity === 'critical');
  expect(critical.length, 'revoked-device activity raises a critical alert').toBeGreaterThanOrEqual(
    1,
  );

  // Command Center UI renders the alert.
  await page.goto(`${ORGANIZER}/organizer/events/${p.eventId}/command-center`);
  await expect(page.getByRole('heading', { name: 'Live Event Command Center' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByLabel('Session').selectOption(p.sessionId);
  await expect(page.getByText('Revoked/expired device activity')).toBeVisible({ timeout: 20_000 });

  // ── Revoke activation → NO_GO (end-of-pilot rollback of the scope) ──
  await request.post(`${API}/checkin/activation/${activationId}/revoke`, {
    headers: authed(token),
    data: { reason: 'Pilot complete' },
  });
  expect(await verdict(), 'scope returns to NO_GO after revocation').toBe('NO_GO');
});
