import { isIP } from 'node:net';
import type { Request } from 'express';

/**
 * Which client a rate limit counts against.
 *
 * ── THE FAILURE THIS CLOSES ────────────────────────────────────────────────────────
 * The throttler keyed on `req.ip`, and behind Railway `req.ip` is not the visitor. With
 * `trust proxy = 1` Express takes the right-most `X-Forwarded-For` entry, and on Railway that
 * entry is the EDGE PROXY NODE that carried the request, not the address that sent it. Seen on
 * QA (one api replica, 2026-10-14): the global limit's `x-ratelimit-remaining` counted down
 * separately for each `x-hikari-trace` node (`sjc1.mdvq` 118, 117, 116 ... while `sjc1.hqvw`
 * ran 119, 118, 117 ... on the same client), and 15 wrong logins in a row got 401 every time
 * because the requests alternated between two nodes - the "about 20 a minute instead of 10".
 *
 * That is wrong in both directions. An attacker gets the limit once per edge node, and every
 * visitor who happens to share a node shares one budget: ten wrong passwords from anybody
 * lock out everyone else on that node for a minute.
 *
 * ── WHY X-Real-IP AND NOT A DIFFERENT HOP COUNT ────────────────────────────────────
 * Railway documents `X-Real-IP` as the client's remote address, set by its edge. The shape of
 * `X-Forwarded-For` behind the edge is not documented, and "count two hops instead of one" is
 * a guess about it that silently goes wrong the day the shape changes. So on Railway the
 * header is the source, and `req.ip` (the configured hop count) is only the fallback.
 *
 * `X-Forwarded-For` is never read here. A client can put anything in it, and whatever it puts
 * there sits to the LEFT of what the proxies append, which the configured hop count already
 * refuses to trust.
 *
 * ── WHY NOT EVERYWHERE ─────────────────────────────────────────────────────────────
 * The header is only as trustworthy as the proxy that sets it. Off Railway (a laptop, a test,
 * another host) nothing overwrites it, so trusting it would let any client choose its own key
 * and reset its count with every request. It is therefore used only where Railway is known to
 * be in front: by default when Railway's own `RAILWAY_ENVIRONMENT_ID` is present, or when
 * `THROTTLE_CLIENT_IP_HEADER` names a header deliberately.
 */

/** Value of THROTTLE_CLIENT_IP_HEADER that turns the header off and keeps `req.ip`. */
const NONE = 'none';

/** Header names are tokens; anything else reads as "not configured" rather than as a header. */
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;

/**
 * The trusted client-IP header for this process, or `null` for `req.ip`.
 *
 * Explicit configuration wins. Unset, it is `x-real-ip` on Railway and `null` anywhere else.
 */
export function resolveClientIpHeader(env: {
  THROTTLE_CLIENT_IP_HEADER?: string;
  RAILWAY_ENVIRONMENT_ID?: string;
}): string | null {
  const raw = (env.THROTTLE_CLIENT_IP_HEADER ?? '').trim().toLowerCase();
  if (raw === NONE) return null;
  if (raw && HEADER_NAME.test(raw)) return raw;
  return (env.RAILWAY_ENVIRONMENT_ID ?? '').trim() ? 'x-real-ip' : null;
}

/** `::ffff:203.0.113.7` and `203.0.113.7` are one client, so they must be one key. */
function normalise(ip: string): string {
  const v = ip.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  return (mapped ? mapped[1] : v).toLowerCase();
}

/**
 * The client address for `req`, by the rule above.
 *
 * A header that is missing, repeated, a list, or not an IP address is ignored rather than used:
 * the edge sets exactly one address, so anything else did not come from the edge, and the
 * fallback is the same `req.ip` this platform has always counted on.
 */
export function clientIpFor(req: Request, header: string | null): string {
  if (header) {
    const value = req.headers[header];
    if (typeof value === 'string' && !value.includes(',') && isIP(value.trim())) {
      return normalise(value);
    }
  }
  const fallback = req.ip ?? req.socket?.remoteAddress ?? '';
  return fallback ? normalise(fallback) : 'unknown';
}

/** A `getTracker` for `@nestjs/throttler`, bound to one header decision. */
export function clientIpTracker(header: string | null): (req: Record<string, unknown>) => string {
  return (req) => clientIpFor(req as unknown as Request, header);
}
