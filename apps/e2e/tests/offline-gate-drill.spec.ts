import { test, expect, type APIRequestContext } from '@playwright/test';
import { ORGANIZER, SEED_PASSWORD, login } from './helpers';

const API = process.env.API_URL ?? 'http://localhost:4000/api';
const OWNER = 'owner@eticketsgo.test';

async function apiLogin(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: OWNER, password: SEED_PASSWORD },
  });
  return (await res.json()).accessToken as string;
}
const authed = (t: string) => ({ authorization: `Bearer ${t}` });

/**
 * Browser-level offline gate drill (ADR-035). Runs only when the offline feature
 * flag is enabled (otherwise skipped, so the default suite is unaffected). Proves:
 * offline validate → durable queue → local duplicate → queue survives reload →
 * reconnect sync. This is the operational proof that moves the launch gate from
 * NO-GO toward CONDITIONAL_GO.
 */
test('offline gate drill: validate, queue durably, dedupe, sync', async ({ page, request }) => {
  const token = await apiLogin(request);

  // Discover the org + a session that has an ACTIVE ticket (flag on required).
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

  // Drive the organizer offline panel in the browser.
  await login(page, ORGANIZER, OWNER);
  await page.goto(`${ORGANIZER}/organizer/events/${t.eventId}/checkin`);
  const panel = page.getByRole('heading', { name: 'Offline mode' });
  await expect(panel).toBeVisible({ timeout: 20_000 });

  await page.getByLabel('Session', { exact: true }).selectOption(t.sessionId);
  await page.getByRole('button', { name: /Register \+ approve device/ }).click();
  await expect(page.getByRole('button', { name: /Device approved/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Download manifest' }).click();
  await expect(page.getByTestId('manifest-status')).toBeVisible({ timeout: 20_000 });

  // Offline validate → queued
  await page.getByLabel('Ticket QR token').fill(t.qr);
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByTestId('offline-result')).toContainText(/Valid/i);
  await expect(page.getByTestId('queue-count')).toContainText('1 queued');

  // Same token again → local duplicate (not re-queued)
  await page.getByLabel('Ticket QR token').fill(t.qr);
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByTestId('offline-result')).toContainText(/ALREADY CHECKED IN LOCAL/i);
  await expect(page.getByTestId('queue-count')).toContainText('1 queued');

  // Queue survives a full reload (IndexedDB durability)
  await page.reload();
  await expect(page.getByTestId('queue-count')).toContainText('1 queued', { timeout: 20_000 });

  // Reconnect sync → server accepts → queue drains
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('queue-count')).toContainText('0 queued', { timeout: 20_000 });
});
