import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { phoneSignInOutcome } from '@eticketsgo/shared-types';

/**
 * Creating an account with a mobile number, on the website.
 *
 * ── THE REPORT ─────────────────────────────────────────────────────────────────────
 * "I can repeatedly sign up using the same mobile number without receiving an 'account already
 * exists' message." The API has always answered `isNewAccount: false` for a number that already
 * has an account and signed the person into THAT account. This form threw the answer away and
 * went on as if an account had just been made.
 *
 * The decision is a pure function in shared-types (one rule for the website and the app); the
 * component is checked for USING it, and the sentence is checked in both catalogues.
 */
const source = readFileSync(resolve(__dirname, 'phone-sign-in.tsx'), 'utf8');
const catalogue = (locale: string) =>
  JSON.parse(
    readFileSync(
      resolve(__dirname, `../../../packages/i18n/src/messages/${locale}/storefront.json`),
      'utf8',
    ),
  ) as { auth: Record<string, string> };

describe('what a verified code means, by form', () => {
  it('sign-up with a number that already has an account is reported as existing', () => {
    expect(phoneSignInOutcome('sign-up', false)).toBe('existing');
  });
  it('sign-up with a new number created the account', () => {
    expect(phoneSignInOutcome('sign-up', true)).toBe('created');
  });
  it('sign-in is a sign-in either way', () => {
    expect(phoneSignInOutcome('sign-in', false)).toBe('signed-in');
    expect(phoneSignInOutcome('sign-in', true)).toBe('signed-in');
  });
  it('an API that does not say is treated as existing on sign-up, never as created', () => {
    expect(phoneSignInOutcome('sign-up', undefined)).toBe('existing');
  });
});

describe('the Mobile tab reads the answer', () => {
  it('decides from the response, not from which tab was pressed', () => {
    expect(source).toMatch(
      /phoneSignInOutcome\(\s*signUp \? 'sign-up' : 'sign-in',\s*\w+\.isNewAccount/,
    );
  });
  it('says so in words when the account already existed', () => {
    expect(source).toMatch(/a\('existingAccountSignedIn'\)/);
  });
  it('carries the sentence in English and in French', () => {
    expect(catalogue('en').auth.existingAccountSignedIn).toBe(
      'You already have an account with this number. We signed you in.',
    );
    expect(catalogue('fr-CA').auth.existingAccountSignedIn).toMatch(/\S/);
    expect(catalogue('en').auth.continueSignedIn).toMatch(/\S/);
    expect(catalogue('fr-CA').auth.continueSignedIn).toMatch(/\S/);
  });
});
