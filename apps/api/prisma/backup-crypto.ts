/**
 * Client-side encryption for the OFF-PLATFORM backup copy.
 *
 * Server-side encryption (SSE-S3 / SSE-KMS / R2's at-rest encryption) protects the provider's
 * disks, not the data from anybody holding bucket credentials or a provider-side breach. A
 * database dump holds every customer's name, email and phone, so the copy that leaves Railway is
 * encrypted HERE, before upload, with a key that is not stored with the bucket.
 *
 * Format (one file, streamed both ways, never held in memory):
 *
 *   "ETGBAK01" (8 bytes) | key fingerprint (8 bytes) | IV (12 bytes) | ciphertext | GCM tag (16)
 *
 * AES-256-GCM, a fresh random IV per file, so the same key is safe for every nightly dump. The
 * tag authenticates the whole ciphertext: a truncated or altered file fails to decrypt instead of
 * restoring garbage. The fingerprint (first 8 bytes of SHA-256 of the key) lets a restore say
 * "wrong key" before it decrypts anything, and lets the owner rotate keys while older dumps
 * remain decryptable with the old key.
 *
 * The key is 32 random bytes, given base64 (or 64 hex chars) in BACKUP_OFFSITE_ENCRYPTION_KEY.
 * It MUST also be kept outside Railway (password manager): a Railway-only key is lost in exactly
 * the disaster the off-platform copy exists for.
 *
 * Imports nothing from '../src' (the runtime image has no src/).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const MAGIC = Buffer.from('ETGBAK01', 'ascii');
const FP_LEN = 8;
const IV_LEN = 12;
const TAG_LEN = 16;
export const HEADER_LEN = MAGIC.length + FP_LEN + IV_LEN;

/** Parse the configured key. Throws a secret-free message on anything that is not 32 bytes. */
export function parseBackupKey(raw: string | undefined): Buffer | null {
  const v = raw?.trim();
  if (!v) return null;
  const key = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (key.length !== 32) {
    throw new Error('BACKUP_OFFSITE_ENCRYPTION_KEY must be 32 bytes (base64 or 64 hex characters)');
  }
  return key;
}

export const keyFingerprint = (key: Buffer): Buffer =>
  createHash('sha256').update(key).digest().subarray(0, FP_LEN);

/** Encrypt `src` to `dest`. Resolves with the bytes written. */
export async function encryptFile(src: string, dest: string, key: Buffer): Promise<number> {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const out = createWriteStream(dest, { flags: 'wx', mode: 0o600 });
  let written = 0;
  out.write(Buffer.concat([MAGIC, keyFingerprint(key), iv]));
  written += HEADER_LEN;
  const counter = new Transform({
    transform(chunk: Buffer, _e, cb) {
      written += chunk.length;
      cb(null, chunk);
    },
    flush(cb) {
      const tag = cipher.getAuthTag();
      written += tag.length;
      this.push(tag);
      cb();
    },
  });
  await pipeline(createReadStream(src), cipher, counter, out);
  return written;
}

/** Decrypt a file written by {@link encryptFile}. Rejects on a wrong key or any tampering. */
export async function decryptFile(src: string, dest: string, key: Buffer): Promise<void> {
  const fd = openSync(src, 'r');
  let size: number;
  const header = Buffer.alloc(HEADER_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  try {
    size = fstatSync(fd).size;
    if (size < HEADER_LEN + TAG_LEN) throw new Error('not an encrypted backup: file too short');
    readSync(fd, header, 0, HEADER_LEN, 0);
    readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    closeSync(fd);
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not an encrypted ETicketsGo backup (bad header)');
  }
  const fp = header.subarray(MAGIC.length, MAGIC.length + FP_LEN);
  if (!fp.equals(keyFingerprint(key))) {
    throw new Error(
      `wrong key: this backup was encrypted with key ${fp.toString('hex')}, ` +
        `the key given is ${keyFingerprint(key).toString('hex')}`,
    );
  }
  const iv = header.subarray(MAGIC.length + FP_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  await pipeline(
    createReadStream(src, { start: HEADER_LEN, end: size - TAG_LEN - 1 }),
    decipher,
    createWriteStream(dest, { flags: 'wx', mode: 0o600 }),
  );
}
