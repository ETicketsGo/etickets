import {
  test,
  expect,
  type APIRequestContext,
  type Page,
  type BrowserContext,
} from '@playwright/test';
import { ORGANIZER, API, apiLogin, seedBrowserAuth } from './helpers';

const OWNER = 'owner@eticketsgo.test';
const authed = (t: string) => ({ authorization: `Bearer ${t}` });

interface Entry {
  ticketId: string;
  nonce: string;
  version: number;
  status: string;
  eligible: boolean;
}
function qrToken(e: Entry, sessionId: string): string {
  return Buffer.from(
    JSON.stringify({
      ticketId: e.ticketId,
      eventSessionId: sessionId,
      nonce: e.nonce,
      version: e.version,
    }),
  ).toString('base64url');
}
async function discover(request: APIRequestContext, token: string) {
  const org = (
    await (await request.get(`${API}/organizations`, { headers: authed(token) })).json()
  )[0];
  const readiness = await (
    await request.get(`${API}/checkin/offline-readiness?organizationId=${org.id}`, {
      headers: authed(token),
    })
  ).json();
  const flagOn = readiness.checks?.find((c: { key: string }) => c.key === 'flag')?.passed === true;
  const events = await (
    await request.get(`${API}/events?organizationId=${org.id}`, { headers: authed(token) })
  ).json();
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
      const active = (man.entries ?? []).filter((x: Entry) => x.status === 'ACTIVE' && x.eligible);
      if (active.length >= 2)
        return { org, flagOn, eventId: e.id, sessionId: s.id, a: active[0], b: active[1] };
    }
  }
  return { org, flagOn, eventId: null, sessionId: null, a: null, b: null };
}
async function setupPanel(page: Page, eventId: string, sessionId: string) {
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
}
async function scan(page: Page, token: string) {
  await page.getByLabel('Ticket QR token').fill(token);
  await page.getByRole('button', { name: 'Validate' }).click();
}

/**
 * Offline queue resilience drill (ADR-035, Sprint 12 W1). Proves: a retryable failure
 * holds the scan and auto-recovers; a non-retryable failure dead-letters (BLOCKED) and
 * can be manually retried; state survives reload; and a scan is NEVER lost without a
 * server acknowledgement. Skips when the flag is off.
 */
test('offline queue: retry → recover, non-retryable → dead-letter → manual retry, reload durable', async ({
  page,
  request,
}) => {
  const owner = await apiLogin(request, OWNER);
  const d = await discover(request, owner.accessToken);
  test.skip(!d.flagOn, 'Offline check-in feature flag is disabled — drill not applicable.');
  expect(d.sessionId, 'a session with two active tickets').not.toBeNull();

  // Toggleable network fault injection on the reconcile call.
  let mode: 'ok' | 'abort' | '500' | '403' = 'ok';
  await page.route('**/api/checkin/reconcile', async (route) => {
    if (mode === 'abort') return route.abort('failed');
    if (mode === '500')
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'server error' }),
      });
    if (mode === '403')
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'FORBIDDEN', message: 'revoked' }),
      });
    return route.continue();
  });

  await seedBrowserAuth(page.context(), owner);
  await setupPanel(page, d.eventId!, d.sessionId!);

  // ── Retryable network failure → RETRYING (held, not lost) → auto-recovery ──
  await scan(page, qrToken(d.a!, d.sessionId!));
  await expect(page.getByTestId('queue-count')).toContainText('1 queued');
  mode = 'abort';
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('queue-count')).toContainText('1 retrying', { timeout: 20_000 });
  // The record survived the failure (never deleted without an ack).
  await expect(page.getByTestId('queue-count')).toContainText('0 blocked');
  // Recover: stop failing; the backoff timer re-attempts and the server accepts it.
  mode = 'ok';
  await expect(page.getByTestId('queue-count')).toContainText('0 retrying', { timeout: 30_000 });
  await expect(page.getByTestId('queue-count')).toContainText('0 queued', { timeout: 30_000 });

  // ── Non-retryable rejection → BLOCKED (dead-letter), not lost, not admitted ──
  await scan(page, qrToken(d.b!, d.sessionId!));
  await expect(page.getByTestId('queue-count')).toContainText('1 queued');
  mode = '403';
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('queue-count')).toContainText('1 blocked', { timeout: 20_000 });
  await expect(page.getByTestId('deadletter-banner')).toBeVisible();

  // Reload durability: the blocked record persists in IndexedDB across a restart.
  await page.reload();
  await expect(page.getByTestId('queue-count')).toContainText('1 blocked', { timeout: 20_000 });

  // ── Manual retry of the dead-letter, once the cause is fixed ──
  mode = 'ok';
  await page.getByRole('button', { name: 'Retry blocked' }).click();
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('queue-count')).toContainText('0 blocked', { timeout: 20_000 });
  await expect(page.getByTestId('queue-count')).toContainText('0 queued', { timeout: 20_000 });

  // Server truth: exactly the two tickets ended up checked in (nothing lost/duplicated).
  const man = await (
    await request.get(`${API}/checkin/manifest?eventSessionId=${d.sessionId}`, {
      headers: authed(owner.accessToken),
    })
  ).json();
  const stillActive = (man.entries as Entry[]).filter(
    (e) => (e.ticketId === d.a!.ticketId || e.ticketId === d.b!.ticketId) && e.status === 'ACTIVE',
  );
  expect(stillActive.length, 'both scanned tickets were admitted (none stuck ACTIVE)').toBe(0);
});

/**
 * Multi-tab coordination: two tabs share one device (same IndexedDB + Web Locks). Only
 * ONE tab may act as the sync leader, so the same queue is never submitted twice.
 */
test('offline queue: two tabs share one device — exactly one sync leader', async ({
  browser,
  request,
}) => {
  const owner = await apiLogin(request, OWNER);
  const d = await discover(request, owner.accessToken);
  test.skip(!d.flagOn, 'Offline check-in feature flag is disabled — drill not applicable.');
  expect(d.sessionId).not.toBeNull();

  const context: BrowserContext = await browser.newContext();
  // Count reconcile POSTs reaching the server across BOTH tabs in this context.
  let reconcilePosts = 0;
  context.on('request', (req) => {
    if (req.url().includes('/checkin/reconcile') && req.method() === 'POST') reconcilePosts += 1;
  });
  try {
    await seedBrowserAuth(context, owner);
    const tab1 = await context.newPage();
    const tab2 = await context.newPage();

    // Tab 1 sets up the device + manifest and queues one scan (shared IndexedDB).
    await setupPanel(tab1, d.eventId!, d.sessionId!);
    await scan(tab1, qrToken(d.a!, d.sessionId!));
    await expect(tab1.getByTestId('queue-count')).toContainText('1 queued');

    // Tab 2 opens the same device (deviceId shared via localStorage) and sees the queue.
    await tab2.goto(`${ORGANIZER}/organizer/events/${d.eventId}/checkin`);
    await expect(tab2.getByRole('heading', { name: 'Offline mode' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(tab2.getByTestId('queue-count')).toContainText('1 queued', { timeout: 20_000 });

    // Both tabs sync concurrently — the Web Lock elects a single leader, so the queue is
    // submitted exactly once.
    await Promise.all([
      tab1.getByRole('button', { name: 'Sync now' }).click(),
      tab2.getByRole('button', { name: 'Sync now' }).click(),
    ]);
    await expect(tab1.getByTestId('queue-count')).toContainText('0 queued', { timeout: 20_000 });
    await expect(tab2.getByTestId('queue-count')).toContainText('0 queued', { timeout: 20_000 });

    expect(reconcilePosts, 'exactly one tab submitted the shared queue').toBe(1);
  } finally {
    await context.close();
  }
});
