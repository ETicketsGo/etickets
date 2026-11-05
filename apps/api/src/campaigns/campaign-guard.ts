import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';

/**
 * The review step's confirmation token.
 *
 * Sending is the one action that cannot be taken back. So "send now" and "schedule" do not
 * take a bare request: they take a token the REVIEW step handed out, bound to the campaign and
 * to the exact version that was reviewed, valid for fifteen minutes. Any edit after the review
 * changes the version, and the old token no longer fits: what was reviewed is what goes.
 */

export const CONFIRMATION_TTL_MS = 15 * 60_000;

function key(config: Pick<ConfigService, 'get'>): Buffer {
  const base = config.get<string>('JWT_ACCESS_SECRET');
  if (!base) throw new Error('Campaign confirmation needs JWT_ACCESS_SECRET.');
  return createHmac('sha256', base).update('eticketsgo:campaign-confirm:v1').digest();
}

export function signConfirmation(
  config: Pick<ConfigService, 'get'>,
  campaignId: string,
  version: number,
  now = Date.now(),
): string {
  const expires = now + CONFIRMATION_TTL_MS;
  const sig = createHmac('sha256', key(config))
    .update(`${campaignId}.${version}.${expires}`)
    .digest('base64url');
  return `${expires}.${sig}`;
}

export function verifyConfirmation(
  config: Pick<ConfigService, 'get'>,
  campaignId: string,
  version: number,
  token: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!token || token.length > 200) return false;
  const [expiresRaw, sig] = token.split('.');
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires < now || !sig) return false;
  const expected = createHmac('sha256', key(config))
    .update(`${campaignId}.${version}.${expires}`)
    .digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
