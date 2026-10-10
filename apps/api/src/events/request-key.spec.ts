import { isUniqueViolation, requestKey } from './request-key';

describe('requestKey', () => {
  it('is absent when no key was sent, so the request behaves as it always did', () => {
    expect(requestKey(undefined)).toBeUndefined();
    expect(requestKey('')).toBeUndefined();
  });

  it('accepts a browser random UUID and takes the first of repeated headers', () => {
    const uuid = '0b6b2f9e-6f1c-4a51-9a3e-0f2b1c3d4e5f';
    expect(requestKey(uuid)).toBe(uuid);
    expect(requestKey([uuid, 'other-key-123'])).toBe(uuid);
  });

  it('refuses a key that is too short, too long or not URL-safe', () => {
    for (const bad of ['short', 'x'.repeat(129), 'has spaces in it', 'semi;colon-key']) {
      expect(() => requestKey(bad)).toThrow(/Idempotency-Key/);
    }
  });
});

describe('isUniqueViolation', () => {
  it('is true only for the unique-constraint error code', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
    expect(isUniqueViolation({ code: 'P2025' })).toBe(false);
    expect(isUniqueViolation(new Error('P2002'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
