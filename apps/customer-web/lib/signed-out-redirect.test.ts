import { describe, expect, it } from 'vitest';
import { signedOutRedirect } from './signed-out-redirect';

/*
  Refresh flicker (2026-11): a signed-out visitor on /account saw the account page for half a
  second before a client effect sent them to sign in. The middleware now answers first.
*/
describe('signedOutRedirect', () => {
  const locales = ['fr-CA'];

  it('sends a visitor with no session hint straight to sign in, with the same next', () => {
    expect(signedOutRedirect('/account', false, locales)).toBe('/login?next=%2Faccount');
    expect(signedOutRedirect('/account/', false, locales)).toBe('/login?next=%2Faccount');
    expect(signedOutRedirect('/account/become-organizer', false, locales)).toBe(
      '/login?next=%2Faccount%2Fbecome-organizer',
    );
    expect(signedOutRedirect('/account/organizer-console', false, locales)).toBe(
      '/login?next=%2Faccount%2Forganizer-console',
    );
  });

  it('keeps a locale prefix', () => {
    expect(signedOutRedirect('/fr-CA/account', false, locales)).toBe(
      '/fr-CA/login?next=%2Faccount',
    );
  });

  it('serves the page when the hint says signed in', () => {
    expect(signedOutRedirect('/account', true, locales)).toBeNull();
  });

  it('leaves every other page alone, including account pages that prompt in place', () => {
    for (const p of [
      '/',
      '/login',
      '/account/tickets',
      '/account/receipts',
      '/events/x',
      '/accounts',
    ])
      expect(signedOutRedirect(p, false, locales)).toBeNull();
  });
});
