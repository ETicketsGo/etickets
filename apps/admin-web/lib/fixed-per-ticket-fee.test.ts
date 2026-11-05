import { describe, expect, it } from 'vitest';
import { combinedExample, describeCharge, limitFee } from './fee-bands';
import {
  BLANK_DRAFT,
  KIND_LABEL,
  currencyRequired,
  draftToTerms,
  termsLabel,
  type FeePolicyDraft,
} from './fee-policies';

/**
 * Owner decisions 2026-10-29 in the admin console: a FIXED_PER_TICKET fee type, and an optional
 * minimum and maximum for COMBINED and FIXED_PER_TICKET, in the band editor and the fee policy
 * form, with a preview that does the API's arithmetic.
 */

describe('band editor', () => {
  it('describes a per-ticket band, and keeps FLAT as once per order', () => {
    expect(describeCharge({ feeType: 'FIXED_PER_TICKET', feeMinor: 500 }, 'INR')).toBe(
      '₹5 per ticket',
    );
    expect(describeCharge({ feeType: 'FIXED_PER_TICKET', feeMinor: 150 }, 'USD')).toBe(
      '$1.50 per ticket',
    );
    expect(describeCharge({ feeType: 'FLAT', feeMinor: 500 }, 'INR')).toBe('₹5');
  });

  it('shows the optional limits on per-ticket and combined bands', () => {
    expect(
      describeCharge(
        { feeType: 'FIXED_PER_TICKET', feeMinor: 500, minFeeMinor: 2_000, maxFeeMinor: null },
        'INR',
      ),
    ).toBe('₹5 per ticket (min ₹20)');
    expect(
      describeCharge(
        { feeType: 'COMBINED', feeMinor: 500, feePercentBps: 300, maxFeeMinor: 50_000 },
        'INR',
      ),
    ).toBe('3% of the order + ₹5 per ticket (max ₹500)');
  });

  it('previews a per-ticket band: one ticket and three', () => {
    expect(
      combinedExample(
        {
          type: 'FIXED_PER_TICKET',
          percentBps: null,
          fixedPerTicketMinor: 500,
          minMinor: 0,
          maxMinor: null,
        },
        'INR',
      ),
    ).toBe('One ticket of ₹1,000: ₹5. Three tickets of ₹1,000 each: ₹15.');
  });

  it('previews a minimum and a maximum where they change the fee', () => {
    expect(
      combinedExample(
        {
          type: 'FIXED_PER_TICKET',
          percentBps: null,
          fixedPerTicketMinor: 500,
          minMinor: 0,
          maxMinor: null,
          minFeeMinor: 1_000,
          maxFeeMinor: 1_200,
        },
        'INR',
      ),
    ).toBe(
      'One ticket of ₹1,000: ₹5, raised to the minimum fee of ₹10. Three tickets of ₹1,000 each: ₹15, held at the maximum fee of ₹12.',
    );
    expect(
      combinedExample(
        {
          percentBps: 300,
          fixedPerTicketMinor: 500,
          minMinor: 0,
          maxMinor: null,
          maxFeeMinor: 5_000,
        },
        'INR',
      ),
    ).toBe(
      'One ticket of ₹1,000: ₹30 + ₹5 = ₹35. Three tickets of ₹1,000 each: ₹105, held at the maximum fee of ₹50.',
    );
  });

  it('limitFee applies the minimum first, then the maximum, as the API does', () => {
    expect(limitFee(800, 2_000, null)).toEqual({ fee: 2_000, limit: 'MIN' });
    expect(limitFee(9_000, null, 5_000)).toEqual({ fee: 5_000, limit: 'MAX' });
    expect(limitFee(3_500, 2_000, 5_000)).toEqual({ fee: 3_500, limit: null });
    expect(limitFee(3_500, undefined, undefined)).toEqual({ fee: 3_500, limit: null });
  });
});

describe('fee policy form', () => {
  const draft = (patch: Partial<FeePolicyDraft>): FeePolicyDraft => ({
    ...BLANK_DRAFT,
    targetId: 'evt_1',
    reason: 'Per-ticket fee agreed with the organizer',
    ...patch,
  });

  it('offers the kind and labels it', () => {
    expect(KIND_LABEL.FIXED_PER_TICKET).toBe('Fixed fee per ticket');
    expect(
      termsLabel({
        kind: 'FIXED_PER_TICKET',
        feeMinor: 500,
        percentBps: null,
        minFeeMinor: null,
        maxFeeMinor: 5_000,
        currency: 'INR',
      }),
    ).toMatch(/5.*per ticket \(max 50\.00 INR\)$/);
  });

  it('sends a per-ticket amount in minor units, with no limits by default', () => {
    const { terms, errors } = draftToTerms(
      draft({ kind: 'FIXED_PER_TICKET', fixedAmount: '5', currency: 'INR' }),
    );
    expect(errors).toEqual({});
    expect(terms).toMatchObject({ kind: 'FIXED_PER_TICKET', feeMinor: 500, currency: 'INR' });
    expect(terms).not.toHaveProperty('minFeeMinor');
    expect(terms).not.toHaveProperty('maxFeeMinor');
    expect(terms).not.toHaveProperty('percentBps');
  });

  it('needs an amount and a currency', () => {
    expect(
      draftToTerms(draft({ kind: 'FIXED_PER_TICKET', currency: 'INR' })).errors,
    ).toHaveProperty('fixedAmount');
    expect(currencyRequired({ kind: 'FIXED_PER_TICKET', minAmount: '', maxAmount: '' })).toBe(true);
  });

  it('sends the optional lowest and highest fee for combined and per-ticket kinds', () => {
    expect(
      draftToTerms(
        draft({
          kind: 'COMBINED',
          percent: '3',
          fixedAmount: '5',
          minAmount: '20',
          maxAmount: '500',
          currency: 'INR',
        }),
      ).terms,
    ).toMatchObject({ minFeeMinor: 2_000, maxFeeMinor: 50_000 });
    expect(
      draftToTerms(
        draft({ kind: 'FIXED_PER_TICKET', fixedAmount: '5', maxAmount: '12', currency: 'INR' }),
      ).terms,
    ).toMatchObject({ maxFeeMinor: 1_200 });
  });

  it('refuses a highest fee below the lowest', () => {
    expect(
      draftToTerms(
        draft({
          kind: 'FIXED_PER_TICKET',
          fixedAmount: '5',
          minAmount: '20',
          maxAmount: '10',
          currency: 'INR',
        }),
      ).errors,
    ).toHaveProperty('maxAmount');
  });

  it('ignores limits typed for another kind (a fixed fee per order takes none)', () => {
    const { terms } = draftToTerms(
      draft({ kind: 'FIXED', fixedAmount: '10', minAmount: '20', currency: 'INR' }),
    );
    expect(terms).not.toHaveProperty('minFeeMinor');
  });
});
