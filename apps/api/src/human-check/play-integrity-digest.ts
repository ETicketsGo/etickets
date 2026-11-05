/**
 * Play reports the digest as unpadded base64url; Play Console shows it as colon-separated hex.
 * Both are accepted in configuration and compared as base64url.
 */
export function normaliseDigest(raw: string): string {
  const v = raw.trim();
  if (/^([0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(v)) {
    return Buffer.from(v.replace(/:/g, ''), 'hex').toString('base64url');
  }
  return v.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
