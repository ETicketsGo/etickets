import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { ORGANIZER, API, apiLogin, seedBrowserAuth } from './helpers';

const OWNER = 'owner@eticketsgo.test';
const CUSTOMER = 'customer1@eticketsgo.test';

const authed = (t: string) => ({ authorization: `Bearer ${t}` });

interface Entry {
  ticketId: string;
  nonce: string;
  version: number;
  status: string;
  eligible: boolean;
}
function preflight(request: APIRequestContext, token: string, body: Record<string, unknown>) {
  return request.post(`${API}/checkin/preflight`, { headers: authed(token), data: body });
}
async function seedManifestCache(page: Page, sessionId: string, version: number) {
  await page.evaluate(
    ({ sid, v }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('etg-checkin', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('queue'))
            db.createObjectStore('queue', { keyPath: 'localId' });
          if (!db.objectStoreNames.contains('manifest'))
            db.createObjectStore('manifest', { keyPath: 'eventSessionId' });
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('manifest', 'readwrite');
          tx.objectStore('manifest').put({
            eventSessionId: sid,
            meta: { version: v },
            entries: [],
            savedAt: Date.now(),
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    { sid: sessionId, v: version },
  );
}

/**
 * Offline preflight checklist drill (ADR-035, Sprint 12). Covers every checklist
 * condition via the API (stale manifest, clock skew, queued items, revoked device,
 * activation downgrade, authz) and the READY / WARNING / NOT_READY verdicts through
 * the browser UI. The checklist is advisory — it never overrides the gate. Skips when
 * the flag is off.
 */
test('preflight: READY → WARNING → NOT_READY, every condition, advisory only', async ({
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

  // Find an event/session with an active ticket.
  const events = await (
    await request.get(`${API}/events?organizationId=${org.id}`, { headers: authed(token) })
  ).json();
  let target: { eventId: string; sessionId: string } | null = null;
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
      if ((man.entries ?? []).some((x: Entry) => x.status === 'ACTIVE' && x.eligible)) {
        target = { eventId: e.id, sessionId: s.id };
        break;
      }
    }
    if (target) break;
  }
  expect(target).not.toBeNull();
  const t = target!;

  // ── Set up a READY device: approved, recently synced, activation GO ──
  const device = await (
    await request.post(`${API}/checkin/devices`, {
      headers: authed(token),
      data: { organizationId: org.id, eventId: t.eventId, name: `Preflight ${Date.now()}` },
    })
  ).json();
  const dev = device.id;
  await request.post(`${API}/checkin/devices/${dev}/approve`, { headers: authed(token) });
  for (const drillKey of ['TWO_DEVICE_CONFLICT', 'DEVICE_LOSS', 'RECONCILIATION']) {
    await request.post(`${API}/checkin/drills`, {
      headers: authed(token),
      data: {
        organizationId: org.id,
        eventId: t.eventId,
        eventSessionId: t.sessionId,
        drillKey,
        outcome: 'PASS',
        summary: 'x',
      },
    });
  }
  const manifest = await (
    await request.get(`${API}/checkin/manifest?eventSessionId=${t.sessionId}`, {
      headers: authed(token),
    })
  ).json();
  const V = manifest.meta.version as number;
  const active = (manifest.entries as Entry[]).find((x) => x.status === 'ACTIVE' && x.eligible)!;
  // Reconcile a valid scan so the device has a recent lastSeenAt (deltas current).
  await request.post(`${API}/checkin/reconcile`, {
    headers: authed(token),
    data: {
      deviceId: dev,
      checkIns: [
        {
          deviceId: dev,
          ticketId: active.ticketId,
          nonce: active.nonce,
          version: active.version,
          eventSessionId: t.sessionId,
          checkedInAt: Date.now(),
          wasOverride: false,
        },
      ],
    },
  });
  await request.post(`${API}/checkin/activation/record`, {
    headers: authed(token),
    data: {
      organizationId: org.id,
      eventSessionId: t.sessionId,
      deviceIds: [dev],
      reason: 'preflight drill',
    },
  });

  const now = Date.now();
  const base = { organizationId: org.id, eventSessionId: t.sessionId, deviceId: dev };

  // ── API: every checklist condition (deterministic via client-reported values) ──
  const ready = await (
    await preflight(request, token, {
      ...base,
      clientManifestVersion: V,
      clientTimeMs: now,
      queueDepth: 0,
    })
  ).json();
  expect(ready.verdict, 'all checks pass → READY').toBe('READY');

  const stale = await (
    await preflight(request, token, {
      ...base,
      clientManifestVersion: V - 1,
      clientTimeMs: now,
      queueDepth: 0,
    })
  ).json();
  expect(stale.verdict, 'stale manifest → NOT_READY').toBe('NOT_READY');
  expect(stale.checks.find((c: { key: string }) => c.key === 'manifest_latest').status).toBe(
    'fail',
  );

  const queued = await (
    await preflight(request, token, {
      ...base,
      clientManifestVersion: V,
      clientTimeMs: now,
      queueDepth: 4,
    })
  ).json();
  expect(queued.verdict, 'queued items → WARNING').toBe('WARNING');

  const skew = await (
    await preflight(request, token, {
      ...base,
      clientManifestVersion: V,
      clientTimeMs: now - 10 * 60_000,
      queueDepth: 0,
    })
  ).json();
  expect(skew.verdict, 'clock skew → NOT_READY').toBe('NOT_READY');
  expect(skew.checks.find((c: { key: string }) => c.key === 'clock_skew').status).toBe('fail');

  // Authorization: a customer cannot run preflight for this org.
  const custToken = (await apiLogin(request, CUSTOMER)).accessToken;
  const custPre = await preflight(request, custToken, { ...base, clientTimeMs: now });
  expect(custPre.status(), 'customer forbidden').toBe(403);

  // ── Browser: READY → WARNING → NOT_READY ──
  await seedBrowserAuth(page.context(), ownerTokens);
  await page.goto(`${ORGANIZER}/organizer/events/${t.eventId}/preflight`);
  await expect(page.getByRole('heading', { name: 'Offline preflight' })).toBeVisible({
    timeout: 20_000,
  });
  await seedManifestCache(page, t.sessionId, V); // the device holds the latest manifest

  await page.getByLabel('Session').selectOption(t.sessionId);
  await page.getByLabel('Device').selectOption(dev);
  await page.getByRole('button', { name: 'Run checks' }).click();
  await expect(page.getByText('READY', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();

  // Introduce a pending supervisor review → WARNING (non-blocking).
  await request.post(`${API}/checkin/reconcile`, {
    headers: authed(token),
    data: {
      deviceId: dev,
      checkIns: [
        {
          deviceId: dev,
          ticketId: 'ckvanished0000000000000000',
          nonce: 'x',
          version: 1,
          eventSessionId: t.sessionId,
          checkedInAt: Date.now(),
          wasOverride: false,
        },
      ],
    },
  });
  await page.getByRole('button', { name: 'Run checks' }).click();
  await expect(page.getByText('WARNING', { exact: true })).toBeVisible({ timeout: 20_000 });

  // Revoke the device → NOT_READY (device inactive + activation downgrade + alert).
  await request.post(`${API}/checkin/devices/${dev}/revoke`, {
    headers: authed(token),
    data: { reason: 'preflight drill' },
  });
  await page.getByRole('button', { name: 'Run checks' }).click();
  await expect(page.getByText('NOT READY', { exact: true })).toBeVisible({ timeout: 20_000 });
  // The blocking failure + its guidance are shown.
  await expect(page.getByText('Device approved & active')).toBeVisible();
  await expect(page.getByText(/Have a manager approve the device/)).toBeVisible();

  // Server truth: revoking the in-scope device downgraded activation (rules enforced).
  const finalPre = await (
    await preflight(request, token, {
      ...base,
      clientManifestVersion: V,
      clientTimeMs: Date.now(),
      queueDepth: 0,
    })
  ).json();
  expect(finalPre.verdict).toBe('NOT_READY');
  expect(finalPre.checks.find((c: { key: string }) => c.key === 'activation_go').status).toBe(
    'fail',
  );
});
