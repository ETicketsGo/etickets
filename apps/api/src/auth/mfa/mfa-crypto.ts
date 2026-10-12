import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/*
  AES-256-GCM for the TOTP secret at rest. Stored as `v1.<iv>.<tag>.<ciphertext>` (base64url).
  The version prefix is what lets the key or the scheme be rotated later without guessing.
  The user id is bound in as additional authenticated data, so a ciphertext copied from one
  account's row to another's does not decrypt.
*/
export function parseMfaKey(raw: string | undefined): Buffer | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32) {
    throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes, base64 encoded.');
  }
  return key;
}

export function encryptSecret(key: Buffer, plain: Buffer, userId: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(userId));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decryptSecret(key: Buffer, stored: string, userId: string): Buffer {
  const [v, iv, tag, ct] = stored.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unreadable MFA secret.');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(userId));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
}
