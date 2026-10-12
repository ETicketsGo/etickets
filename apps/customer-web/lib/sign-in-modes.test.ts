import { describe, expect, it } from 'vitest';
import { signInModes } from './sign-in-modes';

describe('signInModes', () => {
  it('offers phone first when phone sign-in is available', () => {
    expect(signInModes(true, false)).toEqual({ modes: ['phone', 'email'], initial: 'phone' });
  });
  it('treats an unknown capability as available', () => {
    expect(signInModes(undefined, false).modes).toEqual(['phone', 'email']);
  });
  it('opens on email when an address was prefilled', () => {
    expect(signInModes(true, true).initial).toBe('email');
  });
  it('hides phone and opens on email when SMS is off', () => {
    expect(signInModes(false, false)).toEqual({ modes: ['email'], initial: 'email' });
  });
});
