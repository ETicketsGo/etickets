/**
 * May the QA demo seed write to the API it has been pointed at?
 *
 * ── AN ALLOWLIST, LIKE THE DESTRUCTIVE-SEED GUARD ──────────────────────────────────
 * The seed creates events, uploads images and approves its own events as an admin. That is
 * exactly right on QA and exactly wrong anywhere a real customer could see it. "Refuse if it
 * looks like production" fails open the day a new host appears, so the question asked here is
 * the opposite one: is this host NAMED as QA? Anything else - UAT, production, a preview
 * deploy, localhost, a typo - is refused without needing to know what it is.
 *
 * Decided from the URL alone, before any request is made, so a refusal happens before the
 * first login rather than after the first write.
 */

/** The QA API, under its custom domain and under Railway's generated one. Nothing else. */
export const QA_API_HOSTS = ['api-qa.eticketsgo.com', 'api-qa-f580.up.railway.app'];

/** The default target: the custom domain, which outlives Railway's generated host names. */
export const DEFAULT_QA_API = 'https://api-qa.eticketsgo.com/api';

/**
 * @param {string | undefined} apiBase e.g. "https://api-qa.eticketsgo.com/api"
 * @returns {{ allowed: boolean, apiBase: string | null, reason: string }}
 */
export function qaTargetVerdict(apiBase) {
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
  if (url.protocol !== 'https:') {
    return {
      allowed: false,
      apiBase: null,
      reason: `Refusing ${url.protocol}//${url.host}: the QA API is only reached over https.`,
    };
  }
  // Credentials or a port in the URL are never how QA is addressed; refuse rather than strip.
  if (url.username || url.password || url.port) {
    return {
      allowed: false,
      apiBase: null,
      reason: 'Refusing a URL with credentials or a port in it.',
    };
  }
  const host = url.hostname.toLowerCase();
  if (!QA_API_HOSTS.includes(host)) {
    return {
      allowed: false,
      apiBase: null,
      reason:
        `Refusing ${host}: this script only writes to the QA API (${QA_API_HOSTS.join(', ')}). ` +
        'It creates and approves demo events, which must never reach UAT or production.',
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
  return { allowed: true, apiBase: `https://${host}/api`, reason: `QA API at ${host}.` };
}
