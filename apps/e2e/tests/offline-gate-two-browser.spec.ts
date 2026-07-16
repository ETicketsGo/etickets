import { test, expect, type Page } from '@playwright/test';
import { ORGANIZER, API, apiLogin, seedBrowserAuth, type AuthTokens } from './helpers';

const OWNER = 'owner@eticketsgo.test';

const authed = (t: string) => ({ authorization: `Bearer ${t}` });

/** Drives one browser's offline panel up to a queued (not yet synced) scan. */
async function queueScan(
  page: Page,
  tokens: AuthTokens,
  eventId: string,
  sessionId: string,
  qr: string,
) {
  await seedBrowserAuth(page.context(), tokens);
  await page.goto(`${ORGANIZER}/organizer/events/${eventId}/checkin`);
  await expect(page.getByRole('heading', { name: 'Offline mode' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByLabel('Session', { exact: true }).selectOption(sessionId);
  await page.getByRole('button', { name: /Register \+ approve device/ }).click();
  await expect(page.getByRole('button', { name: /Device approved/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Download manifest' }).click();
  await expect(page.getByTestId('manifest-status')).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Ticket QR token').fill(qr);
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByTestId('queue-count')).toContainText('1 queued');
}

/** Clicks Sync and returns the reconcile outcome the server sent back. */
async function syncAndOutcome(page: Page): Promise<string> {
  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/checkin/reconcile') && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Sync now' }).click(),
  ]);
  const body = (await resp.json()) as { ticketId: string; outcome: string }[];
  return body[0]?.outcome;
}

/**
 * Two-browser conflict drill (ADR-035, Sprint 11 priority 1). Two independent
 * browsers each register+approve their own device, download the manifest, and scan
 * the SAME ticket offline — both queue it durably. On reconnect both sync (fired
 * concurrently to race the atomic ACTIVE→CHECKED_IN claim): the server admits
 * EXACTLY ONE (ACCEPTED); the other is surfaced as DUPLICATE_OTHER_DEVICE. No double
 * check-in. On PASS the drill records certification evidence, which flips the
 * activation gate's `drill_two_device` check green. Skipped when the flag is off.
 */
test('offline gate: two devices scan one ticket, exactly one ACCEPTED', async ({
  browser,
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

  // Discover an event/session with an ACTIVE, eligible ticket to contend over.
  const events = await (
    await request.get(`${API}/events?organizationId=${org.id}`, { headers: authed(token) })
  ).json();
  let target: { eventId: string; sessionId: string; qr: string } | null = null;
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
      const active = (man.entries ?? []).find(
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
        target = { eventId: e.id, sessionId: s.id, qr };
        break;
      }
    }
    if (target) break;
  }
  expect(target, 'a session with an active ticket').not.toBeNull();
  const t = target!;

  // Two independent browsers (separate storage → separate devices + IndexedDB).
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    // Both queue the SAME ticket offline before either reconnects.
    await queueScan(pageA, ownerTokens, t.eventId, t.sessionId, t.qr);
    await queueScan(pageB, ownerTokens, t.eventId, t.sessionId, t.qr);

    // Reconnect both at once — race the atomic claim.
    const [outcomeA, outcomeB] = await Promise.all([syncAndOutcome(pageA), syncAndOutcome(pageB)]);

    // Exactly one ACCEPTED; the other a cross-device duplicate. Never two admits.
    expect([outcomeA, outcomeB].sort()).toEqual(['ACCEPTED', 'DUPLICATE_OTHER_DEVICE']);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }

  // Record certification evidence → flips the activation gate's two-device check.
  const rec = await request.post(`${API}/checkin/drills`, {
    headers: authed(token),
    data: {
      organizationId: org.id,
      eventId: t.eventId,
      eventSessionId: t.sessionId,
      drillKey: 'TWO_DEVICE_CONFLICT',
      outcome: 'PASS',
      summary:
        'Two browsers scanned one ticket; exactly one ACCEPTED, the other DUPLICATE_OTHER_DEVICE.',
      evidence: { ticketSessionId: t.sessionId },
    },
  });
  expect(rec.ok(), 'drill result recorded').toBeTruthy();

  const activation = await (
    await request.get(`${API}/checkin/activation?organizationId=${org.id}`, {
      headers: authed(token),
    })
  ).json();
  const twoDevice = activation.checks?.find((c: { key: string }) => c.key === 'drill_two_device');
  expect(twoDevice?.passed, 'activation gate two-device drill check is now green').toBe(true);
});
