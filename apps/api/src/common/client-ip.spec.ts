import type { Request } from 'express';
import { clientIpFor, resolveClientIpHeader, resolveInternalKey } from './client-ip';

/**
 * unit - whose address a rate limit counts.
 *
 * On QA the throttler counted Railway's edge proxy nodes instead of visitors (see client-ip.ts).
 * These pin the rule that replaced it: Railway's `X-Real-IP` on Railway, `req.ip` everywhere
 * else, and never a value the client chose.
 */

function req(headers: Record<string, string | string[]>, ip?: string): Request {
  return { headers, ip, socket: { remoteAddress: '10.0.0.9' } } as unknown as Request;
}

describe('which header is trusted', () => {
  it('is x-real-ip on Railway, when nothing is configured', () => {
    expect(resolveClientIpHeader({ RAILWAY_ENVIRONMENT_ID: 'env-123' })).toBe('x-real-ip');
  });

  it('is none off Railway, where nothing overwrites the header and a client could choose it', () => {
    expect(resolveClientIpHeader({})).toBeNull();
    expect(resolveClientIpHeader({ RAILWAY_ENVIRONMENT_ID: '  ' })).toBeNull();
  });

  it('can be turned off on Railway with "none"', () => {
    expect(
      resolveClientIpHeader({
        RAILWAY_ENVIRONMENT_ID: 'env-123',
        THROTTLE_CLIENT_IP_HEADER: 'none',
      }),
    ).toBeNull();
  });

  it('can name another header deliberately, lower-cased as Node delivers headers', () => {
    expect(resolveClientIpHeader({ THROTTLE_CLIENT_IP_HEADER: 'CF-Connecting-IP' })).toBe(
      'cf-connecting-ip',
    );
  });

  it('ignores a value that is not a header name, and keeps the environment default', () => {
    expect(resolveClientIpHeader({ THROTTLE_CLIENT_IP_HEADER: 'x real ip!' })).toBeNull();
  });
});

describe('the address counted', () => {
  it('is the trusted header, not the edge node in req.ip', () => {
    expect(clientIpFor(req({ 'x-real-ip': '24.117.1.2' }, '100.64.0.7'), 'x-real-ip')).toBe(
      '24.117.1.2',
    );
  });

  it('is never read from X-Forwarded-For, whatever the client puts there', () => {
    const r = req({ 'x-real-ip': '24.117.1.2', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, '9.9.9.9');
    expect(clientIpFor(r, 'x-real-ip')).toBe('24.117.1.2');
  });

  it('falls back to req.ip when the header is missing, a list, repeated or not an address', () => {
    for (const value of [undefined, '1.2.3.4, 5.6.7.8', ['1.2.3.4', '5.6.7.8'], 'not-an-ip', '']) {
      const headers: Record<string, string | string[]> =
        value === undefined ? {} : { 'x-real-ip': value };
      expect(clientIpFor(req(headers, '203.0.113.5'), 'x-real-ip')).toBe('203.0.113.5');
    }
  });

  it('is req.ip when no header is trusted, even if the client sends one', () => {
    expect(clientIpFor(req({ 'x-real-ip': '6.6.6.6' }, '203.0.113.5'), null)).toBe('203.0.113.5');
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 address it is', () => {
    expect(clientIpFor(req({}, '::ffff:203.0.113.5'), null)).toBe('203.0.113.5');
    expect(clientIpFor(req({ 'x-real-ip': '::FFFF:203.0.113.5' }), 'x-real-ip')).toBe(
      '203.0.113.5',
    );
  });

  it('accepts IPv6', () => {
    expect(clientIpFor(req({ 'x-real-ip': '2001:DB8::1' }), 'x-real-ip')).toBe('2001:db8::1');
  });

  it('uses the socket when Express has no req.ip', () => {
    expect(clientIpFor(req({}), null)).toBe('10.0.0.9');
  });
});

describe("the storefront server's visitor (private network + shared secret)", () => {
  const KEY = 'x'.repeat(40);
  const internalReq = (extra: Record<string, string> = {}) =>
    req({ 'x-etg-internal-key': KEY, 'x-etg-client-ip': '49.36.8.9', ...extra }, 'fd12::5');

  it('is the forwarded visitor when the secret matches and no edge header is present', () => {
    expect(clientIpFor(internalReq(), 'x-real-ip', KEY)).toBe('49.36.8.9');
  });

  it('is ignored when the request came through the public edge, secret or not', () => {
    expect(clientIpFor(internalReq({ 'x-real-ip': '203.0.113.5' }), 'x-real-ip', KEY)).toBe(
      '203.0.113.5',
    );
  });

  it('is ignored with a wrong secret, or when no secret is configured', () => {
    const wrong = req(
      { 'x-etg-internal-key': 'y'.repeat(40), 'x-etg-client-ip': '49.36.8.9' },
      'fd12::5',
    );
    expect(clientIpFor(wrong, 'x-real-ip', KEY)).toBe('fd12::5');
    expect(clientIpFor(internalReq(), 'x-real-ip', null)).toBe('fd12::5');
    expect(clientIpFor(internalReq(), 'x-real-ip')).toBe('fd12::5');
  });

  it('never takes a list or a non-address as the visitor', () => {
    for (const v of ['1.1.1.1, 2.2.2.2', 'nope', '']) {
      expect(clientIpFor(internalReq({ 'x-etg-client-ip': v }), 'x-real-ip', KEY)).toBe('fd12::5');
    }
  });

  it('needs a key of at least 32 characters', () => {
    expect(resolveInternalKey({ INTERNAL_API_KEY: 'a'.repeat(31) })).toBeNull();
    expect(resolveInternalKey({ INTERNAL_API_KEY: ` ${'a'.repeat(32)} ` })).toBe('a'.repeat(32));
    expect(resolveInternalKey({})).toBeNull();
  });
});
