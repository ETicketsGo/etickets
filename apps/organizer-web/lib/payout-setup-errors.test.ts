import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@eticketsgo/web-kit';
import {
  PAYOUT_SETUP_MESSAGES,
  incompleteDetailsMessage,
  payoutSetupErrorMessage,
} from './payout-setup-errors';

/*
  "Set up payouts" showed "Something went wrong." (a 500), and later Stripe's own sentence about
  our platform account. Each failure class the API now names gets its own plain sentence.
*/

const err = (code: string, status: number, message = 'x', details?: Record<string, unknown>) =>
  new ApiRequestError(code, message, details, 'abcdef12-3456-7890', status);

const ACCOUNTS_V1 =
  'Stripe could not create the connected account: Stripe no longer recommends Accounts v1 for new Connect integrations. enable Accounts v1 support in the Dashboard';

describe('payoutSetupErrorMessage', () => {
  it('country not supported yet', () => {
    expect(payoutSetupErrorMessage(err('PAYOUT_COUNTRY_UNSUPPORTED', 422))).toBe(
      PAYOUT_SETUP_MESSAGES.COUNTRY_UNSUPPORTED,
    );
  });

  it('linked account not found: check the id (was a 500 "Something went wrong.")', () => {
    expect(
      payoutSetupErrorMessage(
        err('PAYOUT_ACCOUNT_NOT_FOUND', 422, 'The id provided does not exist'),
      ),
    ).toBe(
      'We could not find that Razorpay linked account. Check the account ID (acc_...) and try again.',
    );
  });

  it('provider not set up on this site, with a support reference', () => {
    const m = payoutSetupErrorMessage(err('PAYMENT_PROVIDER_NOT_CONFIGURED', 503));
    expect(m).toContain(PAYOUT_SETUP_MESSAGES.NOT_CONFIGURED);
    expect(m).toContain('Reference: abcdef12.');
  });

  it('owner role needed', () => {
    expect(payoutSetupErrorMessage(err('TENANT_FORBIDDEN', 403))).toBe(
      PAYOUT_SETUP_MESSAGES.OWNER_ONLY,
    );
    expect(payoutSetupErrorMessage(err('SOMETHING_ELSE', 403))).toBe(
      PAYOUT_SETUP_MESSAGES.OWNER_ONLY,
    );
  });

  it('organization details incomplete, naming the field in words', () => {
    expect(
      payoutSetupErrorMessage(
        err('ORGANIZATION_DETAILS_INCOMPLETE', 422, 'x', { fields: ['registeredCountry'] }),
      ),
    ).toBe(
      'Your organization details are incomplete: country of registration. Add this in Settings, then try again.',
    );
    expect(incompleteDetailsMessage(['contactEmail', 'somethingNew'])).toContain(
      'contact email, a required detail',
    );
  });

  it('provider temporarily unavailable: try again', () => {
    const m = payoutSetupErrorMessage(err('PAYMENT_PROVIDER_UNAVAILABLE', 503));
    expect(m).toContain(PAYOUT_SETUP_MESSAGES.UNAVAILABLE);
  });

  it('never shows a provider sentence or a bare server message', () => {
    // What QA returned before the fix (502 with Stripe's text).
    const m = payoutSetupErrorMessage(err('PAYMENT_PROVIDER_UNAVAILABLE', 502, ACCOUNTS_V1));
    expect(m).not.toMatch(/Stripe|Accounts v1|Dashboard/);
    // An unexpected 500.
    const generic = payoutSetupErrorMessage(err('INTERNAL', 500, 'Something went wrong.'));
    expect(generic).not.toBe('Something went wrong.');
    expect(generic).toContain(PAYOUT_SETUP_MESSAGES.FALLBACK);
  });

  it('network failure', () => {
    expect(payoutSetupErrorMessage(new TypeError('Failed to fetch'))).toBe(
      PAYOUT_SETUP_MESSAGES.NETWORK,
    );
  });

  it('every sentence is plain ASCII', () => {
    for (const m of Object.values(PAYOUT_SETUP_MESSAGES)) expect(m).toMatch(/^[\x20-\x7E]+$/);
  });
});
