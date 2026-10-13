/**
 * RFC 6238 time-based one-time codes (SHA-1, 6 digits, 30 s), for the QA admin's second factor.
 *
 * The API refuses a code it has already accepted in the same 30 s step, so `nextFreshCode`
 * waits for the next step instead of replaying one.
 */
import { createHmac } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input) {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('The TOTP secret is not valid base32.');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for `unixSeconds` (default: now). */
export function totp(
  secretBase32,
  unixSeconds = Date.now() / 1000,
  { digits = 6, step = 30 } = {},
) {
  const counter = Math.floor(unixSeconds / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

let lastStep = -1;
/** A code from a step not used before in this process, waiting for the next step if needed. */
export async function nextFreshCode(secretBase32) {
  for (;;) {
    const step = Math.floor(Date.now() / 30000);
    if (step !== lastStep) {
      lastStep = step;
      return totp(secretBase32);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
