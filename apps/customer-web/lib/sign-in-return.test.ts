import { describe, expect, it } from 'vitest';
import { adminConsoleOrigin, afterSignIn, signInHref } from './sign-in-return';

/*
  Owner, 2026-10-16: "when user sign in it is taking to tickets". On QA, signing in from the home
  page and from an event page both ended on My tickets, because the header's Sign in carried no
  return address and the fallback was /account/tickets.
*/
describe('afterSignIn', () => {
  it('returns to the page the person came from', () => {
    expect(afterSignIn('/events/neon-raga')).toBe('/events/neon-raga');
    expect(afterSignIn('/shows/abc?seats=A1')).toBe('/shows/abc?seats=A1');
    expect(afterSignIn('/account/tickets')).toBe('/account/tickets');
  });

  it('lands on the home page, not My tickets, when there is nowhere to return to', () => {
    expect(afterSignIn(null)).toBe('/');
    expect(afterSignIn('')).toBe('/');
  });

  it.each([
    ['an absolute URL', 'https://example.com/'],
    ['a protocol-relative URL', '//example.com'],
    ['a backslash variant', '/\\example.com'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['the sign-in page', '/login'],
    ['the French sign-in page', '/fr-CA/login?next=/x'],
    ['the sign-up page', '/register'],
    ['the password reset page', '/reset-password?token=abc'],
  ])('lands on the home page for %s', (_name, next) => {
    expect(afterSignIn(next)).toBe('/');
  });
});

describe('signInHref', () => {
  it('carries the page being looked at', () => {
    expect(signInHref('/events/neon-raga')).toBe('/login?next=%2Fevents%2Fneon-raga');
    expect(signInHref('/shows/abc?seats=A1')).toBe('/login?next=%2Fshows%2Fabc%3Fseats%3DA1');
  });

  it('is plain on the home page and on the sign-in pages', () => {
    expect(signInHref('/')).toBe('/login');
    expect(signInHref('/login')).toBe('/login');
    expect(signInHref('/register?next=%2Fevents%2Fx')).toBe('/login');
    expect(signInHref(null)).toBe('/login');
  });
});

describe('adminConsoleOrigin', () => {
  const at = (hostname: string, protocol = 'https:') => ({ protocol, hostname });

  it('follows the deployment naming', () => {
    expect(adminConsoleOrigin(at('qa.eticketsgo.com'), '')).toBe('https://admin-qa.eticketsgo.com');
    expect(adminConsoleOrigin(at('uat.eticketsgo.com'), '')).toBe(
      'https://admin-uat.eticketsgo.com',
    );
    expect(adminConsoleOrigin(at('eticketsgo.com'), '')).toBe('https://admin.eticketsgo.com');
    expect(adminConsoleOrigin(at('www.eticketsgo.com'), '')).toBe('https://admin.eticketsgo.com');
    expect(adminConsoleOrigin(at('localhost', 'http:'), '')).toBe('http://localhost:3002');
  });

  it('prefers the configured address, and guesses nothing for an unknown host', () => {
    expect(adminConsoleOrigin(at('qa.eticketsgo.com'), 'https://ops.example/')).toBe(
      'https://ops.example',
    );
    expect(adminConsoleOrigin(at('preview-123.up.railway.app'), '')).toBeNull();
    expect(adminConsoleOrigin(undefined, '')).toBeNull();
  });
});
