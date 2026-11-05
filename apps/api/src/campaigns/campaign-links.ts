import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { safeNotificationLink } from '../notifications/channels/link-safety';

/**
 * Links in campaign email: where they may go, and the signed reference the email carries.
 *
 * ── WHERE A LINK MAY GO ────────────────────────────────────────────────────────────
 * Only to a host this platform owns: one of the configured site origins (the same allowlist
 * every notification link passes, `link-safety.ts`) or eticketsgo.com and its subdomains over
 * https. Anything else is refused when the draft is saved, and dropped again when it is
 * rendered and when the click is redirected. Three locks, because an open redirect on our
 * domain is the most useful thing a phisher can be given.
 *
 * ── WHAT THE EMAIL CARRIES ─────────────────────────────────────────────────────────
 * Not the target: a token naming the link row and the recipient, signed with HMAC-SHA256.
 * Editing it to point somewhere else breaks the signature; the target is read from our own
 * table at click time.
 */

const OWNED_APEX = 'eticketsgo.com';

/** The target if a campaign may link to it, else null. */
export function allowedCampaignTarget(
  config: Pick<ConfigService, 'get'>,
  candidate: unknown,
): string | null {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 1000) return null;
  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    return null;
  }
  // Credentials in a URL ("https://eticketsgo.com@evil.example") are how a host is faked.
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') {
    const host = url.hostname.toLowerCase();
    if (host === OWNED_APEX || host.endsWith(`.${OWNED_APEX}`)) return url.toString();
  }
  return safeNotificationLink(config as ConfigService, url.toString());
}

/**
 * The click-token key. A dedicated derivation of the access-token secret, so the same bytes
 * never sign two kinds of thing (the unsubscribe links do the same with their own label).
 */
export function clickKey(config: Pick<ConfigService, 'get'>): Buffer {
  const base = config.get<string>('JWT_ACCESS_SECRET');
  if (!base) throw new Error('Campaign click links need JWT_ACCESS_SECRET.');
  return createHmac('sha256', base).update('eticketsgo:campaign-click:v1').digest();
}

export interface ClickClaims {
  linkId: string;
  recipientId: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function signClickToken(claims: ClickClaims, key: Buffer): string {
  if (!ID.test(claims.linkId) || !ID.test(claims.recipientId)) {
    throw new Error('Invalid click claims.');
  }
  const body = Buffer.from(`${claims.linkId}.${claims.recipientId}`, 'utf8').toString('base64url');
  // 16 bytes of the MAC is plenty for a link that only records a click and redirects home.
  const sig = createHmac('sha256', key).update(body).digest().subarray(0, 16).toString('base64url');
  return `${body}.${sig}`;
}

export function verifyClickToken(
  token: string | null | undefined,
  key: Buffer,
): ClickClaims | null {
  if (!token || token.length > 300) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac('sha256', key).update(body).digest().subarray(0, 16);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [linkId, recipientId] = Buffer.from(body, 'base64url').toString('utf8').split('.');
  if (!linkId || !recipientId || !ID.test(linkId) || !ID.test(recipientId)) return null;
  return { linkId, recipientId };
}

/** The API origin plus prefix, for links the API itself answers (clicks, images). */
export function apiBase(config: Pick<ConfigService, 'get'>): string {
  const prefix = (config.get<string>('API_GLOBAL_PREFIX') ?? 'api').replace(/^\/+|\/+$/g, '');
  const origin =
    config.get<string>('PUBLIC_API_URL')?.trim().replace(/\/+$/, '') || 'http://localhost:4000';
  return `${origin}${prefix ? `/${prefix}` : ''}`;
}

export function clickUrl(config: Pick<ConfigService, 'get'>, token: string): string {
  return `${apiBase(config)}/public/campaign-links/${token}`;
}
