import { describe, it, expect } from 'vitest';
import { nextFromSearch, safeNextPath } from './safe-next';

/*
  Reported by the architecture review: `/login?next=https://evil.example` sent a person who had
  just signed in to another site. Only a path on this site may be the destination.
*/
describe('safeNextPath', () => {
  const FALLBACK = '/account/tickets';

  it('keeps a path on this site, with its query', () => {
    expect(safeNextPath('/shows/abc?seats=A1', FALLBACK)).toBe('/shows/abc?seats=A1');
    expect(safeNextPath('/fr-CA/events/concert', FALLBACK)).toBe('/fr-CA/events/concert');
  });

  it.each([
    ['an absolute URL', 'https://evil.example/relogin'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash variant browsers treat as protocol-relative', '/\\evil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a bare host', 'evil.example'],
    ['a path hiding a tab that browsers strip', '/\t/evil.example'],
  ])('refuses %s', (_name, next) => {
    expect(safeNextPath(next, FALLBACK)).toBe(FALLBACK);
  });

  it('falls back when there is no destination', () => {
    expect(safeNextPath(null, FALLBACK)).toBe(FALLBACK);
    expect(safeNextPath('', FALLBACK)).toBe(FALLBACK);
  });

  it('refuses a page named as unusable after sign-in, in any locale, with any query', () => {
    const unusable = ['/login', '/register'];
    expect(safeNextPath('/login', FALLBACK, unusable)).toBe(FALLBACK);
    expect(safeNextPath('/login?next=/x', FALLBACK, unusable)).toBe(FALLBACK);
    expect(safeNextPath('/fr-CA/login', FALLBACK, unusable)).toBe(FALLBACK);
    expect(safeNextPath('/register/', FALLBACK, unusable)).toBe(FALLBACK);
    // Only that page: a path that merely starts with the same letters is somewhere else.
    expect(safeNextPath('/login-help', FALLBACK, unusable)).toBe('/login-help');
    expect(safeNextPath('/events/login', FALLBACK, unusable)).toBe('/events/login');
  });
});

/*
  The admin and organizer consoles' sign-in pushed `?next=` unchecked: on QA, signing in to the
  admin console (password AND authenticator code) from `/login?next=https://example.com/` ended
  on example.com. The consoles now read their destination through this.
*/
describe('nextFromSearch', () => {
  const HOME = '/admin';
  const CONSOLE = ['/login'];

  it('returns to the console page the person was sent from', () => {
    expect(nextFromSearch('?next=%2Fadmin%2Frefunds', HOME, CONSOLE)).toBe('/admin/refunds');
  });

  it.each([
    ['no destination', ''],
    ['an absolute URL', '?next=https%3A%2F%2Fexample.com%2F'],
    ['a protocol-relative URL', '?next=%2F%2Fexample.com'],
    ['the sign-in page itself', '?next=%2Flogin'],
  ])('lands on the console home for %s', (_name, search) => {
    expect(nextFromSearch(search, HOME, CONSOLE)).toBe(HOME);
  });
});
