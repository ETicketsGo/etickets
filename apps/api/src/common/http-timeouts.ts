import type { Server } from 'node:http';

/**
 * How long the API's HTTP server waits on a client, and how long it keeps an idle connection.
 *
 * ── WHY THESE WERE SET AT ALL ─────────────────────────────────────────────────────
 * main.ts never set them, so Node's defaults applied. Two of them are wrong behind Railway:
 *
 *   - keepAliveTimeout defaulted to 5 s. Railway's edge closes an idle HTTP/1.1 connection
 *     after 60 s ("Idle HTTP/1.1 connections are closed after 60 seconds between requests",
 *     docs.railway.com/networking/public-networking/specs-and-limits). When the app closes
 *     first, the edge can send the next request down a socket Node has just closed, and the
 *     customer gets a 502 that no log of ours explains. The rule for any server behind a proxy
 *     is that the server's idle timeout is LONGER than the proxy's, so the proxy always closes
 *     first: 65 s.
 *   - headersTimeout must be above keepAliveTimeout, or Node can drop a reused connection while
 *     it waits for the next request's headers (the long-standing Node/ALB 502). 66 s.
 *
 * requestTimeout bounds how long ONE request may take to arrive (headers and body), not how long
 * we take to answer it. Node's default is 300 s, which lets a client that trickles a body hold a
 * socket for five minutes. 120 s is generous for what this API receives - the largest upload is
 * a 3 MB image (ORG_COVER_MAX_BYTES), about 50 s at 0.5 Mbit/s - and a long admin report is a
 * slow RESPONSE, which this does not limit. Railway allows 5 minutes for a body; a client that
 * needs more than 120 s can be given it with HTTP_REQUEST_TIMEOUT_MS without a code change.
 *
 * Each value is configurable; the ordering rule is enforced here rather than trusted to the
 * variables, so a mistyped override cannot reintroduce the 502.
 */
export interface HttpTimeouts {
  keepAliveTimeoutMs: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
}

export const HTTP_TIMEOUT_DEFAULTS: HttpTimeouts = {
  keepAliveTimeoutMs: 65_000,
  headersTimeoutMs: 66_000,
  requestTimeoutMs: 120_000,
};

function positive(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Read the three values, falling back per value and keeping keep-alive < headers <= request. */
export function resolveHttpTimeouts(get: (key: string) => unknown): HttpTimeouts {
  const keepAliveTimeoutMs = positive(
    get('HTTP_KEEP_ALIVE_TIMEOUT_MS'),
    HTTP_TIMEOUT_DEFAULTS.keepAliveTimeoutMs,
  );
  const headersTimeoutMs = Math.max(
    positive(get('HTTP_HEADERS_TIMEOUT_MS'), HTTP_TIMEOUT_DEFAULTS.headersTimeoutMs),
    keepAliveTimeoutMs + 1_000,
  );
  // Node refuses a headersTimeout above a non-zero requestTimeout, so the request bound follows.
  const requestTimeoutMs = Math.max(
    positive(get('HTTP_REQUEST_TIMEOUT_MS'), HTTP_TIMEOUT_DEFAULTS.requestTimeoutMs),
    headersTimeoutMs,
  );
  return { keepAliveTimeoutMs, headersTimeoutMs, requestTimeoutMs };
}

/** Apply them to the listening server. */
export function applyHttpTimeouts(
  server: Pick<Server, 'keepAliveTimeout' | 'headersTimeout' | 'requestTimeout'>,
  t: HttpTimeouts,
): void {
  server.keepAliveTimeout = t.keepAliveTimeoutMs;
  server.headersTimeout = t.headersTimeoutMs;
  server.requestTimeout = t.requestTimeoutMs;
}
