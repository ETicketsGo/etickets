import { describe, expect, it, vi } from 'vitest';

// The hook in the same module reaches the API client; the pure function under test does not.
vi.mock('@/lib/api', () => ({ api: {} }));

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
  it('hides phone when no country at all can be sent a code', () => {
    // QA today: SMS on, provider in log mode - every request-code is a 503.
    expect(signInModes(true, false, [])).toEqual({ modes: ['email'], initial: 'email' });
  });
  it('keeps phone first when some countries can be reached', () => {
    // The countries that cannot are explained inside the Mobile tab, per country.
    expect(signInModes(true, false, ['US'])).toEqual({
      modes: ['phone', 'email'],
      initial: 'phone',
    });
  });
  it('changes nothing when the API is older than the country list', () => {
    expect(signInModes(true, false, undefined).initial).toBe('phone');
  });
});
