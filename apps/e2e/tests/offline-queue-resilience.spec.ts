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
      const active = (man.entries ?? []).find((x: Entry) => x.status === 'ACTIVE' && x.eligible);
      if (active) return { org, flagOn, eventId: e.id, sessionId: s.id, a: active as Entry };
    }
  }
  return { org, flagOn, eventId: null, sessionId: null, a: null };
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
 * Offline queue resilience drill (ADR-035, Sprint 12 W1). One active ticket exercises
 * the whole resilience path: a non-retryable failure dead-letters (BLOCKED); the state
 * survives reload; manual retry re-queues; a retryable failure schedules a backoff
 * retry (RETRYING); the backoff timer auto-recovers to ACCEPTED. Throughout, the scan
 * is NEVER lost or admitted without a server acknowledgement. Skips when flag is off.
 */
test('offline queue: dead-letter → reload → manual retry → RETRYING → auto-recover (never lost)', async ({
  page,
  request,
}) => {
  const owner = await apiLogin(request, OWNER);
  const d = await discover(request, owner.accessToken);
  test.skip(!d.flagOn, 'Offline check-in feature flag is disabled — drill not applicable.');
  expect(d.sessionId, 'a session with an active ticket').not.toBeNull();

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
  await scan(page, qrToken(d.a!, d.sessionId!));
  await expect(page.getByTestId('queue-count')).toContainText('1 queued');

  // Non-retryable (403) → BLOCKED (dead-letter), held not dropped, not admitted.
  mode = '403';
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('queue-count')).toContainText('1 blocked', { timeout: 20_000 });
  await expect(page.getByTestId('deadletter-banner')).toBeVisible();

  // Reload durability: the blocked record persists across a restart.
  await page.reload();
  await expect(page.getByTestId('queue-count')).toContainText('1 blocked', { timeout: 20_000 });

  // Manual retry re-queues, then a retryable (network) failure schedules a backoff retry.
  mode = 'abort';
  await page.getByRole('button', { name: 'Retry blocked' }).click();
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('queue-count')).toContainText('1 retrying', { timeout: 20_000 });
  await expect(page.getByTestId('queue-count')).toContainText('0 blocked');

  // Recover: the backoff timer re-attempts and the server accepts it.
  mode = 'ok';
  await expect(page.getByTestId('queue-count')).toContainText('0 retrying', { timeout: 30_000 });
  await expect(page.getByTestId('queue-count')).toContainText('0 queued', { timeout: 30_000 });

  // Server truth: the ticket was admitted exactly once (no longer ACTIVE).
  const man = await (
    await request.get(`${API}/checkin/manifest?eventSessionId=${d.sessionId}`, {
      headers: authed(owner.accessToken),
    })
  ).json();
  const entry = (man.entries as Entry[]).find((e) => e.ticketId === d.a!.ticketId);
  expect(entry?.status, 'ticket admitted (not stuck ACTIVE)').not.toBe('ACTIVE');
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

    await setupPanel(tab1, d.eventId!, d.sessionId!);
    await scan(tab1, qrToken(d.a!, d.sessionId!));
    await expect(tab1.getByTestId('queue-count')).toContainText('1 queued');

    await tab2.goto(`${ORGANIZER}/organizer/events/${d.eventId}/checkin`);
    await expect(tab2.getByRole('heading', { name: 'Offline mode' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(tab2.getByTestId('queue-count')).toContainText('1 queued', { timeout: 20_000 });

    // Both tabs sync concurrently — the Web Lock elects a single leader.
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
