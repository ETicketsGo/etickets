/**
 * May the showcase loader write to the API it has been pointed at?
 *
 * ── AN ALLOWLIST OF THIS MACHINE, NOTHING ELSE ─────────────────────────────────────
 * The loader registers organizer accounts, approves their organizations and events as an
 * admin, and publishes sixteen invented listings. That is useful on a laptop where a designer
 * wants honest screenshots, and harmful anywhere a real customer could see it. "Refuse if it
 * looks like QA or production" fails open the day a new host appears, so the question asked
 * here is the opposite one: is this host NAMED as this machine? Anything else - QA, UAT,
 * production, a Railway preview, a LAN address, a typo - is refused without needing to know
 * what it is.
 *
 * Decided from the URL alone, before any request is made, so a refusal happens before the
 * first login rather than after the first write.
 */

/** Loopback names only. `localhost.` and `127.1` are spellings a person types by mistake. */
export const LOCAL_API_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** The default target: the API on the port the design worktrees use for their own stack. */
export const DEFAULT_LOCAL_API = 'http://localhost:4131/api';

/**
 * @param {string | undefined} apiBase e.g. "http://localhost:4131/api"
 * @returns {{ allowed: boolean, apiBase: string | null, reason: string }}
 */
export function localTargetVerdict(apiBase) {
  const raw = (apiBase ?? '').trim();
  if (!raw) {
    return { allowed: false, apiBase: null, reason: 'No API base URL was given.' };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, apiBase: null, reason: `"${raw}" is not a URL.` };
  }
  // A local API is plain http. https here means a real host with a certificate, which is
  // exactly what this script must never reach - even if its name looks local.
  if (url.protocol !== 'http:') {
    return {
      allowed: false,
      apiBase: null,
      reason: `Refusing ${url.protocol}//${url.host}: the local API is reached over plain http.`,
    };
  }
  // Credentials in the URL are never how a local stack is addressed; refuse rather than strip.
  if (url.username || url.password) {
    return { allowed: false, apiBase: null, reason: 'Refusing a URL with credentials in it.' };
  }
  const host = url.hostname.toLowerCase();
  if (!LOCAL_API_HOSTS.includes(host)) {
    return {
      allowed: false,
      apiBase: null,
      reason:
        `Refusing ${host}: this script only writes to an API on this machine ` +
        '(localhost, 127.0.0.1 or ::1). It creates and approves fictional listings, which must ' +
        'never reach QA, UAT or production.',
    };
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '/api') {
    return {
      allowed: false,
      apiBase: null,
      reason: `Expected the API base to end in /api, got "${url.pathname}".`,
    };
  }
  const port = url.port ? `:${url.port}` : '';
  return {
    allowed: true,
    apiBase: `http://${host}${port}/api`,
    reason: `Local API at ${host}${port}.`,
  };
}
