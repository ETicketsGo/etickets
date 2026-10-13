// Run with: node --test scripts/showcase/totp.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { totp } from './totp.mjs';

describe('totp', () => {
  // RFC 6238 appendix B, SHA-1: ASCII secret "12345678901234567890" at T=59 s is 94287082
  // (8 digits), so 287082 with 6.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it('matches the RFC 6238 SHA-1 vectors', () => {
    assert.equal(totp(secret, 59), '287082');
    assert.equal(totp(secret, 1111111109), '081804');
    assert.equal(totp(secret, 1111111111), '050471');
    assert.equal(totp(secret, 1234567890), '005924');
    assert.equal(totp(secret, 2000000000), '279037');
  });
  it('changes only at the 30 s boundary', () => {
    assert.equal(totp(secret, 30), totp(secret, 59));
    assert.notEqual(totp(secret, 59), totp(secret, 60));
  });
  it('rejects a secret that is not base32', () => {
    assert.throws(() => totp('not base32!1', 0));
  });
});
