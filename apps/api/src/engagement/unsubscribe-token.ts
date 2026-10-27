import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AppException, ErrorCodes } from '../common/errors';
import { redirectUrl } from '../common/console-urls';
import { ConsentPurpose, isOrganizerPurpose } from './consent-purpose';

/**
 * Signed one-click unsubscribe links.
 *
 * ── WHAT A TOKEN SAYS ──────────────────────────────────────────────────────────────
 * Who (the account, and the address the email went to), what scope (the platform, or one
 * organizer) and which purpose. It is signed with HMAC-SHA256, so a person cannot edit it
 * to unsubscribe somebody else or to name another organizer. It carries no expiry: anti-spam
 * law expects an unsubscribe link to keep working long after the email was sent, and a link
 * that only ever WITHDRAWS consent is not worth stealing.
 *
 * ── WHY GET NEVER UNSUBSCRIBES ─────────────────────────────────────────────────────
 * Mail scanners and link previewers open every link in a message. If GET withdrew consent,
 * a security scanner would unsubscribe people from mail they wanted. GET shows what would
 * happen; POST does it. RFC 8058 one-click is a POST, so it works without a page.
 */

export type UnsubscribeScope = 'global' | 'organizer';

export interface UnsubscribeClaims {
  /** The account, when the email went to one. */
  userId: string | null;
  /** The address the email went to. Lower-cased. */
  email: string;
  scope: UnsubscribeScope;
  /** Required for scope `organizer`, absent for `global`. */
  organizationId: string | null;
  /** MARKETING_EMAIL for global; an organizer purpose, or ALL, for organizer scope. */
  purpose: string;
}

/** Withdraw every organizer purpose at once. What the one-click header link does. */
export const ALL_ORGANIZER_PURPOSES = 'ALL';

interface Wire {
  v: 1;
  u?: string;
  e: string;
  s: 'g' | 'o';
  o?: string;
  p: string;
}

const MAX_TOKEN_LENGTH = 2048;

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

/**
 * The key. A dedicated secret when set; otherwise one DERIVED from the access-token secret,
 * so the same bytes never sign two different kinds of thing. Rotating JWT_ACCESS_SECRET
 * without setting UNSUBSCRIBE_SIGNING_SECRET breaks every link already sent - set the
 * dedicated one in any environment that sends marketing email.
 */
export function unsubscribeKey(config: Pick<ConfigService, 'get'>): Buffer {
  const dedicated = config.get<string>('UNSUBSCRIBE_SIGNING_SECRET')?.trim();
  if (dedicated) return Buffer.from(dedicated, 'utf8');
  const base = config.get<string>('JWT_ACCESS_SECRET');
  if (!base) {
    throw new Error('Unsubscribe links need UNSUBSCRIBE_SIGNING_SECRET or JWT_ACCESS_SECRET.');
  }
  return createHmac('sha256', base).update('eticketsgo:unsubscribe:v1').digest();
}

function validClaims(c: UnsubscribeClaims): boolean {
  if (!c.email || !c.email.includes('@')) return false;
  if (c.scope === 'global') {
    return c.purpose === ConsentPurpose.MARKETING_EMAIL && !c.organizationId;
  }
  if (c.scope === 'organizer') {
    return (
      !!c.organizationId && (c.purpose === ALL_ORGANIZER_PURPOSES || isOrganizerPurpose(c.purpose))
    );
  }
  return false;
}

export function signUnsubscribeToken(claims: UnsubscribeClaims, key: Buffer): string {
  const normalized = { ...claims, email: claims.email.trim().toLowerCase() };
  if (!validClaims(normalized)) throw new Error('Invalid unsubscribe claims.');
  const wire: Wire = {
    v: 1,
    ...(normalized.userId ? { u: normalized.userId } : {}),
    e: normalized.email,
    s: normalized.scope === 'global' ? 'g' : 'o',
    ...(normalized.organizationId ? { o: normalized.organizationId } : {}),
    p: normalized.purpose,
  };
  const body = b64url(JSON.stringify(wire));
  const sig = b64url(createHmac('sha256', key).update(body).digest());
  return `${body}.${sig}`;
}

/** The claims, or null for anything malformed, tampered with, or signed with another key. */
export function verifyUnsubscribeToken(
  token: string | null | undefined,
  key: Buffer,
): UnsubscribeClaims | null {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac('sha256', key).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let wire: Wire;
  try {
    wire = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Wire;
  } catch {
    return null;
  }
  if (!wire || wire.v !== 1 || typeof wire.e !== 'string' || typeof wire.p !== 'string') {
    return null;
  }
  if (wire.s !== 'g' && wire.s !== 'o') return null;
  const claims: UnsubscribeClaims = {
    userId: typeof wire.u === 'string' ? wire.u : null,
    email: wire.e,
    scope: wire.s === 'g' ? 'global' : 'organizer',
    organizationId: typeof wire.o === 'string' ? wire.o : null,
    purpose: wire.p,
  };
  return validClaims(claims) ? claims : null;
}

export interface UnsubscribeLinks {
  /** The page in the email footer. It shows what will stop and asks for one click. */
  pageUrl: string;
  /** The RFC 8058 endpoint. POST to it unsubscribes with no page and no sign-in. */
  oneClickUrl: string;
  /** Header values for the campaign sender. Pass to the email transport's `listUnsubscribe`. */
  headers: { 'List-Unsubscribe': string; 'List-Unsubscribe-Post': string };
}

/**
 * Everything a future campaign sender needs for one recipient.
 *
 * The one-click URL is on the API because RFC 8058 POSTs to the URL in the header, and only
 * the API can take that POST. It needs PUBLIC_API_URL outside local development, and fails
 * loudly without it rather than putting a localhost link in somebody's inbox.
 */
export function buildUnsubscribeLinks(
  config: Pick<ConfigService, 'get'>,
  claims: UnsubscribeClaims,
): UnsubscribeLinks {
  const token = signUnsubscribeToken(claims, unsubscribeKey(config));
  const pageUrl = redirectUrl(config as ConfigService, {
    site: 'customer',
    path: `/unsubscribe/${token}`,
    purpose: 'unsubscribe page',
  });
  const prefix = (config.get<string>('API_GLOBAL_PREFIX') ?? 'api').replace(/^\/+|\/+$/g, '');
  const apiOrigin = config.get<string>('PUBLIC_API_URL')?.trim().replace(/\/+$/, '');
  const appEnv = config.get<string>('APP_ENV') ?? 'LOCAL';
  let origin = apiOrigin;
  if (!origin) {
    if (!['LOCAL', 'DEV'].includes(appEnv)) {
      throw new AppException(
        ErrorCodes.INTERNAL,
        'Cannot build the one-click unsubscribe URL: PUBLIC_API_URL is not set.',
        HttpStatus.INTERNAL_SERVER_ERROR,
        { appEnv },
      );
    }
    origin = 'http://localhost:4000';
  }
  const oneClickUrl = `${origin}/${prefix ? `${prefix}/` : ''}public/unsubscribe/${token}`;
  return {
    pageUrl,
    oneClickUrl,
    headers: {
      'List-Unsubscribe': `<${oneClickUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
