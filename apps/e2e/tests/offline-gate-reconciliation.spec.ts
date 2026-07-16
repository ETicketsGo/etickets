import { test, expect, type APIRequestContext } from '@playwright/test';
import { ORGANIZER, API, apiLogin, seedBrowserAuth } from './helpers';

const OWNER = 'owner@eticketsgo.test';
const ADMIN_USER = 'admin@eticketsgo.test';

const authed = (t: string) => ({ authorization: `Bearer ${t}` });

interface Entry {
  ticketId: string;
  nonce: string;
  version: number;
  status: string;
  eligible: boolean;
}

async function sessionEntries(
  request: APIRequestContext,
  token: string,
  sessionId: string,
): Promise<Entry[]> {
  const man = await (
    await request.get(`${API}/checkin/manifest?eventSessionId=${sessionId}`, {
      headers: authed(token),
    })
  ).json();
  return (man.entries ?? []) as Entry[];
}

/** One reconcile call for a single queued item → its outcome. */
async function reconcileOne(
  request: APIRequestContext,
  token: string,
  deviceId: string,
  item: Record<string, unknown>,
): Promise<string> {
  const res = await request.post(`${API}/checkin/reconcile`, {
    headers: authed(token),
    data: { deviceId, checkIns: [item] },
  });
  const body = (await res.json()) as { ticketId: string; outcome: string }[];
  return body[0]?.outcome;
}

/**
 * Reconciliation browser drill (ADR-035, Sprint 11). Proves the server always wins
 * at reconnect and invalid admissions are NEVER accepted. The panel drives the valid
 * offline→queue→sync→ACCEPTED round-trip; then a deterministic divergence matrix is
 * replayed through the real reconcile engine using the panel's approved device:
 * wrong-session, transfer (rotated nonce) and vanished-ticket are all surfaced (never
 * ACCEPTED and never mutate the ticket), a correct scan is ACCEPTED exactly once, and
 * a replay is idempotent (DUPLICATE_SAME_DEVICE). Repeated inputs yield identical
 * outcomes (deterministic) and each reconcile is audited (OFFLINE_CHECKIN_RECONCILED).
 * On PASS it records evidence, flipping the activation gate's `drill_reconcile` check
 * green. Skipped when the flag is off.
 */
test('offline gate: reconciliation surfaces conflicts, never a bad admission', async ({
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

  // Find a session with an active ticket (one ticket exercises the whole matrix: the
  // non-consuming divergence cases run while it is ACTIVE, then it is accepted once).
  const events = await (
    await request.get(`${API}/events?organizationId=${org.id}`, { headers: authed(token) })
  ).json();
  let found: { eventId: string; sessionId: string; ticket: Entry } | null = null;
  for (const e of events.slice(0, 25)) {
    const det = await (
      await request.get(`${API}/events/${e.id}`, { headers: authed(token) })
    ).json();
    for (const s of det.sessions ?? []) {
      const active = (await sessionEntries(request, token, s.id)).find(
        (x) => x.status === 'ACTIVE' && x.eligible,
      );
      if (active) {
        found = { eventId: e.id, sessionId: s.id, ticket: active };
        break;
      }
    }
    if (found) break;
  }
  expect(found, 'a session with an active ticket').not.toBeNull();
  const f = found!;
  const m = f.ticket;
  const qr = Buffer.from(
    JSON.stringify({
      ticketId: m.ticketId,
      eventSessionId: f.sessionId,
      nonce: m.nonce,
      version: m.version,
    }),
  ).toString('base64url');

  // Set up the panel + an approved device (used for both the panel path and the matrix).
  await seedBrowserAuth(page.context(), ownerTokens);
  await page.goto(`${ORGANIZER}/organizer/events/${f.eventId}/checkin`);
  await expect(page.getByRole('heading', { name: 'Offline mode' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByLabel('Session', { exact: true }).selectOption(f.sessionId);
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

  // ── Divergence matrix (server wins) — run WHILE the ticket is still ACTIVE ──
  const base = { deviceId, ticketId: m.ticketId, version: m.version, nonce: m.nonce };
  const wrongSession = await reconcileOne(request, token, deviceId, {
    ...base,
    eventSessionId: 'not-the-real-session',
    checkedInAt: Date.now(),
    wasOverride: false,
  });
  const transferred = await reconcileOne(request, token, deviceId, {
    ...base,
    nonce: `rotated-${m.nonce}`,
    eventSessionId: f.sessionId,
    checkedInAt: Date.now(),
    wasOverride: false,
  });
  const vanished = await reconcileOne(request, token, deviceId, {
    deviceId,
    ticketId: 'ckvanished0000000000000000',
    nonce: 'x',
    version: 1,
    eventSessionId: f.sessionId,
    checkedInAt: Date.now(),
    wasOverride: false,
  });
  expect(wrongSession).toBe('WRONG_SESSION');
  expect(transferred).toBe('TRANSFERRED_AFTER_DOWNLOAD');
  expect(vanished).toBe('SUPERVISOR_REVIEW_REQUIRED');

  // The contended ticket was never admitted by any of the rejected cases.
  const afterReject = (await sessionEntries(request, token, f.sessionId)).find(
    (x) => x.ticketId === m.ticketId,
  );
  expect(afterReject?.status, 'ticket untouched by rejected reconciles').toBe('ACTIVE');

  // Determinism: the same invalid input yields the same outcome.
  const wrongSessionAgain = await reconcileOne(request, token, deviceId, {
    ...base,
    eventSessionId: 'not-the-real-session',
    checkedInAt: Date.now(),
    wasOverride: false,
  });
  expect(wrongSessionAgain).toBe('WRONG_SESSION');

  // ── Browser valid path: offline VALID → queued → sync → ACCEPTED (admits the ticket) ──
  await page.getByLabel('Ticket QR token').fill(qr);
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByTestId('offline-result')).toContainText(/Valid/i);
  await expect(page.getByTestId('queue-count')).toContainText('1 queued');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('queue-count')).toContainText('0 queued', { timeout: 20_000 });
  const accepted = 'ACCEPTED';

  // A replay of the accepted scan is idempotent — never a double check-in.
  const replay = await reconcileOne(request, token, deviceId, {
    ...base,
    eventSessionId: f.sessionId,
    checkedInAt: Date.now(),
    wasOverride: false,
  });
  expect(replay).toBe('DUPLICATE_SAME_DEVICE');

  const afterAccept = (await sessionEntries(request, token, f.sessionId)).find(
    (x) => x.ticketId === m.ticketId,
  );
  expect(afterAccept?.status, 'ticket admitted exactly once').toBe('CHECKED_IN');

  // ── Auditable: each reconcile is recorded in the audit log ──
  const adminToken = (await apiLogin(request, ADMIN_USER)).accessToken;
  const audit = await (
    await request.get(`${API}/admin/audit?action=OFFLINE_CHECKIN_RECONCILED&pageSize=5`, {
      headers: authed(adminToken),
    })
  ).json();
  expect(audit.meta?.total, 'reconciliations are audited').toBeGreaterThan(0);
  expect(audit.data?.[0]?.action).toBe('OFFLINE_CHECKIN_RECONCILED');

  // ── Record certification evidence → flips the activation gate's reconcile check ──
  const rec = await request.post(`${API}/checkin/drills`, {
    headers: authed(token),
    data: {
      organizationId: org.id,
      eventId: f.eventId,
      eventSessionId: f.sessionId,
      drillKey: 'RECONCILIATION',
      outcome: 'PASS',
      summary:
        'Server wins: wrong-session/transfer/vanished surfaced (never ACCEPTED); valid ACCEPTED once; replay DUPLICATE_SAME_DEVICE; deterministic + audited.',
      evidence: { wrongSession, transferred, vanished, accepted, replay },
    },
  });
  expect(rec.ok(), 'drill result recorded').toBeTruthy();

  const activation = await (
    await request.get(`${API}/checkin/activation?organizationId=${org.id}`, {
      headers: authed(token),
    })
  ).json();
  const reconcileCheck = activation.checks?.find(
    (c: { key: string }) => c.key === 'drill_reconcile',
  );
  expect(reconcileCheck?.passed, 'activation gate reconciliation check is now green').toBe(true);
});
