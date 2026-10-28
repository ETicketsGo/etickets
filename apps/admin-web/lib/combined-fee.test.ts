import { describe, expect, it } from 'vitest';
import { combinedExample, describeCharge } from './fee-bands';
import {
  BLANK_DRAFT,
  KIND_LABEL,
  draftToTerms,
  termsLabel,
  type FeePolicyDraft,
} from './fee-policies';

/** COMBINED (percentage + fixed per ticket) in the band editor and the fee policy form. */

describe('band editor', () => {
  it('describes a combined band', () => {
    expect(describeCharge({ feeType: 'COMBINED', feeMinor: 500, feePercentBps: 300 }, 'INR')).toBe(
      '3% of the order + ₹5 per ticket',
    );
    expect(describeCharge({ feeType: 'COMBINED', feeMinor: 50, feePercentBps: 250 }, 'USD')).toBe(
      '2.5% of the order + $0.50 per ticket',
    );
  });

  it('keeps the other types as they were', () => {
    expect(describeCharge({ feeType: 'FLAT', feeMinor: 1_000 }, 'INR')).toBe('₹10');
    expect(
      describeCharge(
        { feeType: 'PERCENT', feeMinor: 0, feePercentBps: 500, maxFeeMinor: 50_000 },
        'INR',
      ),
    ).toBe('5% of the order (max ₹500)');
  });

  it("previews the owner's example on a band that starts at zero", () => {
    expect(
      combinedExample(
        { percentBps: 300, fixedPerTicketMinor: 500, minMinor: 0, maxMinor: null },
        'INR',
      ),
    ).toBe('One ticket of ₹1,000: ₹30 + ₹5 = ₹35. Three tickets of ₹1,000 each: ₹105.');
  });

  it('uses the lower bound as the sample, and leaves out three tickets that leave the band', () => {
    expect(
      combinedExample(
        { percentBps: 300, fixedPerTicketMinor: 500, minMinor: 50_000, maxMinor: 99_900 },
        'INR',
      ),
    ).toBe('One ticket of ₹500: ₹15 + ₹5 = ₹20.');
  });

  it('shows nothing until a percentage is entered', () => {
    expect(
      combinedExample(
        { percentBps: null, fixedPerTicketMinor: 500, minMinor: 0, maxMinor: null },
        'INR',
      ),
    ).toBeNull();
  });
});

describe('fee policy form', () => {
  const draft = (patch: Partial<FeePolicyDraft>): FeePolicyDraft => ({
    ...BLANK_DRAFT,
    targetId: 'evt_1',
    reason: 'Combined fee agreed with the organizer',
    ...patch,
  });

  it('offers the kind', () => {
    expect(KIND_LABEL.COMBINED).toBe('Percentage plus a fixed fee per ticket');
  });

  it('sends a percentage and a per-ticket amount in minor units', () => {
    const { terms, errors } = draftToTerms(
      draft({ kind: 'COMBINED', percent: '3', fixedAmount: '5', currency: 'INR' }),
    );
    expect(errors).toEqual({});
    expect(terms).toMatchObject({
      kind: 'COMBINED',
      percentBps: 300,
      feeMinor: 500,
      currency: 'INR',
    });
  });

  it('needs both parts and a currency', () => {
    expect(
      draftToTerms(draft({ kind: 'COMBINED', fixedAmount: '5', currency: 'INR' })).errors,
    ).toHaveProperty('percent');
    expect(
      draftToTerms(draft({ kind: 'COMBINED', percent: '3', currency: 'INR' })).errors,
    ).toHaveProperty('fixedAmount');
    expect(
      draftToTerms(draft({ kind: 'COMBINED', percent: '3', fixedAmount: '5' })).errors,
    ).toHaveProperty('currency');
  });

  it('labels a combined policy', () => {
    expect(
      termsLabel({
        kind: 'COMBINED',
        percentBps: 300,
        feeMinor: 500,
        minFeeMinor: null,
        maxFeeMinor: null,
        currency: 'INR',
      }),
    ).toMatch(/^3% \+ 5\.00 INR per ticket$|^3% \+ .*5.*per ticket$/);
  });
});
