import { test, expect, type APIRequestContext } from '@playwright/test';
import { ORGANIZER, API, apiLogin, seedBrowserAuth } from './helpers';

const OWNER = 'owner@eticketsgo.test';

const authed = (t: string) => ({ authorization: `Bearer ${t}` });

/** The manifest entry for a ticket, or undefined — used to assert server truth. */
async function manifestEntry(
  request: APIRequestContext,
  token: string,
  sessionId: string,
  ticketId: string,
) {
  const man = await (
    await request.get(`${API}/checkin/manifest?eventSessionId=${sessionId}`, {
      headers: authed(token),
    })
  ).json();
  return (man.entries ?? []).find((x: { ticketId: string }) => x.ticketId === ticketId) as
    { status: string; eligible: boolean } | undefined;
}

/**
 * Device-loss browser drill (ADR-035, Sprint 11). A device queues an offline scan,
 * then is REVOKED (lost / reported stolen) before it reconnects. On sync the server
 * rejects the whole queue (403) — fail-closed: nothing is accepted and the ticket
 * stays ACTIVE, so a lost device can never admit anyone. The queued scan is NOT
 * silently dropped either (it stays for a legitimate device to reconcile). On PASS
 * the drill records DEVICE_LOSS evidence, flipping the activation gate's
 * `drill_device_loss` check green. Skipped when the flag is off.
 */
test('offline gate: a revoked device cannot check anyone in (fail-closed)', async ({
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

  // Discover an event/session with an ACTIVE, eligible ticket.
  const events = await (
    await request.get(`${API}/events?organizationId=${org.id}`, { headers: authed(token) })
  ).json();
  let target: { eventId: string; sessionId: string; ticketId: string; qr: string } | null = null;
  for (const e of events.slice(0, 25)) {
    const det = await (
      await request.get(`${API}/events/${e.id}`, { headers: authed(token) })
    ).json();
    for (const s of det.sessions ?? []) {
      const entry = await (
        await request.get(`${API}/checkin/manifest?eventSessionId=${s.id}`, {
          headers: authed(token),
        })
      ).json();
      const active = (entry.entries ?? []).find(
        (x: { status: string; eligible: boolean }) => x.status === 'ACTIVE' && x.eligible,
      );
      if (active) {
        const qr = Buffer.from(
          JSON.stringify({
            ticketId: active.ticketId,
            eventSessionId: s.id,
            nonce: active.nonce,
            version: active.version,
          }),
        ).toString('base64url');
        target = { eventId: e.id, sessionId: s.id, ticketId: active.ticketId, qr };
        break;
      }
    }
    if (target) break;
  }
  expect(target, 'a session with an active ticket').not.toBeNull();
  const t = target!;

  // Drive the offline panel: approve device, capture its id, queue a scan.
  await seedBrowserAuth(page.context(), ownerTokens);
  await page.goto(`${ORGANIZER}/organizer/events/${t.eventId}/checkin`);
  await expect(page.getByRole('heading', { name: 'Offline mode' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByLabel('Session', { exact: true }).selectOption(t.sessionId);

  const [approveResp] = await Promise.all([
    page.waitForResponse(
      (r) => /\/checkin\/devices\/[^/]+\/approve$/.test(r.url()) && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: /Register \+ approve device/ }).click(),
  ]);
  const deviceId = ((await approveResp.json()) as { id: string }).id;
  await expect(page.getByRole('button', { name: /Device approved/ })).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole('button', { name: 'Download manifest' }).click();
  await expect(page.getByTestId('manifest-status')).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Ticket QR token').fill(t.qr);
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByTestId('queue-count')).toContainText('1 queued');

  // The device is lost → a manager revokes it while a scan is still queued.
  const revoked = await request.post(`${API}/checkin/devices/${deviceId}/revoke`, {
    headers: authed(token),
  });
  expect(revoked.ok(), 'device revoked').toBeTruthy();

  // Reconnect sync → the server rejects the whole queue (403). Fail-closed.
  const [reconcileResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/checkin/reconcile') && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Sync now' }).click(),
  ]);
  expect(reconcileResp.status(), 'revoked device reconcile is forbidden').toBe(403);

  // The scan was neither accepted nor silently dropped — a 403 is a non-retryable
  // failure so it is held as a dead-letter (BLOCKED), not lost, not admitted.
  await expect(page.getByTestId('queue-count')).toContainText('1 blocked');

  // Server truth: the ticket was never admitted — still ACTIVE + eligible.
  const entry = await manifestEntry(request, token, t.sessionId, t.ticketId);
  expect(entry?.status, 'ticket never checked in by the lost device').toBe('ACTIVE');
  expect(entry?.eligible).toBe(true);

  // Record certification evidence → flips the activation gate's device-loss check.
  const rec = await request.post(`${API}/checkin/drills`, {
    headers: authed(token),
    data: {
      organizationId: org.id,
      eventId: t.eventId,
      eventSessionId: t.sessionId,
      drillKey: 'DEVICE_LOSS',
      outcome: 'PASS',
      summary: 'Revoked device reconcile rejected (403); ticket stayed ACTIVE; queue not dropped.',
      evidence: { deviceId, reconcileStatus: 403 },
    },
  });
  expect(rec.ok(), 'drill result recorded').toBeTruthy();

  const activation = await (
    await request.get(`${API}/checkin/activation?organizationId=${org.id}`, {
      headers: authed(token),
    })
  ).json();
  const deviceLoss = activation.checks?.find((c: { key: string }) => c.key === 'drill_device_loss');
  expect(deviceLoss?.passed, 'activation gate device-loss check is now green').toBe(true);
});
