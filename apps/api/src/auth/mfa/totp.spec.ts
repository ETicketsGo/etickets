import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, parseMfaKey } from './mfa-crypto';
import { base32Decode, base32Encode, hotp, matchStep, otpauthUri, stepFor, totp } from './totp';

/*
  RFC 6238 appendix B, SHA-1, secret "12345678901234567890". The RFC prints eight digits; the
  six-digit code is the last six of those, which is what an authenticator app shows.
*/
const RFC_SECRET = Buffer.from('12345678901234567890');
const VECTORS: Array<[number, string]> = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(VECTORS)('matches the published vector at T=%i', (t, code) => {
    expect(totp(RFC_SECRET, t * 1000)).toBe(code);
  });

  it('HOTP matches RFC 4226 appendix D', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314'];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it('accepts the current step and one either side, and nothing further', () => {
    const now = 1_700_000_000_000;
    const step = stepFor(now);
    expect(matchStep(RFC_SECRET, hotp(RFC_SECRET, step), now)).toBe(step);
    expect(matchStep(RFC_SECRET, hotp(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(matchStep(RFC_SECRET, hotp(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(matchStep(RFC_SECRET, hotp(RFC_SECRET, step - 2), now)).toBeNull();
    expect(matchStep(RFC_SECRET, hotp(RFC_SECRET, step + 2), now)).toBeNull();
  });

  it('rejects anything that is not exactly six digits', () => {
    const now = 1_700_000_000_000;
    const good = hotp(RFC_SECRET, stepFor(now));
    for (const bad of ['', '12345', `${good}0`, ' 123456', 'abcdef', `${good} `]) {
      expect(matchStep(RFC_SECRET, bad, now)).toBeNull();
    }
  });

  it('round-trips base32 and builds an otpauth URI that carries the parameters', () => {
    const secret = randomBytes(20);
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    const uri = otpauthUri(secret, 'a@b.test', 'ETicketsGo QA');
    expect(uri).toMatch(/^otpauth:\/\/totp\/ETicketsGo%20QA:a%40b\.test\?/);
    expect(uri).toContain(`secret=${base32Encode(secret)}`);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('secret encryption at rest', () => {
  const key = randomBytes(32);

  it('round-trips, and the ciphertext does not contain the secret', () => {
    const secret = randomBytes(20);
    const stored = encryptSecret(key, secret, 'user-1');
    expect(stored.startsWith('v1.')).toBe(true);
    expect(stored).not.toContain(base32Encode(secret));
    expect(decryptSecret(key, stored, 'user-1').equals(secret)).toBe(true);
  });

  it('refuses a ciphertext moved to another account, a wrong key, or a tampered value', () => {
    const stored = encryptSecret(key, randomBytes(20), 'user-1');
    expect(() => decryptSecret(key, stored, 'user-2')).toThrow();
    expect(() => decryptSecret(randomBytes(32), stored, 'user-1')).toThrow();
    const parts = stored.split('.');
    parts[3] = Buffer.from('tampered-bytes-here!!').toString('base64url');
    expect(() => decryptSecret(key, parts.join('.'), 'user-1')).toThrow();
  });

  it('validates the key: absent is fine, wrong length is not', () => {
    expect(parseMfaKey(undefined)).toBeNull();
    expect(parseMfaKey('  ')).toBeNull();
    expect(parseMfaKey(randomBytes(32).toString('base64'))?.length).toBe(32);
    expect(() => parseMfaKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
