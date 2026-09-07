import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

/**
 * Which links a notification is allowed to carry.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────
 * The push channel read `payload.url` and passed it straight to the device as the tap
 * target. A payload is assembled by whichever service is sending, so any producer — present
 * or future, deliberate or mistaken — could put any URL into a notification that arrives
 * under this platform's name and icon. That is a phishing primitive with our branding on it,
 * and it needs no compromise to exercise: one careless producer is enough.
 *
 * The same class of bug has already cost this platform five times over, in the other
 * direction: a `http://localhost:…` default shipped into a deployed environment, silently,
 * because a default is not a missing value. One of those was found by a paying customer
 * returning from a payment to a laptop that was not theirs.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────────────
 * A link in a notification must be on a host this deployment is configured to own. Not a
 * pattern, not a suffix match — the exact origin of one of the configured sites. Anything
 * else is dropped, and the notification still goes: a booking confirmation without a deep
 * link is a mildly worse message, and one carrying somebody else's link is a different kind
 * of thing entirely.
 *
 * ── WHY DROPPED AND NOT REFUSED ────────────────────────────────────────────────────
 * Refusing the send would let a bad link suppress a message the customer is owed. Dropping
 * the link keeps the message and loses only the convenience, which is the right way round.
 */

/** The sites this deployment owns. Each is already the authority for its own origin. */
const SITE_KEYS = [
  'CUSTOMER_WEB_URL',
  'ORGANIZER_WEB_URL',
  'ADMIN_WEB_URL',
  'PUBLIC_API_URL',
] as const;

const logger = new Logger('Notification');

function originsFrom(config: ConfigService): Set<string> {
  const origins = new Set<string>();
  for (const key of SITE_KEYS) {
    const raw = config.get<string>(key);
    if (!raw?.trim()) continue;
    try {
      origins.add(new URL(raw.trim()).origin);
    } catch {
      // A malformed configured URL is not a reason to accept an arbitrary one. Skipped, and
      // the effect is a stricter allowlist rather than a looser one.
    }
  }
  return origins;
}

/**
 * A link that is safe to put in a message, or null.
 *
 * ── WHY http IS REJECTED EVEN WHEN CONFIGURED ──────────────────────────────────────
 * A ticket link identifies a booking. Sent over plain HTTP it is readable by anything
 * between the handset and the server, and a link in an SMS or a push notification is opened
 * on exactly the networks where that matters. `localhost` is the single exception, because
 * local development has no certificate and blocking it would only teach somebody to disable
 * this check.
 */
export function safeNotificationLink(config: ConfigService, candidate: unknown): string | null {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    return null;
  }

  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) {
    logger.warn(`dropped a notification link on ${url.protocol}//: not HTTPS`);
    return null;
  }

  const allowed = originsFrom(config);
  if (allowed.size === 0) {
    /*
      Nothing configured. Refusing every link would break local development, where none of
      these variables is set; accepting every link would make the check meaningless in the
      environment where it matters. Local origins only is the arrangement that is safe in a
      deployment and workable on a laptop.
    */
    return isLocal ? url.toString() : null;
  }
  if (!allowed.has(url.origin)) {
    // The origin, never the full URL: a link can carry a token, and this line goes to a log.
    logger.warn(`dropped a notification link to an unowned origin: ${url.origin}`);
    return null;
  }
  return url.toString();
}
