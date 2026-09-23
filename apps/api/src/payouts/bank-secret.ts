import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * A bank account number at rest.
 *
 * ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────────────
 * Until a provider moves organizer money for us, somebody makes these transfers by hand,
 * which means the platform has to hold the account number. A number in a plain column is
 * readable by every future query, every backup, every support screen somebody adds in a
 * hurry, and everybody with a psql prompt. Encrypted, it is readable only by code holding the
 * key, and reading it is an event that can be recorded.
 *
 * ── AES-256-GCM, AND WHY NOT SOMETHING SIMPLER ─────────────────────────────────────
 * GCM authenticates as well as encrypts, so a ciphertext altered in the database fails to
 * decrypt instead of returning a different account number. A fresh 12-byte IV per write means
 * two organizers with the same account number do not produce the same ciphertext, which would
 * otherwise leak that they are the same account.
 *
 * ── FAIL CLOSED ────────────────────────────────────────────────────────────────────
 * With no key configured, this refuses to encrypt rather than storing anything weaker. A
 * deployment that has not set the key simply cannot hold bank details, which is the correct
 * outcome: the alternative is silently writing them in the clear.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export class BankSecretKeyMissing extends Error {
  constructor() {
    super(
      'PAYOUT_BANK_ENCRYPTION_KEY is not set, so bank details cannot be stored. Set a 32-byte base64 key.',
    );
    this.name = 'BankSecretKeyMissing';
  }
}

/** The configured key as 32 raw bytes, or null when the deployment has none. */
export function bankKey(raw: string | undefined | null): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error('PAYOUT_BANK_ENCRYPTION_KEY must be 32 bytes, base64 encoded.');
  }
  return key;
}

/** `iv:tag:ciphertext`, all base64. One field, so a row cannot carry half of a secret. */
export function encryptAccountNumber(accountNumber: string, key: Buffer | null): string {
  if (!key) throw new BankSecretKeyMissing();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(accountNumber, 'utf8'), cipher.final()]);
  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * The number back, for the one screen that shows it.
 *
 * Throws on anything that is not exactly what we wrote: a truncated field, a tampered
 * ciphertext, or a value encrypted under a key this deployment no longer has. Every one of
 * those is a reason to stop rather than to guess.
 */
export function decryptAccountNumber(stored: string, key: Buffer | null): string {
  if (!key) throw new BankSecretKeyMissing();
  const [iv, tag, ciphertext] = stored.split(':');
  if (!iv || !tag || !ciphertext) throw new Error('Stored bank details are not readable.');
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** The last four digits, which is what a person matches against a statement. */
export function last4(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, '');
  return digits.slice(-4).padStart(4, '*');
}
