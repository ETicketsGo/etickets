import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/*
  TOTP, RFC 6238 (HMAC-SHA-1, 6 digits, 30 second step), over HOTP, RFC 4226.

  Written against node:crypto instead of a dependency: it is forty lines, the RFC publishes test
  vectors that pin it exactly, and a security-critical path is better with nothing in it that
  we did not read.
*/
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** One step either side of "now": clock drift on a phone, not a longer guessing window. */
export const TOTP_WINDOW = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Not base32.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 random bits, the size RFC 4226 recommends for SHA-1. */
export function generateSecret(): Buffer {
  return randomBytes(20);
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function stepFor(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totp(secret: Buffer, nowMs: number): string {
  return hotp(secret, stepFor(nowMs));
}

/**
 * The step a code matches inside the window, or null.
 *
 * Every candidate step is compared (no early exit) and each comparison is constant time, so how
 * long this takes does not say which digit was wrong. The caller decides whether the step is
 * NEW: a code that is correct but not newer than the last accepted step is a replay.
 */
export function matchStep(secret: Buffer, code: string, nowMs: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepFor(nowMs);
  const given = Buffer.from(code);
  let hit: number | null = null;
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s++) {
    const want = Buffer.from(hotp(secret, s));
    if (timingSafeEqual(want, given) && (hit === null || s > hit)) hit = s;
  }
  return hit;
}

/** otpauth URI the authenticator app scans. Built here and rendered here; it never leaves our origin. */
export function otpauthUri(secret: Buffer, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}
