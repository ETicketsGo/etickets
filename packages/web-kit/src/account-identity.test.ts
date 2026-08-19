import { describe, expect, it } from 'vitest';
import { initialsOf } from './components';

/**
 * The avatar in the corner of every signed-in page.
 *
 * It exists because the header used to show nothing but "Sign out" — a signed-in customer
 * could not tell which account they were on, which matters most on a shared device and in
 * the moment before paying. So the one thing it must never do is render nonsense there.
 */
describe('initials for the account avatar', () => {
  it('takes the first and LAST name, not the first two words', () => {
    // "Ravi Kumar Iyer" is RI, not RK — the family name is the identifying half.
    expect(initialsOf('Ravi Kumar Iyer', 'r@x.test')).toBe('RI');
    expect(initialsOf('Asha Menon', 'a@x.test')).toBe('AM');
  });

  it('uses two letters of a single name', () => {
    expect(initialsOf('Prakash', 'p@x.test')).toBe('PR');
  });

  it('falls back to the email when there is no name', () => {
    // An account can exist without a display name; the corner still has to say something.
    expect(initialsOf(undefined, 'asha.menon@example.test')).toBe('AM');
    expect(initialsOf('   ', 'prakash@example.test')).toBe('PR');
  });

  it('handles separators inside an email local-part', () => {
    expect(initialsOf(undefined, 'ravi_kumar@example.test')).toBe('RK');
    expect(initialsOf(undefined, 'ravi-kumar@example.test')).toBe('RK');
  });

  it('never renders undefined or empty into the header', () => {
    // The case that would otherwise put "UNDEFINED" in the corner of a live page.
    expect(initialsOf(undefined, undefined)).toBe('?');
    expect(initialsOf('', '')).toBe('?');
    expect(initialsOf('', '@example.test')).toBe('?');
  });

  it('is always upper case and at most two characters', () => {
    for (const [name, email] of [
      ['ravi kumar', 'x@y.test'],
      [undefined, 'a.very.long.address@y.test'],
      ['x', 'x@y.test'],
    ] as [string | undefined, string][]) {
      const out = initialsOf(name, email);
      expect(out).toBe(out.toUpperCase());
      expect(out.length).toBeLessThanOrEqual(2);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
