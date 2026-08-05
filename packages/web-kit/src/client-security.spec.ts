import { describe, it, expect } from 'vitest';
import { redactSecretKeys, isLocalApiUrl } from '@eticketsgo/shared-types';

describe('redactSecretKeys', () => {
  it('filters auth headers, tokens, passwords, OTPs recursively', () => {
    const out = redactSecretKeys({
      request: { headers: { authorization: 'Bearer abc', 'content-type': 'application/json' } },
      body: { email: 'a@b.com', password: 'secret', otp: '123456' },
      nested: [{ refreshToken: 'xyz' }],
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain('Bearer abc');
    expect(json).not.toContain('secret');
    expect(json).not.toContain('123456');
    expect(json).not.toContain('xyz');
    expect(out.body.email).toBe('a@b.com'); // non-secret value kept
    expect(out.request.headers.authorization).toBe('[Filtered]');
  });
  it('passes primitives through', () => {
    expect(redactSecretKeys('hello')).toBe('hello');
    expect(redactSecretKeys(42)).toBe(42);
  });
});

describe('isLocalApiUrl', () => {
  it('flags loopback/local hosts', () => {
    expect(isLocalApiUrl('http://localhost:4000/api')).toBe(true);
    expect(isLocalApiUrl('http://127.0.0.1:4000/api')).toBe(true);
    expect(isLocalApiUrl('http://10.0.2.2:4000/api')).toBe(true); // android emulator loopback
  });
  it('allows real hosts', () => {
    expect(isLocalApiUrl('https://api.eticketsgo.com/api')).toBe(false);
  });
});
