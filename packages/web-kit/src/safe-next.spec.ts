import { describe, it, expect } from 'vitest';
import { safeNextPath } from './safe-next';

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
});
