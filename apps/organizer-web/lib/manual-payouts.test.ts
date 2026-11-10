import { describe, expect, it } from 'vitest';
import {
  bankOwnership,
  isManualRupeePayout,
  manualPayoutLine,
  settlementStatusWords,
} from './manual-payouts';

describe('bankOwnership', () => {
  const company = {
    legalName: 'DeepTrics Software Solutions Pvt Ltd',
    legalEntityType: 'Private limited company',
  };

  it('a person named on a company account is a mismatch', () => {
    expect(bankOwnership({ holderName: 'Srinivasa Rao M', ...company })).toBe('MISMATCH');
  });

  it('the company name, spelt out or abbreviated, matches', () => {
    expect(
      bankOwnership({ holderName: 'DEEPTRICS SOFTWARE SOLUTIONS PRIVATE LIMITED', ...company }),
    ).toBe('MATCH');
    expect(
      bankOwnership({ holderName: 'DeepTrics Software Solutions Pvt. Ltd.', ...company }),
    ).toBe('MATCH');
  });

  it('a sole proprietor or an individual is paid in their own name: not checked', () => {
    expect(
      bankOwnership({
        holderName: 'Asha Rao',
        legalName: 'Asha Events',
        legalEntityType: 'Sole proprietorship',
      }),
    ).toBe('NOT_CHECKED');
    expect(
      bankOwnership({
        holderName: 'Asha Rao',
        legalName: 'Asha Rao',
        legalEntityType: 'Individual',
      }),
    ).toBe('NOT_CHECKED');
  });

  it('missing facts are not checked rather than guessed', () => {
    expect(bankOwnership({ holderName: 'X', legalName: null, legalEntityType: 'LLC' })).toBe(
      'NOT_CHECKED',
    );
    expect(bankOwnership({ holderName: null, ...company })).toBe('NOT_CHECKED');
  });

  it('works for a US LLC too', () => {
    expect(
      bankOwnership({
        holderName: 'Srinivasa Rao M',
        legalName: 'DeepTrics LLC',
        legalEntityType: 'LLC',
      }),
    ).toBe('MISMATCH');
    expect(
      bankOwnership({
        holderName: 'DEEPTRICS LLC',
        legalName: 'DeepTrics LLC',
        legalEntityType: 'LLC',
      }),
    ).toBe('MATCH');
  });
});

describe('manualPayoutLine (Razorpay Route off)', () => {
  it('a verified account in the business name: manual settlements are active', () => {
    const l = manualPayoutLine('VERIFIED', 'MATCH');
    expect(l.payoutsTone).toBe('good');
    expect(l.payouts).toMatch(/active/);
    expect(l.automatic).toMatch(/not enabled/);
  });

  it('a verified PERSONAL account on a company is never shown as ready', () => {
    const l = manualPayoutLine('VERIFIED', 'MISMATCH');
    expect(l.payoutsTone).toBe('bad');
    expect(l.bank).toMatch(/Ownership mismatch/);
    expect(l.organizerActionRequired).toBe(true);
  });

  it('an account being checked waits, with nothing asked of the organizer', () => {
    const l = manualPayoutLine('UNDER_REVIEW', 'NOT_CHECKED');
    expect(l.payoutsTone).toBe('waiting');
    expect(l.bank).toMatch(/Needs verification/);
    expect(l.organizerActionRequired).toBe(false);
  });

  it('no account or a rejected one asks the organizer to act', () => {
    expect(manualPayoutLine('NONE', 'NOT_CHECKED').organizerActionRequired).toBe(true);
    expect(manualPayoutLine('REJECTED', 'NOT_CHECKED').payoutsTone).toBe('bad');
  });

  it('never says payouts are inactive just because Route is off', () => {
    for (const bank of ['NONE', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'] as const) {
      for (const own of ['MATCH', 'MISMATCH', 'NOT_CHECKED'] as const) {
        expect(manualPayoutLine(bank, own).payouts).not.toMatch(/not active|not making payouts/i);
      }
    }
  });

  it('copy is ASCII only', () => {
    for (const bank of ['NONE', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'] as const) {
      const l = manualPayoutLine(bank, 'MISMATCH');
      expect(`${l.payouts}${l.bank}${l.automatic}`).toMatch(/^[\x20-\x7E]*$/);
    }
  });
});

describe('isManualRupeePayout', () => {
  it('is the Razorpay entry with the platform switch off, nothing else', () => {
    expect(isManualRupeePayout({ provider: 'RAZORPAY', stage: 'PLATFORM_PAYOUTS_OFF' })).toBe(true);
    expect(isManualRupeePayout({ provider: 'RAZORPAY', stage: 'ACTIVE' })).toBe(false);
    expect(isManualRupeePayout({ provider: 'STRIPE', stage: 'ACTIVE' })).toBe(false);
  });
});

describe('settlementStatusWords', () => {
  it('names the manual process stages', () => {
    expect(settlementStatusWords('PENDING')).toBe('Pending approval');
    expect(settlementStatusWords('PAID')).toBe('Paid');
    expect(settlementStatusWords('FAILED')).toBe('Failed');
  });
});
