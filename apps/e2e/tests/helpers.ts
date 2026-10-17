import { expect, type Page, type BrowserContext, type APIRequestContext } from '@playwright/test';

export const CUSTOMER = process.env.CUSTOMER_URL ?? 'http://localhost:3000';
export const ORGANIZER = process.env.ORGANIZER_URL ?? 'http://localhost:3001';
export const ADMIN = process.env.ADMIN_URL ?? 'http://localhost:3002';
export const API = process.env.API_URL ?? 'http://localhost:4000/api';

export const SEED_PASSWORD = 'Password123!';

/**
 * The password for accounts a spec REGISTERS during the run.
 *
 * `SEED_PASSWORD` is on every common-password list. That is harmless for seeded rows, which are
 * written straight to the database, and correctly refused for anything that goes through
 * registration — so a spec creating an account needs a password the policy accepts.
 */
export const NEW_ACCOUNT_PASSWORD = 'Blue-Lantern-Harbour-47';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/** Logs in via the API and returns the token pair (no browser interaction). */
export async function apiLogin(
  request: APIRequestContext,
  email: string,
  /** Seeded accounts use the seed password; accounts a spec registers use their own. */
  password: string = SEED_PASSWORD,
): Promise<AuthTokens> {
  const res = await request.post(`${API}/auth/login`, {
    data: { email, password },
  });
  const body = await res.json();
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

/**
 * Seeds web-kit's localStorage tokens so the browser app is authenticated without a
 * second login POST. Keeps login-heavy suites (e.g. the offline drills) under the
 * auth throttle without weakening it. Register before navigating to the app origin.
 */
export async function seedBrowserAuth(context: BrowserContext, tokens: AuthTokens): Promise<void> {
  await context.addInitScript((t) => {
    localStorage.setItem('etg_access', t.accessToken);
    localStorage.setItem('etg_refresh', t.refreshToken);
  }, tokens);
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}@e2e.test`;
}

/** Signs in through a LoginForm page (prefilled email may be overridden). */
export async function login(page: Page, baseUrl: string, email?: string) {
  await page.goto(`${baseUrl}/login`);
  if (email) {
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(SEED_PASSWORD);
  }
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
}

export function futureLocal(daysAhead: number, hour: number): string {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  d.setHours(hour, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * On the storefront's sign-up page, switch to the Email tab.
 *
 * Sign-up has Mobile | Email tabs like sign-in, Mobile first. The tabs appear once GET
 * /capabilities answers; when text messages are unavailable there are none and the page is
 * already on Email - so this waits for whichever of the two the page settles on.
 */
export async function chooseEmailSignUp(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: 'Email' });
  await tab.or(page.getByTestId('phone-signin-off')).first().waitFor({ timeout: 20_000 });
  if (await tab.count()) await tab.click();
}

/*
  Offline check-in devices (H5).

  A ticket list (manifest) is now issued to one registered, ACTIVE device, so even a spec that
  only reads the manifest to find a session with an ACTIVE ticket needs a device first. These
  helpers register and approve one through the API and remember it per event for the run, so a
  lookup loop over many sessions does not register a device per session.
*/
const offlineDeviceCache = new Map<string, string>();

/** Registers + approves an offline device for an event; returns its id (cached per event). */
export async function ensureOfflineDevice(
  request: APIRequestContext,
  token: string,
  organizationId: string,
  eventId: string,
  name = 'E2E lookup device',
): Promise<string> {
  const key = `${organizationId}|${eventId}`;
  const cached = offlineDeviceCache.get(key);
  if (cached) return cached;
  const headers = { authorization: `Bearer ${token}` };
  const device = await (
    await request.post(`${API}/checkin/devices`, {
      headers,
      data: { organizationId, eventId, name },
    })
  ).json();
  const approved = await request.post(`${API}/checkin/devices/${device.id}/approve`, { headers });
  expect(approved.ok(), 'offline device approved').toBeTruthy();
  offlineDeviceCache.set(key, device.id);
  return device.id;
}

/** GET /checkin/manifest for a session, issued to `deviceId` (the parsed JSON body). */
export async function fetchOfflineManifest(
  request: APIRequestContext,
  token: string,
  eventSessionId: string,
  deviceId: string,
) {
  return (
    await request.get(
      `${API}/checkin/manifest?eventSessionId=${eventSessionId}&deviceId=${deviceId}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
  ).json();
}

/**
 * The fields a queued scan uses to cite the list it was checked against. The server only
 * applies a scan that cites a list issued to the same device, made inside its validity.
 */
export function manifestCitation(manifest: { meta: { version: number }; signature: string }): {
  manifestVersion: number;
  manifestSignature: string;
} {
  return { manifestVersion: manifest.meta.version, manifestSignature: manifest.signature };
}
