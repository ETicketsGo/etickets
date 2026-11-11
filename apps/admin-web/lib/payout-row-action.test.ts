import { describe, expect, it } from 'vitest';
import { payoutRowAction } from './payout-row-action';

const hold = { code: 'DESTINATION_IDENTITY_NOT_APPROVED', message: 'This payout is on hold: ...' };

describe('payoutRowAction', () => {
  it('offers Mark paid only on an open payout with nothing holding it', () => {
    expect(payoutRowAction({ status: 'PENDING', hold: null }, true)).toBe('PAYABLE');
    expect(payoutRowAction({ status: 'SCHEDULED', hold: undefined }, true)).toBe('PAYABLE');
  });

  it('never presents a held payout as ready', () => {
    expect(payoutRowAction({ status: 'PENDING', hold }, true)).toBe('HELD');
    expect(payoutRowAction({ status: 'SCHEDULED', hold }, true)).toBe('HELD');
  });

  it('says the duty is missing before anything else, held or not', () => {
    expect(payoutRowAction({ status: 'PENDING', hold: null }, false)).toBe('MISSING_DUTY');
    expect(payoutRowAction({ status: 'PENDING', hold }, false)).toBe('MISSING_DUTY');
  });

  it('closed payouts keep their own actions', () => {
    expect(payoutRowAction({ status: 'PAID', hold: null }, true)).toBe('PAID');
    expect(payoutRowAction({ status: 'FAILED', hold: null }, true)).toBe('FAILED');
    expect(payoutRowAction({ status: 'CANCELLED', hold: null }, true)).toBe('NONE');
  });
});
